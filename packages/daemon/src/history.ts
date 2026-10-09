// Read-only history pipe.
//
// Per spec/04: Claude Code persists session JSONL under
// `~/.claude/projects/<encoded-folder>/<sessionId>.jsonl`. We don't duplicate.
// The encoding Claude Code uses is "replace `/` and `.` with `-`" on the
// absolute folder path (verified against installed Claude Code; the encoder
// is a stable, documented part of the on-disk layout). If a future Claude
// Code release changes the encoding we'll surface it loudly via missing-file
// errors here, NO FALLBACKS.
//
// We translate JSONL entries into the same `@patch/wire` envelopes the live
// stream emits.
//
// SEQ IS CANONICAL, NOT LINE-DERIVED. There is exactly ONE per-chat sequence:
// the number the host stamped when it first emitted the event live. This
// module never invents its own numbering — it asks the caller-supplied
// `CanonicalSeqIndex` (implemented by `chatRunner`, backed by the per-chat
// `~/.patch/chats/<chatId>/seqindex.jsonl` sidecar) what seq each transcript
// event was emitted under, and stamps that. The transcript's line order is used
// only to ORDER events and to key the lookup, never to number them.
//
// This is what makes the two cursors in spec/12 § "Replay vs history cursors"
// mean anything: a surface passes `fromSeq = <highest seq it saw live>` and
// gets strictly the events it has not seen. A line-index-derived seq drifts
// from the live one (a persisted user turn takes a line; a control-path error
// or artifact takes a seq with no line), which made `chat.replay` re-deliver
// messages the surface had already rendered.
//
// An event with no index entry — a transcript written before this chat had a
// sidecar, or a turn produced outside patch (`claude --resume` in a terminal) —
// was never assigned a canonical seq. The index assigns one THEN, once, and
// records it, so from that read onward the number is stable. NO FALLBACK to a
// line-derived number: every event returned here carries a real canonical seq.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SystemContextItem, WireEvent } from '@patch/wire';
import {
  compactionFromTranscriptMetadata,
  compactionSummaryLine,
  TRANSCRIPT_METADATA_KEY,
} from './compaction.js';
import { isModelOutput } from './sdkBackend.js';

export interface HistoryReaderOptions {
  /** Override ~/.claude/projects — used by tests. */
  claudeProjectsRoot?: string;
  /**
   * Called for every transcript line that is not valid JSON. Wired to the
   * host logger so a damaged transcript is reported the moment it is read
   * (see `walk()` — the line is skipped, never silently).
   */
  onCorruptLine?: (info: { path: string; lineNumber: number; message: string }) => void;
}

/**
 * Resolves a transcript's ordered event identities to the canonical per-chat
 * `seq` the host stamped when it emitted each of them live. Implemented by
 * `chatRunner` over the per-chat `seqindex.jsonl` sidecar; supplied per call
 * because the index is per chat while the reader is per host.
 */
export interface CanonicalSeqIndex {
  /**
   * One canonical seq per key, in the same order. A key with no recorded seq
   * (a transcript entry the host never emitted) is ASSIGNED one and recorded,
   * so the answer is stable for every later read.
   */
  resolve(keys: string[]): number[];
}

export interface ReadHistoryOptions {
  chatId: string;
  folder: string;
  sessionId: string;
  fromSeq: number;
  seqIndex: CanonicalSeqIndex;
}

export interface ForkPointOptions {
  folder: string;
  sessionId: string;
  /** Canonical seq of the turn being forked from / hung off. */
  seq: number;
  seqIndex: CanonicalSeqIndex;
  /**
   * The chat's session mirror (`~/.patch/chats/<id>/native/claude`). Patch
   * drives Claude's session store, so a session's later turns can live ONLY
   * here while Claude Code's own transcript stops growing; the fork point is
   * resolved against the same file the resumed session is loaded from
   * (mirror first, as `claudeSessionStore.load` does).
   */
  nativeDir?: string;
}

export interface ForkPoint {
  /**
   * The Claude Code `uuid` of the last transcript entry BEFORE the forked turn
   * — i.e. the end of the prefix the new track shares with its parent. `null`
   * means the forked turn is the very first entry, so the new track starts from
   * an empty context.
   */
  resumeAtUuid: string | null;
}

export interface HistoryReader {
  read(opts: ReadHistoryOptions): WireEvent[];
  /**
   * Resolve the fork point for `seq` (spec/04 § Branching). Returns `null` when
   * `seq` is not a USER `chat.message` in this transcript — there is nothing to
   * fork from, and the caller must fail loudly rather than fork from the end
   * (NO FALLBACK).
   */
  forkPoint(opts: ForkPointOptions): ForkPoint | null;
  /**
   * Resolve the SIDE point for `seq` (spec/04 § Side threads): the uuid of the
   * entry that produced `seq` ITSELF, so the side track shares the prefix up to
   * and including that message. Any role qualifies — a side question about an
   * assistant answer is the common case. Returns `null` when `seq` is not in
   * this transcript (or its entry carries no uuid to resume at), so the caller
   * fails loudly instead of hanging the side thread off the end (NO FALLBACK).
   */
  sidePoint(opts: ForkPointOptions): ForkPoint | null;
  /**
   * True when Claude Code has persisted a JSONL transcript for this session.
   * A freshly-started session emits its `session_id` in the first `result`
   * message before (or, in tests, without) the JSONL landing on disk — for
   * those, there is simply no persisted history to page through yet. Callers
   * use this to return an empty slice instead of treating a not-yet-written
   * transcript as an error. NOT a fallback: a genuinely corrupt/partial JSONL
   * still surfaces loudly — `read()` logs each damaged line and replays a
   * system message in its place (see `walk()`).
   */
  hasSession(opts: { folder: string; sessionId: string }): boolean;
}

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Encode an absolute folder path into Claude Code's projects-dir name. */
export function encodeFolder(folder: string): string {
  // Replace path separators and dots with '-'; collapse leading/trailing '-'.
  return folder.replace(/[/.]/g, '-').replace(/^-+|-+$/g, '-');
}

/**
 * Every Claude Code session id (JSONL basename, no extension) persisted for
 * `folder`, in no particular order. Used by the history importer (spec/04 §
 * History) to find sessions a chat's own meta never recorded — a special
 * thread's rotating sessions, or an orphan a crash lost the `result` envelope
 * for. An absent/unreadable directory yields no sessions rather than an error:
 * a chat whose folder predates any Claude Code run has genuinely persisted
 * nothing yet.
 */
export function listSessionIds(root: string, folder: string): string[] {
  const dir = join(root, encodeFolder(folder));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
}

export function createHistoryReader(opts: HistoryReaderOptions = {}): HistoryReader {
  const root = opts.claudeProjectsRoot ?? defaultClaudeProjectsRoot();

  function jsonlPath(folder: string, sessionId: string): string {
    return join(root, encodeFolder(folder), `${sessionId}.jsonl`);
  }

  /**
   * Walk the transcript in order, pairing each wire event with the `uuid` of
   * the JSONL entry that produced it. One JSONL line can expand to MORE than
   * one wire event — a single assistant message may carry a `text` block AND
   * one or more `tool_use` blocks, each a distinct chat-scoped event — so the
   * ordinal handed to `jsonlLineToWire` advances per EVENT, not per line. The
   * ordinal is a position, not a seq: canonical seqs are stamped by `stamp()`.
   */
  function walk(path: string, chatId: string): { event: WireEvent; uuid: string | null }[] {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const out: { event: WireEvent; uuid: string | null }[] = [];
    let ordinal = 0;
    // A tool_use's name lives on the assistant line that made the call; its
    // matching tool_result (a later, separate line) carries only the call id.
    // Threaded across every line in this transcript so a result can be named
    // after the call it belongs to — see jsonlLineToWire's `toolNames` param.
    const toolNames = new Map<string, string>();
    let lineNumber = 0;
    for (const line of lines) {
      lineNumber += 1;
      // The transcript is written by Claude Code, NOT by patch. A crashed or
      // interleaved write leaves one damaged record in the middle of an
      // otherwise intact file (seen in the wild: a tool_result truncated
      // mid-string with the next record appended without a newline). Failing
      // the whole read on it bricked the chat permanently — every `chat.replay`
      // returned `sdk_error` and the surface could never open it again.
      //
      // So the damaged LINE is skipped and reported — loudly, never silently:
      // the host logs it via `onCorruptLine`, and replay carries a system
      // message in its place so the gap is visible exactly where it happened.
      // Every other line still parses strictly; nothing else is fallen back on.
      let events: WireEvent[];
      let uuid: string | null;
      try {
        uuid = lineUuid(line);
        events = jsonlLineToWire(line, chatId, ordinal, toolNames);
      } catch (err) {
        const message = (err as Error).message;
        opts.onCorruptLine?.({ path, lineNumber, message });
        out.push({
          event: {
            type: 'chat.message',
            chatId,
            role: 'system',
            content: `Unreadable transcript line ${lineNumber} skipped: ${message}`,
            error: true,
            seq: ordinal,
          },
          uuid: null,
        });
        ordinal += 1;
        continue;
      }
      for (const event of events) {
        out.push({ event, uuid });
        ordinal += 1;
      }
    }
    return out;
  }

  /** Replace each event's positional ordinal with its canonical per-chat seq. */
  function stamp(events: WireEvent[], seqIndex: CanonicalSeqIndex): WireEvent[] {
    const keys = events.map((ev) => {
      const key = eventIdentity(ev);
      // Unreachable via jsonlLineToWire, which only ever emits chat.message /
      // chat.tool_call / chat.tool_result / chat.provider_context — all of
      // which have an identity. NO FALLBACK: an unkeyable transcript event
      // could not be given a stable canonical seq, so it fails loudly rather
      // than replaying at a made-up one.
      if (key === null) throw new Error(`history: transcript event ${ev.type} has no identity`);
      return key;
    });
    const seqs = seqIndex.resolve(keys);
    if (seqs.length !== events.length) {
      throw new Error(
        `history: seq index returned ${seqs.length} seqs for ${events.length} events`,
      );
    }
    return events.map((ev, i) => ({ ...ev, seq: seqs[i] }) as WireEvent);
  }

  function read(req: ReadHistoryOptions): WireEvent[] {
    const path = jsonlPath(req.folder, req.sessionId);
    if (!existsSync(path)) {
      throw new Error(
        `history: JSONL not found at ${path} for chat ${req.chatId}; expected Claude Code to have persisted it.`,
      );
    }
    const events = stamp(
      walk(path, req.chatId).map((e) => e.event),
      req.seqIndex,
    );
    return events.filter((ev) => (ev as { seq: number }).seq > req.fromSeq);
  }

  function hasSession(opts: { folder: string; sessionId: string }): boolean {
    return existsSync(jsonlPath(opts.folder, opts.sessionId));
  }

  /** The transcript a session resumes from: its mirror when non-empty, else Claude Code's own file. */
  function forkTranscriptPath(opts: ForkPointOptions): string | null {
    if (opts.nativeDir !== undefined) {
      const mirrored = join(opts.nativeDir, `${opts.sessionId}.jsonl`);
      if (existsSync(mirrored) && statSync(mirrored).size > 0) return mirrored;
    }
    const path = jsonlPath(opts.folder, opts.sessionId);
    return existsSync(path) ? path : null;
  }

  /**
   * Walk the transcript stamping the SAME canonical seqs `read()` does, and
   * return the uuid of the entry immediately preceding the one that produced
   * `seq` — the end of the prefix a fork shares with its parent (spec/04 §
   * Branching).
   */
  function forkPoint(opts: ForkPointOptions): ForkPoint | null {
    const path = forkTranscriptPath(opts);
    if (path === null) return null;
    const entries = walk(path, 'fork-probe');
    const stamped = stamp(
      entries.map((e) => e.event),
      opts.seqIndex,
    );
    const idx = stamped.findIndex((ev) => (ev as { seq: number }).seq === opts.seq);
    if (idx < 0) return null;
    const target = stamped[idx] as WireEvent;
    if (!(target.type === 'chat.message' && target.role === 'user')) return null;
    // uuid of the last PRECEDING line that produced at least one event.
    const ownUuid = entries[idx]?.uuid ?? null;
    let previousUuid: string | null = null;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const u = entries[i]?.uuid ?? null;
      if (u !== null && u !== ownUuid) {
        previousUuid = u;
        break;
      }
    }
    return { resumeAtUuid: previousUuid };
  }

  /**
   * Walk the transcript stamping the SAME canonical seqs `read()` does, and
   * return the uuid of the entry that produced `seq` itself — the end of the
   * prefix a side thread shares with the track it hangs off (spec/04 § Side
   * threads).
   */
  function sidePoint(opts: ForkPointOptions): ForkPoint | null {
    const path = forkTranscriptPath(opts);
    if (path === null) return null;
    const entries = walk(path, 'side-probe');
    const stamped = stamp(
      entries.map((e) => e.event),
      opts.seqIndex,
    );
    const idx = stamped.findIndex((ev) => (ev as { seq: number }).seq === opts.seq);
    if (idx < 0) return null;
    const uuid = entries[idx]?.uuid ?? null;
    return uuid === null ? null : { resumeAtUuid: uuid };
  }

  return { read, hasSession, forkPoint, sidePoint };
}

/**
 * Payload identity of a persisted event — the key that says "this is the same
 * event" across the live stream and Claude Code's transcript. It is what the
 * canonical seq index is keyed on (hashed, so the sidecar stores no transcript
 * text), and what `replayChat` merges the in-memory ring against. `null` for
 * events that only ever exist live and are never in the transcript (errors,
 * artifacts, permission requests), so they are always kept and never indexed.
 */
export function eventIdentity(ev: WireEvent): string | null {
  switch (ev.type) {
    case 'chat.message':
      return `message ${ev.role} ${ev.content}`;
    // A tool-call id is minted by the model and unique per call, so it is a
    // stronger identity than the args — and the JSONL tool_result block carries
    // no tool name (we substitute a placeholder below), so callId is the ONLY
    // usable key there.
    case 'chat.tool_call':
      return `tool_call ${ev.callId}`;
    case 'chat.tool_result':
      return `tool_result ${ev.callId}`;
    // Claude Code's own provider-level context (`jsonlLineToWire`'s
    // `type === 'attachment'` branch) — no id of its own, so keyed on its
    // translated payload the same way a chat.message is.
    case 'chat.provider_context':
      return `provider_context ${ev.providerType} ${ev.text}`;
    default:
      return null;
  }
}

/**
 * A slash-command / skill invocation, as Claude Code will have rewritten it by
 * the time this module reads it back. The host's outgoing prompt is the plain
 * text a user typed (`/plant nettle`) or the text the server rendered for a job
 * (`/ha-update\n\n<body>` — packages/server/src/jobs/dispatcher.ts
 * renderPrompt). Claude Code does NOT persist that: it writes a
 * <command-message>/<command-name>/<command-args> wrapper whose args are
 * everything after the command name, TRIMMED. The separator that followed the
 * name and any surrounding whitespace are gone from disk, so `read()` — which
 * unwraps via `sanitizeCommandText` — can only ever hand back the normalised
 * `/name args` form. `null` when the prompt is not a command invocation at all.
 *
 * The name must be a command NAME, not a bare leading slash: an absolute path
 * (`/srv/patch/CONTEXT.md`) is not an invocation, Claude Code persists it
 * verbatim, and normalising it would break the identity it already has.
 */
function normaliseCommandInvocation(text: string): string | null {
  const match = /^\/([A-Za-z0-9][\w:-]*)(?=\s|$)/.exec(text);
  if (match === null) return null;
  const name = match[1] as string;
  const args = text.slice(match[0].length).trim();
  return args.length > 0 ? `/${name} ${args}` : `/${name}`;
}

/**
 * The content a user turn will carry once Claude Code has persisted it and this
 * module has read it back — i.e. the host's outgoing prompt with the internal
 * wrappers `read()` strips and a slash-command invocation reduced to the same
 * normalised form `read()` will reconstruct from Claude Code's <command-*>
 * wrapper. The live user `chat.message` is emitted with this exact text so the
 * live event and its persisted twin share one identity (and therefore one
 * canonical seq). `null` mirrors `read()` dropping the turn.
 *
 * The command normalisation is not cosmetic. Without it every skill-backed job
 * chat mis-numbers its own first turn: the server sends `/<skill>\n\n<body>`,
 * the transcript yields `/<skill> <body>`, the two hash to different payload
 * identities, and `chatRunner`'s canonical-seq sidecar therefore has no entry
 * for the transcript's FIRST event. `canonicalSeqIndex.resolve()` reads that as
 * a turn this host never emitted and allocates it a fresh seq off the TAIL,
 * which is then recorded permanently. Surfaces order the transcript by seq, so
 * the job's own prompt re-renders below the final answer — Todoist: "Chat
 * transcript re-renders the triggering job prompt below the final answer (looks
 * like the job ran twice)". The same mismatch defeats `replayChat`'s
 * identity-based ring/transcript merge, so while the chat is still in the ring
 * the turn genuinely replays twice.
 */
export function persistedUserContent(prompt: string): string | null {
  const cleaned = sanitizeCommandText(prompt);
  if (cleaned === null) return null;
  // Not a command invocation => Claude Code persists the text verbatim, so the
  // verbatim text IS the persisted form. Nothing is being guessed at here.
  const command = normaliseCommandInvocation(cleaned);
  return command === null ? cleaned : command;
}

/**
 * Which of Patch's own leading-reminder injection sites produced a given
 * `<system-reminder>` block's inner text (spec/02 § System-reminder
 * disclosure) — for the disclosure's label. Matched on a stable substring of
 * each site's own wording (`chatRunner.ts` / `todos.ts` / `specialThreads.ts`)
 * rather than the whole string, so a wording tweak that keeps the substring
 * keeps the label. The pending-decision variant of the restart reminder is
 * checked before the plain one because both share the phrase "cut off
 * partway"; the fire/edit variants of the todo reminder both share "task
 * list". An unrecognised block (every leading `<system-reminder>` today is
 * one of Patch's own six builders, the newest being an `agent_response`
 * hook's deferred `advise` — spec/20-hooks.md § On the agent's response)
 * still surfaces under a generic label rather than being silently dropped.
 */
function labelSystemReminder(text: string): string {
  if (text.includes('and was waiting for an answer')) {
    return 'Turn interrupted by restart (pending decision)';
  }
  if (text.includes('cut off partway')) return 'Turn interrupted by restart';
  if (text.includes("this chat's task list")) {
    return text.includes('fired from') ? 'Todo item fired' : 'Todo list updated';
  }
  if (text.includes('goal has been set on this chat')) return 'Goal set';
  if (text.includes("chat's goal has been cleared")) return 'Goal cleared';
  if (text.includes('Recent broadcasts delivered on this thread')) return 'Broadcast digest';
  if (text.includes('left a comment on')) return 'New comment';
  if (text.includes('since you last saw it')) return 'Document edited';
  if (text.includes('talked to this chat by voice')) return 'Voice conversation';
  if (text.includes('could not be run on your last reply')) return 'Hook failed';
  if (text.includes('agent_response hook')) return 'Hook advice';
  return 'System context';
}

/**
 * Strip every LEADING `<system-reminder>…</system-reminder>` block off `text`,
 * same regex `sanitizeCommandText` always stripped with, but capturing each
 * block's inner text instead of discarding it. Only leading blocks: a user who
 * writes the literal tag mid-message keeps it (see `sanitizeCommandText`).
 */
function extractLeadingSystemReminders(text: string): {
  cleaned: string;
  items: SystemContextItem[];
} {
  let rest = text;
  const items: SystemContextItem[] = [];
  for (;;) {
    const match = /^<system-reminder>([\s\S]*?)<\/system-reminder>\s*/.exec(rest);
    if (!match) break;
    const inner = (match[1] ?? '').trim();
    if (inner.length > 0) {
      items.push({ source: 'patch', label: labelSystemReminder(inner), text: inner });
    }
    rest = rest.slice(match[0].length);
  }
  return { cleaned: rest, items };
}

/**
 * Every `<system-reminder>` block a raw prompt (or persisted transcript line)
 * actually carried, in the structured form the wire's `systemContext` field
 * expects (spec/02 § System-reminder disclosure) — what `sanitizeCommandText`
 * used to throw away. Callers attach the result to the `chat.message` they are
 * about to emit/replay; an empty array means the turn carried none.
 */
export function extractSystemContext(prompt: string): SystemContextItem[] {
  return sanitizeCommandTextWithContext(prompt).systemContext;
}

/** The Claude Code `uuid` of a JSONL entry, or null when it carries none. */
function lineUuid(line: string): string | null {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const uuid = (parsed as Record<string, unknown>)['uuid'];
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

/**
 * A JSONL entry's own `timestamp` (ISO 8601, written by Claude Code when it
 * persisted the line), as ms epoch — or `undefined` when the line carries
 * none/an unparseable one, so the caller omits `createdAt` rather than
 * inventing a time (spec/14 § Messages — no time beats a wrong time).
 */
function entryTimestamp(obj: Record<string, unknown>): number | undefined {
  const raw = obj['timestamp'];
  if (typeof raw !== 'string') return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Human label for one of Claude Code's own provider-level attachment types
 * (spec/02 § Provider-level context) — the counterpart to `labelSystemReminder`
 * above, but keyed on the SDK's own `attachment.type` rather than matched by
 * wording, since these are structured, not free text. A `providerType` this
 * repo has never seen still gets a legible label (Title Case of the raw type)
 * rather than being dropped — Claude Code adding a new attachment kind some
 * future release must not go silently missing here.
 */
const PROVIDER_CONTEXT_LABELS: Record<string, string> = {
  environment: 'Environment',
  model: 'Model',
  date: 'Date',
  instructions: 'Instructions changed',
  session_context: 'Session context',
  remote_session_change: 'Attribution changed',
  skill_listing: 'Skills available',
  agent_listing_delta: 'Agents available',
  deferred_tools_delta: 'Tools available',
  command_permissions: 'Command permissions',
  prompt_snapshot: 'System prompt snapshot',
  total_tokens_reminder: 'Tokens remaining',
  deferred_tools_record: 'Tool-call bookkeeping',
  // A file the agent had read changed on disk outside it (Tom, an editor, a
  // linter, another chat) — Claude Code tells the agent so on its next turn.
  edited_text_file: 'File changed externally',
  edited_image_file: 'Image changed externally',
};

function providerContextLabel(providerType: string): string {
  const known = PROVIDER_CONTEXT_LABELS[providerType];
  if (known) return known;
  return providerType
    .split('_')
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The human-readable text of a `<system-reminder>`-shaped `rendered` block —
 * the same wrapper `extractLeadingSystemReminders` strips off Patch's own
 * reminders. Claude Code renders most of its native attachments through the
 * identical tag, so the same unwrap applies.
 */
function unwrapRenderedReminder(content: string): string {
  const match = /^<system-reminder>([\s\S]*?)<\/system-reminder>\s*$/.exec(content.trim());
  return (match ? (match[1] ?? '') : content).trim();
}

/**
 * Best-effort human text for an attachment carrying no `rendered` block at
 * all (today: `command_permissions`, `prompt_snapshot`, `deferred_tools_record`
 * — pure internal bookkeeping Claude Code never renders as a reminder to the
 * model itself). Never a raw JSON dump (spec/14 — no decorative noise), but
 * honest about not fully understanding the shape rather than inventing prose.
 */
function fallbackProviderContextText(attachment: Record<string, unknown>): string {
  const entries = Object.entries(attachment).filter(([k]) => k !== 'type');
  if (entries.length === 0) return '(no further detail)';
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
}

/**
 * Claude Code's OWN provider-level context (spec/02 § Provider-level context)
 * — a `type: "attachment"` transcript entry, structurally unrelated to
 * Patch's leading `<system-reminder>` reminders (`extractLeadingSystemReminders`
 * above): each is its own top-level JSONL line, never embedded in a turn's
 * prompt. `null` only when the line calls itself an attachment but carries no
 * usable `attachment.type` — a shape this reader cannot even name, as opposed
 * to one it doesn't specifically recognise (which still gets a generic label,
 * never dropped).
 */
export function translateAttachment(
  obj: Record<string, unknown>,
): { providerType: string; label: string; text: string } | null {
  const attachment = obj['attachment'];
  if (typeof attachment !== 'object' || attachment === null) return null;
  const a = attachment as Record<string, unknown>;
  const providerType = a['type'];
  if (typeof providerType !== 'string' || providerType.length === 0) return null;
  const rendered = obj['rendered'];
  let text: string | null = null;
  if (Array.isArray(rendered)) {
    const joined = rendered
      .map((r) => {
        if (typeof r !== 'object' || r === null) return '';
        const content = (r as Record<string, unknown>)['content'];
        return typeof content === 'string' ? content : '';
      })
      .filter((s) => s.length > 0)
      .join('\n\n');
    if (joined.length > 0) text = unwrapRenderedReminder(joined);
  }
  if ((text === null || text.length === 0) && providerType === 'edited_image_file') {
    // No `rendered` block, and its `content` is the whole image as base64 —
    // the generic key/value dump would put megabytes of it in the disclosure.
    const file = a['displayPath'] ?? a['filename'];
    text =
      typeof file === 'string' && file.length > 0
        ? `${file} changed on disk since the agent last read it.`
        : 'An image changed on disk since the agent last read it.';
  }
  if (text === null || text.length === 0) text = fallbackProviderContextText(a);
  return { providerType, label: providerContextLabel(providerType), text };
}

/**
 * Translate one Claude Code JSONL line into zero or more wire events.
 *
 * A single line may expand to multiple events: real Claude Code packs a
 * message's blocks into one `content` array, so an assistant turn can carry
 * narration text AND one or more `tool_use` blocks, and a follow-up user
 * message carries the `tool_result` blocks. We surface each block as its own
 * wire event (`chat.message` / `chat.tool_call` / `chat.tool_result`) so an
 * attach/resume replay reconstructs the FULL stream — tool-call lines and tool
 * results included — exactly as the live stream emitted them (G1-15). Seqs are
 * assigned by the caller in emission order; `seq` here is the seq of the FIRST
 * event this line produces, and each subsequent event gets `seq + i`.
 *
 * `toolNames` correlates a `tool_result` block back to the tool it belongs
 * to: a JSONL `tool_result` block carries only `tool_use_id`, never the tool's
 * name, so a result's name has to come from the `tool_use` block seen
 * earlier in the transcript. Callers walking a whole transcript in order
 * (`walk()`) pass ONE map threaded across every line so a result line can see
 * a call line from an earlier line; a caller translating a single line in
 * isolation (tests, or a line with no transcript context) gets a fresh map
 * per call, so a result with no matching call in scope falls back to the
 * literal `'tool'` placeholder rather than throwing — the far rarer case of a
 * truly missing call (a corrupt/truncated transcript) still needs *some*
 * non-empty name to render.
 */
export function jsonlLineToWire(
  line: string,
  chatId: string,
  seq: number,
  toolNames: Map<string, string> = new Map(),
): WireEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`history: invalid JSONL line: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const obj = parsed as Record<string, unknown>;
  // Claude Code stamps every transcript line with the moment it actually
  // wrote it (ISO 8601). This is the real creation time a replayed message
  // carries — as opposed to whatever moment a surface happens to be reading
  // this line at, which is "now" on every reopen and is exactly the wrong
  // fact the per-message meta strip refused to show (spec/14 § Messages).
  const createdAt = entryTimestamp(obj);

  const type = obj['type'];
  // spec/02 § Context compression — a compaction boundary is a top-level
  // `system` entry with no message block, so it is read before the
  // assistant/user gate that drops every other system line.
  if (type === 'system' && obj['subtype'] === 'compact_boundary') {
    const compaction = compactionFromTranscriptMetadata(obj[TRANSCRIPT_METADATA_KEY]);
    return [
      {
        type: 'chat.message',
        chatId,
        role: 'system',
        content: compactionSummaryLine(compaction),
        seq,
        compaction,
        ...(createdAt !== undefined ? { createdAt } : {}),
      },
    ];
  }
  // spec/02 § Provider-level context — Claude Code's OWN attachment-shaped
  // entries (environment, model identity, token counts, ...), structurally
  // unrelated to the assistant/user gate below: read before it, not folded
  // into it.
  if (type === 'attachment') {
    const item = translateAttachment(obj);
    if (item === null) return [];
    return [
      {
        type: 'chat.provider_context',
        chatId,
        seq,
        providerType: item.providerType,
        label: item.label,
        text: item.text,
      },
    ];
  }
  if (type !== 'assistant' && type !== 'user') return [];

  // patch/todo.md — "Continue from where you left off. = where did this come
  // from? its causing problems". Nobody types that: the Claude Code CLI injects
  // it as a user turn flagged `isMeta` when it auto-resumes a transcript whose
  // last turn was interrupted (or that has a deferred tool), and persists it to
  // the JSONL like any other turn. Replaying it put a message in the chat the
  // user never sent — and, because it has no counterpart in the host's live
  // ring, no payload-identity merge could ever drop it. `isMeta` is Claude
  // Code's own marker for CLI-injected plumbing (its UI hides these too), so
  // every such entry is dropped from replay. NOT a fallback: an ordinary user
  // turn carrying the same words is unflagged and still replays.
  if (obj['isMeta'] === true) return [];

  // The same plumbing, on the assistant side. Claude Code answers its own
  // injected turns — most often `No response requested.` after a turn died —
  // and stamps those replies `model: "<synthetic>"` with zero input tokens.
  // `isMeta` is not set on them, so that marker is the only one there is. The
  // live stream already drops them (`02-daemon.md` § Per-turn process / warm
  // sessions); replaying them put the agent's name on words it never said,
  // every time a long chat was reopened. `isModelOutput` is the one predicate
  // for this, shared with the live path so the two can't drift, and structural
  // rather than textual: an agent quoting the wording still replays. A
  // compaction notice arrives the same way and is read above, before this gate.
  // `isModelOutput` answers false for anything that is not an assistant entry,
  // so the role is checked here: a user turn is never gated by it.
  if (type === 'assistant' && !isModelOutput(obj)) return [];

  const blocks = contentBlocks(obj);
  // Pre-`tool_use`/`tool_result` transcripts (and string-content messages) have
  // no structured blocks — fall back to the flattened text as a single message.
  if (blocks === null) {
    const content = extractContent(obj);
    if (type === 'user') {
      const { text: cleaned, systemContext } = sanitizeCommandTextWithContext(content);
      // patch/todo.md — "Don't show skill content in history": a command-output
      // turn sanitises to null and is dropped from the replayed transcript.
      if (cleaned === null) return [];
      return [
        {
          type: 'chat.message',
          chatId,
          role: type,
          content: cleaned,
          seq,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(systemContext.length > 0 ? { systemContext } : {}),
        },
      ];
    }
    return [
      {
        type: 'chat.message',
        chatId,
        role: type,
        content,
        seq,
        ...(createdAt !== undefined ? { createdAt } : {}),
      },
    ];
  }

  const out: WireEvent[] = [];
  let nextSeq = seq;
  let textBuf = '';
  const flushText = (): void => {
    if (textBuf.length === 0) return;
    let content = textBuf;
    textBuf = '';
    // patch/todo.md — a slash-command / skill invocation is persisted as a user
    // turn wrapped in <command-*> tags (its expansion + output are "skill
    // content"). Reconstruct the clean `/command args` the user typed, and drop
    // the internal command-output turns, rather than dumping wrapper XML into
    // the transcript. Only user turns carry these wrappers.
    let systemContext: SystemContextItem[] = [];
    if (type === 'user') {
      const sanitized = sanitizeCommandTextWithContext(content);
      if (sanitized.text === null) return;
      content = sanitized.text;
      systemContext = sanitized.systemContext;
    }
    out.push({
      type: 'chat.message',
      chatId,
      role: type,
      content,
      seq: nextSeq++,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(systemContext.length > 0 ? { systemContext } : {}),
    });
  };

  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    const bt = b['type'];
    if (bt === 'text' && typeof b['text'] === 'string') {
      textBuf += b['text'];
    } else if (bt === 'tool_use') {
      flushText();
      const name = typeof b['name'] === 'string' ? b['name'] : '';
      const callId = typeof b['id'] === 'string' ? b['id'] : '';
      if (name.length === 0 || callId.length === 0) continue;
      toolNames.set(callId, name);
      out.push({
        type: 'chat.tool_call',
        chatId,
        tool: name,
        args: b['input'],
        callId,
        seq: nextSeq++,
        ...(createdAt !== undefined ? { startedAt: createdAt } : {}),
      });
    } else if (bt === 'tool_result') {
      flushText();
      const callId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '';
      if (callId.length === 0) continue;
      out.push({
        type: 'chat.tool_result',
        chatId,
        // Named after the matching tool_use seen earlier in this transcript
        // (see the `toolNames` doc above). 'tool' is a last-resort, non-empty
        // placeholder for the rare case no matching call is in scope.
        tool: toolNames.get(callId) ?? 'tool',
        callId,
        result: b['content'],
        ...(b['is_error'] === true ? { isError: true } : {}),
        seq: nextSeq++,
      });
    }
  }
  flushText();
  return out;
}

/**
 * Return the message's structured content blocks, or `null` when the message
 * has no block array (string content, or a pre-blocks transcript shape) so the
 * caller can fall back to flattened text.
 */
function contentBlocks(obj: Record<string, unknown>): unknown[] | null {
  const message = obj['message'];
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>)['content'];
    if (Array.isArray(content)) return content;
  }
  const content = obj['content'];
  if (Array.isArray(content)) return content;
  return null;
}

function extractContent(obj: Record<string, unknown>): string {
  const message = obj['message'];
  if (typeof message === 'string') return message;
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content;
    /* v8 ignore start -- unreachable: extractContent() is only ever called by
     * jsonlLineToWire() when contentBlocks(obj) returned null, and
     * contentBlocks() returns null only when message.content is NOT an array
     * (among other conditions). So by the time we get here, `content` above
     * can never be an array — this branch is defensive symmetry with
     * contentBlocks(), not a reachable path. */
    if (Array.isArray(content)) {
      let text = '';
      for (const block of content) {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
        }
      }
      return text;
    }
    /* v8 ignore stop */
  }
  const content = obj['content'];
  if (typeof content === 'string') return content;
  return '';
}

/**
 * Normalise a persisted user turn so a slash-command / skill invocation replays
 * as the clean text the user typed, never the internal wrapper XML or the
 * command's own output (patch/todo.md — "Don't show skill content in history").
 *
 * Claude Code persists a slash command as a user turn wrapped in
 * `<command-message>` / `<command-name>` / `<command-args>` tags, and any output
 * that command prints as a `<local-command-stdout>` (or `stderr`) turn.
 *
 *  - A command *invocation* → the reconstructed `/<name> <args>` (tags stripped).
 *  - A command *output* turn → `null`, signalling the caller to drop it.
 *  - Anything else (an ordinary message) → returned unchanged.
 */
function sanitizeCommandText(text: string): string | null {
  return sanitizeCommandTextWithContext(text).text;
}

/**
 * `sanitizeCommandText`, plus the leading `<system-reminder>` blocks it used
 * to just delete (spec/02 § System-reminder disclosure — every reader below
 * funnels through this one function, so every reminder Patch injects is
 * captured here exactly once).
 *
 * Strips LEADING broadcast/reminder `<system-reminder>…</system-reminder>`
 * blocks. On a special (Manager) thread the host PREPENDS this block to the
 * user's turn (index.ts preprocessInput → specialThreads
 * buildBroadcastSystemReminder) as agent context, and Claude Code persists the
 * augmented prompt. Replaying it verbatim dumps the internal XML into the
 * transcript AND — because the persisted user echo no longer equals the
 * surface's optimistic (clean) copy — makes the surface's content-match
 * reconcile miss, so it appends the echo as a DUPLICATE user bubble after the
 * reply (patch/todo.md — "Messages going through twice … in wrong place").
 * Stripped from `text` so replay carries only what the user typed and the
 * reconcile matches — but captured into `systemContext` rather than discarded,
 * so a reply reacting to one is legible as reacting to something (spec/02 §
 * System-reminder disclosure) instead of reading as an unprompted aside. Only
 * LEADING injected blocks are removed — a user who writes the literal tag
 * mid-message keeps it. There can be more than one (a turn can carry both the
 * broadcast block and a task-list block), so every leading block goes, not
 * just the first. Any following voice prefix / command wrapper is handled by
 * the logic below (and the surface's voice-prefix strip).
 */
function sanitizeCommandTextWithContext(text: string): {
  text: string | null;
  systemContext: SystemContextItem[];
} {
  const { cleaned, items } = extractLeadingSystemReminders(text);
  const nameMatch = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/.exec(cleaned);
  if (nameMatch) {
    const name = nameMatch[1]?.trim() ?? '';
    // A wrapper with no recoverable command name carries nothing useful — drop.
    if (name.length === 0) return { text: null, systemContext: items };
    const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(cleaned);
    const args = argsMatch ? (argsMatch[1] ?? '').trim() : '';
    return {
      text: args.length > 0 ? `/${name} ${args}` : `/${name}`,
      systemContext: items,
    };
  }
  // Command output (stdout/stderr) with no invocation is purely skill-generated
  // internal content — drop it from the replayed transcript.
  if (/<local-command-std(out|err)>/.test(cleaned)) return { text: null, systemContext: items };
  return { text: cleaned, systemContext: items };
}
