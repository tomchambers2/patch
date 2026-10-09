// Abstraction over the Claude Code SDK so tests can substitute a canned
// event stream without `vi.mock` shenanigans.
//
// The real backend imports `@anthropic-ai/claude-agent-sdk` lazily — that
// package has a multi-MB native binary install, and we want test runs to
// be free of that. SDK_BACKEND=mock (default in test stack) skips the import
// entirely. SDK_BACKEND=real loads it.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { taskNotificationSummary, type MessageCompaction, type RateLimitWindow } from '@patch/wire';
import {
  compactionFromSdkMetadata,
  compactionSummaryLine,
  TRANSCRIPT_METADATA_KEY,
} from './compaction.js';
import { AGENT_SDK_PACKAGE } from './installPaths.js';
import { translateAttachment } from './history.js';
import { resolveClaudeExecutable } from './claudeExecutable.js';
import { isAccountExhaustedError } from './accountFailover.js';
import { createClaudeSessionStore } from './claudeSessionStore.js';
import { readSidecar, type DocMode } from './docSidecar.js';
import type { TrackEntry } from './nativeReconstruct.js';
// Type-only import — erased at runtime, so it does NOT trigger the heavy lazy
// SDK load (the package is still imported dynamically in the real backend).
import type {
  CanUseTool,
  HookCallbackMatcher,
  Options,
  Query,
  SDKUserMessage,
  SessionStoreEntry,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';

export interface SdkEnvelope {
  /** What we care about per spec/02-daemon.md "SDK emits a result message". */
  type:
    | 'assistant'
    | 'assistant_delta'
    | 'user'
    | 'result'
    | 'system'
    | 'tool_use'
    | 'tool_result'
    | 'permission'
    | 'error'
    | 'provider_context';
  /**
   * Raw text content for assistant/user messages, or stringified tool
   * args/results. For `assistant_delta` this is the incremental text chunk to
   * append to the in-flight assistant turn (spec/02 — the SDK runs with
   * `includePartialMessages`, so text streams as `text_delta`s ahead of the
   * turn's final `assistant` message).
   */
  content?: string;
  /** Capture this on result messages → meta.claudeSessionId. */
  sessionId?: string;
  /** Tool-call envelope. */
  tool?: { name: string; args: unknown; callId: string };
  toolResult?: { name: string; callId: string; result: unknown; isError?: boolean };
  /** Permission requests (bypassPermissions usually means we don't see these). */
  permission?: { requestId: string; tool: string; args: unknown; description?: string };
  /**
   * Set on the `system` envelope marking a context compression (spec/02
   * § Context compression). `content` is the one-line record; this carries the
   * figures behind it.
   */
  compaction?: MessageCompaction;
  /**
   * Set on the envelope carrying Claude Code's init message when the mode it
   * resolved differs from the one the turn requested AND the mode it landed
   * on is `plan` (spec/02 § Permission mode's plan-mode exception). Every
   * OTHER substitution target throws `PermissionModeDowngradedError` instead
   * of reaching here — `plan` is the one that is not a dead end, so the run
   * carries on and this just tells the host to record it, the same way a
   * human-chosen mode change is recorded.
   */
  permissionModeAutoDowngrade?: { requested: string; effective: 'plan' };
  errorMessage?: string;
  /**
   * The model's thinking, on its own content-less envelope (spec/04 § History
   * keeps it; no surface renders it).
   */
  thinking?: string;
  /**
   * The harness's own id for the message this envelope came from — Claude
   * Code's message `uuid`, a Codex item id. Recorded with the history record so
   * the two stores can be matched, and so a harness re-sending the same message
   * is recognised.
   */
  nativeId?: string;
  /**
   * Set when this envelope carries an SDK `rate_limit_event` for the
   * account's session (5-hour) or week (7-day) window (spec/10 § Surface in
   * Settings — Usage). Only these two windows are surfaced; `seven_day_opus`,
   * `seven_day_sonnet` and `overage` are per-model/overage detail the SDK also
   * emits under the same event and are not what "session, week" asks for, so
   * they translate to a content-less `system` envelope like any other
   * uninteresting message.
   */
  rateLimit?: { scope: 'session' | 'week'; window: RateLimitWindow };
  /**
   * Set on the `provider_context` envelope — one of Claude Code's OWN
   * `type: "attachment"` stream entries (spec/02 § Provider-level context),
   * translated the same way `history.ts`'s `translateAttachment` does for
   * replay so the live and replayed shapes can't drift.
   */
  providerContext?: { providerType: string; label: string; text: string };
  /**
   * Set on the `system` envelope opening a reseeded Codex thread when the
   * full track didn't fit and the oldest records were dropped to make it fit
   * (spec/04 § History — Codex has no auto-compaction of its own, unlike
   * Claude Code, so patch trims instead of erroring the switch). The count of
   * TRACK ENTRIES (not raw Responses items) cut from the front.
   */
  seedTrim?: number;
  /** Origin marker — useful for tests that want to assert ordering. */
  raw?: unknown;
}

export interface SdkRunOptions {
  prompt: string;
  /** Images sent alongside `prompt` as content blocks. One-shot path only. */
  images?: Array<{ mediaType: string; data: string }> | undefined;
  cwd: string;
  /**
   * Chat this turn belongs to. Used to key a PERSISTENT streaming-input SDK
   * session (one warm Claude Code process kept alive per chat) when
   * `PATCH_PERSISTENT_SESSIONS=1` — eliminating the ~1.8s per-turn process
   * spawn. Optional so existing call sites / the mock stay valid; the one-shot
   * path (default) ignores it.
   */
  chatId?: string | undefined;
  resumeSessionId?: string | undefined;
  /**
   * Run this turn as the first turn of a FORK of `resumeSessionId` (spec/04 §
   * Branching — editing a user turn starts a new track). The resumed session is
   * replayed only up to `resumeAtUuid` (the shared prefix; `null` = fork from an
   * empty context) and the turn lands in a BRAND-NEW session, leaving the parent
   * transcript untouched so the original track stays re-openable.
   */
  fork?: { resumeAtUuid: string | null } | undefined;
  abortController: AbortController;
  /** Caller-provided OAuth access token, baked into env. */
  oauthAccessToken: string;
  /** Resolved credit source for this turn. */
  accountId?: string;
  mcpServer?: { command: string; args: string[]; env: Record<string, string> };
  /** SDK `options.model` override (CLI `--model` pass-through; spec/13). */
  model?: string | undefined;
  /**
   * Per-host system prompt override (Task 3). When non-empty, passed as
   * `options.systemPrompt` to the SDK query, replacing the SDK default.
   */
  systemPrompt?: string | undefined;
  /**
   * The patch-tools guidance (`toolsPrompt.ts`), or the user's edit of it.
   * Appended to whichever prompt is in force rather than replacing it.
   */
  toolsPrompt?: string | undefined;
  /**
   * Per-host skills to enable (Task 3). Passed as `options.skills`.
   * `'all'` enables every discovered skill; an array enables only those named.
   */
  skills?: string[] | 'all' | undefined;
  /**
   * SDK `options.settings` (spec/14 § Agent behavior) — an inline settings
   * object loaded into the highest-priority "flag settings" layer, ahead of
   * whatever the host's own `settings.json` says. Used for the Memory and
   * CLAUDE.md toggles (`autoMemoryEnabled`, `claudeMdExcludes`) so flipping
   * either is a per-query override, never a file write another chat might be
   * reading concurrently.
   */
  settings?: Options['settings'];
  /**
   * SDK `options.settingSources` — which filesystem settings layers to load
   * (user/project/local). Omitted ⇒ the SDK default, so every existing call
   * site is unchanged. `[]` loads none (a bare run). Honoured on both the
   * one-shot and the live/persistent session paths.
   */
  settingSources?: SettingSource[] | undefined;
  /**
   * The host's enabled MCP servers (Settings → MCP; `mcpServers.ts`), wired
   * in AFTER `patch` — by `buildSdkEnv` here, and as `config.mcp_servers` by
   * `codexBackend.ts`. Only alongside `mcpServer`: a caller that configured no
   * tools server gets none of these either. Absent/empty ⇒ `patch` alone.
   */
  extraMcpServers?:
    | Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>
    | undefined;
  /**
   * SDK `options.permissionMode` (spec/13). Defaults to `'auto'`
   * (spec/02-daemon.md) when unset.
   */
  permissionMode?: 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | undefined;
  /**
   * Tools the user has switched OFF for this chat in the surface's Tools panel
   * (patch/todo.md — "allow the user to turn them on and off"). Merged ON TOP of
   * the always-inert `DISALLOWED_NATIVE_TOOLS` so a disabled tool is removed from
   * the model's context for the turn. Omitted/empty ⇒ every tool available.
   */
  disabledTools?: string[] | undefined;
  /**
   * Gates a tool call that needs a permission decision under the turn's
   * `permissionMode` (spec/02 § Permission mode) — wired to the real SDK's own
   * `canUseTool` (`oneShotRun`/`openPersistSession`) and to the mock's blocking
   * dev triggers (e.g. `[[bash-permission]]`). The caller (chatRunner.ts)
   * supplies this for EVERY mode; the underlying SDK decides whether to
   * actually invoke it, based on ITS OWN per-mode rules AND its own safety
   * checks: `auto`'s model classifier resolves an ordinary prompt itself
   * without reaching here, `acceptEdits` calls it for everything except
   * pre-approved file edits, and `bypassPermissions` normally never calls it
   * — but the SDK can still escalate a rare safety-check case (e.g. a write
   * to a "sensitive file") through this same callback even under `auto` or
   * `bypassPermissions`, so it is never safe to omit this based on mode.
   */
  /**
   * Called after each batch of tool calls and before the model's next step
   * (the SDK's `PostToolBatch` hook). Returns text to put in front of the agent
   * at that point, or undefined when there is nothing waiting. This is how a
   * message sent mid-turn reaches the agent at the next tool boundary instead
   * of after the whole turn.
   */
  onToolBoundary?: () => string | undefined | Promise<string | undefined>;
  onPermissionRequest?: (req: {
    tool: string;
    args: Record<string, unknown>;
    description?: string;
  }) => Promise<{
    approve: boolean;
    updatedInput?: Record<string, unknown>;
    /**
     * What to tell the AGENT about a refusal, when "the user denied this" is
     * not what happened. An unanswered `AskUserQuestion` expires
     * (chatRunner.ts § `answerExpiryPlan`), and reporting that as a
     * denial would have the agent act on a decision the user never made.
     * Internal to the host — the wire protocol carries no deny reason.
     */
    denyMessage?: string;
  }>;
  /**
   * Wires the SDK's `sessionStore` option (spec/04 § History — the native
   * resume cache, and a seamless provider switch onto Claude). Absent for the
   * mock and for any caller not yet passing it; the real backend then falls
   * back to the SDK's own local-disk resume, exactly as before this existed.
   */
  claudeSessionStore?: {
    /** `~/.patch/chats/<chatId>/native/claude` — mirrored on every append. */
    nativeDir: string;
    claudeProjectsRoot: string;
    logger: Logger;
    /**
     * Set only when `resumeSessionId` should NOT resume normally — a switch
     * onto Claude, or reseeding a session the mirror and local disk have both
     * lost. `events` is the chat's own track (oldest first), synthesized into
     * a native session via `toClaudeSessionEntries`.
     */
    reseed?: { events: readonly TrackEntry[]; model: string | null };
    /** Each batch of entries newly mirrored — see `ClaudeSessionStoreOptions.onAppend`. */
    onAppend?: (entries: readonly SessionStoreEntry[]) => void;
  };
  /**
   * Set only for a switch onto Codex (or reseeding a Codex chat whose thread
   * is gone): starts a FRESH thread and injects the chat's own track as
   * Responses API items (`thread/inject_items`, codexBackend.ts) before the
   * turn runs, instead of resuming `resumeSessionId` normally.
   */
  codexReseed?: { events: readonly TrackEntry[] };
  /**
   * Set only when resuming a track's OWN prior Codex thread after a return
   * trip through another harness (spec/04 § History — preserve the cached
   * prefix): `resumeSessionId` names that real `codex-…` thread, and this
   * carries just the DELTA — what happened elsewhere since — to inject into
   * it before the turn runs. Unlike `codexReseed`, this does NOT force a
   * fresh thread; it rides the resumed thread's own existing prompt cache.
   */
  codexAppendItems?: { events: readonly TrackEntry[] };
}

export interface SdkBackend {
  /** Spawn a query — returns an async iterable of envelope events. */
  run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope>;
}

/** A controllable backend used by tests. Push events; iterate; close. */
export interface MockSdkBackend extends SdkBackend {
  /** Configure the next run's event stream. Each `run()` consumes one queued script. */
  enqueue(events: SdkEnvelope[]): void;
  lastOptions(): SdkRunOptions | undefined;
}

export interface MockSdkBackendOptions {
  /**
   * Root that mirrors Claude Code's `~/.claude/projects` layout. When set, the
   * mock writes a real JSONL transcript here per turn, so the host's
   * `HistoryReader` (which backs `patch_history` / `chat.replay`) has genuine
   * persisted older events to paginate — the SAME on-disk contract the real
   * SDK provides. WHEN UNSET (the unit-test default) the mock persists nothing
   * and stays a pure in-memory echo, so tests that inject their own reader are
   * untouched. The live host passes its configured root (see index.ts).
   */
  claudeProjectsRoot?: string;
  /**
   * How long (ms) the mock holds the `working` state per turn AFTER emitting
   * its content but BEFORE returning. This is an abortable wait: a `patch_stop`
   * on the chat aborts the controller and the run unwinds immediately. It gives
   * the live stack a genuine running-query window so stop-a-running-query is
   * exercisable (not just stop-an-idle-chat). The real SDK has such a window
   * inherently. Default 0 (unit tests stay fast/synchronous); the live host
   * sets it via `PATCH_MOCK_TURN_DELAY_MS`.
   */
  turnDelayMs?: number;
}

/**
 * How Claude Code persists a user turn that is a slash-command / skill
 * invocation: NOT the text it was handed, but a
 * <command-message>/<command-name>/<command-args> wrapper whose args are
 * everything after the command name, TRIMMED — the separator that followed the
 * name and any surrounding whitespace are discarded. Verified against a real
 * transcript (a prompt of `/ha-update\n\n<body> ` was persisted with args
 * carrying neither the leading newlines nor the trailing space).
 *
 * The mock reproduces that rewrite so the round trip the canonical seq index
 * depends on — live `chat.message` identity == replayed identity — is
 * exercisable off the real SDK. Without it the mock's transcript is
 * byte-identical to the prompt, which is the ONE shape that can never catch a
 * normalisation mismatch (spec/04 § History).
 *
 * A command NAME is required, not a bare leading slash, so an absolute path
 * (`/tmp/x`) stays a plain user turn exactly as real Claude Code leaves it.
 * The mock has no command registry, so any well-formed `/name` invocation is
 * treated as a real command.
 */
export function claudeCodePersistedUserTurn(prompt: string): string {
  const m = /^\/([A-Za-z0-9][\w:-]*)(?=\s|$)/.exec(prompt);
  if (m === null) return prompt;
  const name = m[1] as string;
  const args = prompt.slice(m[0].length).trim();
  const head = `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`;
  return args.length > 0 ? `${head}\n<command-args>${args}</command-args>` : head;
}

/** Append one Claude-Code-shaped JSONL line (role + text) to the transcript. */
function appendTranscriptLine(path: string, role: 'user' | 'assistant', text: string): void {
  appendTranscriptEntry(path, {
    type: role,
    message: { role, content: [{ type: 'text', text }] },
  });
}

/**
 * Append one raw Claude-Code JSONL entry (already in on-disk shape).
 *
 * Every entry carries a `uuid`, exactly as real Claude Code writes — that uuid
 * is the addressable fork point (`resumeSessionAt`) the branching feature
 * resolves a forked turn against (spec/04 § Branching). Without it the mock's
 * transcript would be un-forkable and the fork path un-exercisable off the real
 * SDK.
 */
function appendTranscriptEntry(path: string, entry: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify({ uuid: randomUUID(), ...entry }) + '\n', 'utf8');
}

/**
 * Mock-side session fork: copy the parent transcript's shared prefix (every
 * entry up to and INCLUDING `resumeAtUuid`) into a fresh session file, so the
 * new track starts with the shared history and the parent file is untouched.
 * `resumeAtUuid: null` forks from an empty context. Mirrors what the real SDK's
 * `forkSession` + `resumeSessionAt` does on disk.
 */
function forkTranscript(
  projectsRoot: string,
  cwd: string,
  parentSessionId: string,
  newSessionId: string,
  resumeAtUuid: string | null,
): void {
  const dir = join(projectsRoot, encodeFolderForTranscript(cwd));
  mkdirSync(dir, { recursive: true });
  const parentPath = join(dir, `${parentSessionId}.jsonl`);
  const newPath = join(dir, `${newSessionId}.jsonl`);
  if (resumeAtUuid === null || !existsSync(parentPath)) {
    writeFileSync(newPath, '', 'utf8');
    return;
  }
  const lines = readFileSync(parentPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  const prefix: string[] = [];
  for (const line of lines) {
    prefix.push(line);
    const parsed: unknown = JSON.parse(line);
    const uuid =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['uuid']
        : undefined;
    if (uuid === resumeAtUuid) break;
  }
  writeFileSync(newPath, prefix.length > 0 ? prefix.join('\n') + '\n' : '', 'utf8');
}

/**
 * Persist a single SDK envelope to the on-disk transcript in the SAME shape
 * Claude Code writes — so the host's HistoryReader reconstructs the FULL
 * wire-event stream (tool calls, tool results, permission prompts) on
 * `chat.replay` / `patch_history`, not just plain assistant text. Without this
 * an attach/resume to an already-produced chat would replay messages only and
 * the event pane would render no tool lines (G1-15).
 *
 * Block shapes mirror real Claude Code JSONL:
 *   - assistant text   → assistant message, content `[{type:'text', text}]`
 *   - tool call        → assistant message, content `[{type:'tool_use', id, name, input}]`
 *   - tool result      → user message, content `[{type:'tool_result', tool_use_id, content}]`
 *   - permission       → assistant message, content `[{type:'tool_use', id, name, input}]`
 *                        (Claude Code records the proposed call; the surface
 *                        re-derives the approve/deny affordance on replay).
 */
function appendEnvelopeToTranscript(path: string, ev: SdkEnvelope): void {
  if ((ev.type === 'assistant' || ev.type === 'user') && ev.content) {
    appendTranscriptLine(path, ev.type, ev.content);
    return;
  }
  if (ev.type === 'tool_use' && ev.tool) {
    appendTranscriptEntry(path, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: ev.tool.callId, name: ev.tool.name, input: ev.tool.args },
        ],
      },
    });
    return;
  }
  if (ev.type === 'tool_result' && ev.toolResult) {
    appendTranscriptEntry(path, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: ev.toolResult.callId,
            content: ev.toolResult.result,
            ...(ev.toolResult.isError ? { is_error: true } : {}),
          },
        ],
      },
    });
    return;
  }
  if (ev.type === 'permission' && ev.permission) {
    appendTranscriptEntry(path, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: ev.permission.requestId,
            name: ev.permission.tool,
            input: ev.permission.args,
            ...(ev.permission.description !== undefined
              ? { description: ev.permission.description }
              : {}),
          },
        ],
      },
    });
    return;
  }
  if (ev.type === 'system' && ev.compaction) {
    // Claude Code's own on-disk shape for a boundary (spec/02 § Context
    // compression): a top-level `system` entry, camelCase metadata, no message
    // block. Written exactly so the HistoryReader parses this and a real
    // transcript with the same branch.
    appendTranscriptEntry(path, {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      [TRANSCRIPT_METADATA_KEY]: {
        trigger: ev.compaction.trigger,
        preTokens: ev.compaction.preTokens,
        ...(ev.compaction.postTokens !== undefined ? { postTokens: ev.compaction.postTokens } : {}),
        ...(ev.compaction.durationMs !== undefined ? { durationMs: ev.compaction.durationMs } : {}),
      },
    });
    return;
  }
  // `result` / other `system` envelopes carry no chat-visible content — skip.
}

/** Wait `ms`, resolving early (without throwing) if the abort signal fires. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Split text into small word-ish chunks so the mock streams several
 * `assistant_delta`s per turn (mirroring real token streaming). Whitespace is
 * kept with the preceding word so concatenating the chunks reproduces the
 * input exactly. Always returns at least one chunk for non-empty input.
 */
// This function's ONE call site (below, `chunkForStreaming(reply)`) always
// passes `reply`, the template literal `` `[mock] echo: ${runOpts.prompt}` ``
// — a non-empty, non-whitespace-only string regardless of `runOpts.prompt`
// (even an empty or all-whitespace prompt still leaves the literal
// "[mock] echo: " text). So both branches below are defensive-only and
// unreachable through the real call site; kept general-purpose/self-defending
// rather than exported solely to unit-test these edge cases directly.
function chunkForStreaming(text: string): string[] {
  /* v8 ignore next -- see the file comment above: `text` is never empty here */
  if (text.length === 0) return [];
  const chunks = text.match(/\S+\s*/g);
  /* v8 ignore next -- see the file comment above: `chunks` is never null/empty here */
  return chunks && chunks.length > 0 ? chunks : [text];
}

export function createMockSdkBackend(opts: MockSdkBackendOptions = {}): MockSdkBackend {
  const queue: SdkEnvelope[][] = [];
  let last: SdkRunOptions | undefined;
  // Only persist a transcript when a root is explicitly configured. Unit tests
  // construct the mock with no options => no on-disk writes, pure echo.
  const projectsRoot = opts.claudeProjectsRoot;
  const turnDelayMs =
    opts.turnDelayMs ??
    (process.env['PATCH_MOCK_TURN_DELAY_MS'] !== undefined &&
    process.env['PATCH_MOCK_TURN_DELAY_MS'] !== ''
      ? Number(process.env['PATCH_MOCK_TURN_DELAY_MS'])
      : 0);

  return {
    enqueue(events) {
      queue.push(events);
    },
    lastOptions() {
      return last;
    },
    async *run(runOpts) {
      last = runOpts;
      // Stable session id across a resumed chat: reuse the resume id so the
      // transcript accumulates turns in ONE JSONL file (older events to page).
      const freshSessionId = (): string =>
        `mock-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // spec/04 § Branching — a FORK never continues the parent session: it
      // gets its own id, seeded with the shared prefix, so the parent track is
      // left exactly as it was and stays switchable-to.
      const isFork = runOpts.fork !== undefined;
      const sessionId =
        !isFork && runOpts.resumeSessionId && runOpts.resumeSessionId.length > 0
          ? runOpts.resumeSessionId
          : freshSessionId();
      if (isFork && projectsRoot !== undefined) {
        forkTranscript(
          projectsRoot,
          runOpts.cwd,
          runOpts.resumeSessionId ?? '',
          sessionId,
          runOpts.fork!.resumeAtUuid,
        );
      }

      // Dev/test trigger for the REAL blocking permission gate (unlike
      // `[[permission]]` below, which only emits the wire event without
      // blocking this generator — see its comment). This one actually calls
      // `runOpts.onPermissionRequest` and awaits it, mirroring how the real
      // SDK's `canUseTool` blocks the query iterator until the host resolves
      // the request, so the host's awaiting-permission -> resolve -> running
      // -> idle transition is exercisable end-to-end without the real SDK.
      // `onPermissionRequest` is wired for every mode now (chatRunner.ts), so
      // this mock mirrors the real SDK's OWN per-mode decision for an
      // ordinary tool call rather than just checking presence: `auto` and
      // `bypassPermissions` resolve an ordinary Bash call themselves, so the
      // call runs unblocked exactly as it would under those modes.
      const ordinaryCallBlocks =
        runOpts.permissionMode === 'default' ||
        runOpts.permissionMode === 'acceptEdits' ||
        runOpts.permissionMode === 'plan';
      if (runOpts.prompt.includes('[[bash-permission]]')) {
        const bashArgs = { command: 'echo hi' };
        const callId = `mock-bash-${Math.random().toString(36).slice(2, 8)}`;
        yield { type: 'assistant' as const, content: "I'd like to run a command." };
        if (runOpts.onPermissionRequest && ordinaryCallBlocks) {
          const decision = await runOpts.onPermissionRequest({
            tool: 'Bash',
            args: bashArgs,
            description: 'Run: echo hi',
          });
          if (!decision.approve) {
            yield {
              type: 'tool_result' as const,
              toolResult: {
                name: 'Bash',
                callId,
                // Carry the host's `denyMessage` where it has one, exactly as
                // the real adapter does (`toSdkPermissionResult`): an expiry is
                // not the user refusing, and a mock that flattens the two
                // cannot exercise the difference.
                result: decision.denyMessage ?? 'Permission denied by user',
                isError: true,
              },
            };
            yield { type: 'assistant' as const, content: "Okay, I won't run that." };
            yield { type: 'result' as const, sessionId };
            return;
          }
        }
        yield { type: 'tool_use' as const, tool: { name: 'Bash', args: bashArgs, callId } };
        yield {
          type: 'tool_result' as const,
          toolResult: { name: 'Bash', callId, result: 'hi\n' },
        };
        yield { type: 'assistant' as const, content: `[mock] echo: ${runOpts.prompt}` };
        yield { type: 'result' as const, sessionId };
        return;
      }

      // Dev/test trigger for the SDK's rare safety-check escalation (e.g. a
      // write to a "sensitive file") — unlike `[[bash-permission]]` above,
      // this one calls `onPermissionRequest` UNCONDITIONALLY, regardless of
      // `permissionMode`, because that's exactly what we proved live: the
      // real SDK can invoke its `canUseTool` gate for this class of request
      // even under `auto`/`bypassPermissions`, where an ordinary tool call
      // would never reach it.
      if (runOpts.prompt.includes('[[sensitive-file-permission]]')) {
        const editArgs = { file_path: '.claude/settings.json', content: '{}' };
        const callId = `mock-write-${Math.random().toString(36).slice(2, 8)}`;
        yield { type: 'assistant' as const, content: "I'd like to write a sensitive file." };
        if (runOpts.onPermissionRequest) {
          const decision = await runOpts.onPermissionRequest({
            tool: 'Write',
            args: editArgs,
            description: 'Write: .claude/settings.json (sensitive file)',
          });
          if (!decision.approve) {
            yield {
              type: 'tool_result' as const,
              toolResult: {
                name: 'Write',
                callId,
                result: 'Permission denied by user',
                isError: true,
              },
            };
            yield { type: 'assistant' as const, content: "Okay, I won't write that." };
            yield { type: 'result' as const, sessionId };
            return;
          }
        }
        yield { type: 'tool_use' as const, tool: { name: 'Write', args: editArgs, callId } };
        yield {
          type: 'tool_result' as const,
          toolResult: { name: 'Write', callId, result: 'ok' },
        };
        yield { type: 'assistant' as const, content: `[mock] echo: ${runOpts.prompt}` };
        yield { type: 'result' as const, sessionId };
        return;
      }

      // Dev/test trigger for the agent's built-in `AskUserQuestion` (spec/02
      // § Questions are not approvals). Like the sensitive-file trigger this
      // calls `onPermissionRequest` UNCONDITIONALLY — the real tool reaches
      // `canUseTool` under every permission mode, because there is nothing to
      // auto-approve: the permission layer IS the thing that collects the
      // answer. The tool then echoes back whatever `answers` it finds on its
      // (possibly updated) input, so this mock runs the returned `updatedInput`
      // rather than the args it proposed — which is exactly the mechanism the
      // host's answer substitution has to satisfy.
      if (runOpts.prompt.includes('[[ask-user-question]]')) {
        const askArgs: Record<string, unknown> = {
          questions: [
            {
              header: 'Library',
              question: 'Which date library should we use?',
              multiSelect: false,
              options: [
                { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
                { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
              ],
            },
          ],
        };
        const callId = `mock-ask-${Math.random().toString(36).slice(2, 8)}`;
        if (runOpts.onPermissionRequest) {
          const decision = await runOpts.onPermissionRequest({
            tool: 'AskUserQuestion',
            args: askArgs,
            description: 'Ask the user a question',
          });
          if (!decision.approve) {
            yield {
              type: 'tool_result' as const,
              toolResult: {
                name: 'AskUserQuestion',
                callId,
                result: decision.denyMessage ?? 'Permission denied by user',
                isError: true,
              },
            };
            // `[[linger]]`: the agent keeps working after a refusal (a real
            // agent writes a reply), until something aborts it.
            if (runOpts.prompt.includes('[[linger]]')) {
              await abortableDelay(60_000, runOpts.abortController.signal);
            }
            yield { type: 'result' as const, sessionId };
            return;
          }
          const input = decision.updatedInput ?? askArgs;
          const answers = (input['answers'] ?? {}) as Record<string, string>;
          yield {
            type: 'tool_use' as const,
            tool: { name: 'AskUserQuestion', args: input, callId },
          };
          yield {
            type: 'tool_result' as const,
            toolResult: {
              name: 'AskUserQuestion',
              callId,
              result: `User has answered your questions: ${Object.entries(answers)
                .map(([q, a]) => `${q}: ${a}`)
                .join('; ')}`,
            },
          };
        }
        yield { type: 'result' as const, sessionId };
        return;
      }

      const reply = `[mock] echo: ${runOpts.prompt}`;
      // Deterministic dev triggers so the FULL wire-event stream (tool calls,
      // tool results, permission prompts) is reachable on the live mock stack —
      // not just plain assistant messages. A prompt that contains one of these
      // markers makes the mock emit the corresponding envelopes, exactly as the
      // real SDK would, so every surface's renderer (TUI, web, mobile) can be
      // verified against genuinely-streamed events. WHEN a test enqueues its own
      // script (queue non-empty) that wins; these triggers only shape the
      // DEFAULT script.
      const prompt = runOpts.prompt;
      const defaultScript: SdkEnvelope[] = [];
      if (prompt.includes('[[tool]]')) {
        const callId = `mock-call-${Math.random().toString(36).slice(2, 8)}`;
        defaultScript.push(
          { type: 'assistant' as const, content: "I'll read the file." },
          {
            type: 'tool_use' as const,
            tool: { name: 'Read', args: { file_path: 'src/layout.ts' }, callId },
          },
          {
            type: 'tool_result' as const,
            toolResult: { name: 'Read', callId, result: 'export const layout = {};' },
          },
          { type: 'assistant' as const, content: reply },
          { type: 'result' as const, sessionId },
        );
      } else if (prompt.includes('[[multi-edit]]')) {
        // G3-5 dev trigger: a SINGLE agent turn that edits MULTIPLE files, so
        // the web diff editor's change-set rail (spec/14 § Diff editor: "lists
        // every file in the same edit (one or many)") has a real multi-file
        // edit to list + navigate between. Each Edit is applied to disk so a
        // subsequent file.write save (and HEAD/agent-baseline diff) has a real
        // target. The files are distinct so the rail shows >1 entry.
        const edits: Array<{ path: string; oldStr: string; newStr: string }> = [
          { path: 'note.txt', oldStr: 'hello world\n', newStr: 'hello patch\n' },
          { path: 'src/layout.ts', oldStr: 'const a = 1;\n', newStr: 'const a = 2;\n' },
          { path: 'README.md', oldStr: '# Project\n', newStr: '# Project (patched)\n' },
        ];
        defaultScript.push({ type: 'assistant' as const, content: "I'll edit several files." });
        for (const ed of edits) {
          const callId = `mock-edit-${Math.random().toString(36).slice(2, 8)}`;
          defaultScript.push(
            {
              type: 'tool_use' as const,
              tool: {
                name: 'Edit',
                args: { file_path: ed.path, old_string: ed.oldStr, new_string: ed.newStr },
                callId,
              },
            },
            {
              type: 'tool_result' as const,
              toolResult: { name: 'Edit', callId, result: 'ok' },
            },
          );
          try {
            const editTarget = join(runOpts.cwd, ed.path);
            mkdirSync(dirname(editTarget), { recursive: true });
            writeFileSync(editTarget, ed.newStr, 'utf8');
          } catch {
            // Best-effort dev convenience; the tool_call line still renders.
          }
        }
        defaultScript.push(
          { type: 'assistant' as const, content: reply },
          { type: 'result' as const, sessionId },
        );
      } else if (prompt.includes('[[edit]]')) {
        // G3 dev trigger: emit an APPLIED file-edit tool call (Edit) so the
        // web diff editor's "click a tool-call line → Monaco diff" path is
        // exercisable on the live mock stack. The mock also writes the file to
        // disk so a subsequent file.write save has a real on-disk target.
        const callId = `mock-edit-${Math.random().toString(36).slice(2, 8)}`;
        defaultScript.push(
          { type: 'assistant' as const, content: "I'll edit the file." },
          {
            type: 'tool_use' as const,
            tool: {
              name: 'Edit',
              args: {
                file_path: 'note.txt',
                old_string: 'hello world\n',
                new_string: 'hello patch\n',
              },
              callId,
            },
          },
          {
            type: 'tool_result' as const,
            toolResult: { name: 'Edit', callId, result: 'ok' },
          },
          { type: 'assistant' as const, content: reply },
          { type: 'result' as const, sessionId },
        );
        try {
          const editTarget = join(runOpts.cwd, 'note.txt');
          mkdirSync(dirname(editTarget), { recursive: true });
          writeFileSync(editTarget, 'hello patch\n', 'utf8');
        } catch {
          // Best-effort dev convenience; the tool_call line still renders.
        }
      } else if (prompt.includes('[[permission]]')) {
        defaultScript.push(
          { type: 'assistant' as const, content: "I'd like to edit a file." },
          {
            type: 'permission' as const,
            permission: {
              requestId: `mock-perm-${Math.random().toString(36).slice(2, 8)}`,
              tool: 'Edit',
              args: {
                file_path: 'src/layout.ts',
                old_string: 'const a = 1;',
                new_string: 'const a = 2;',
              },
              description: 'Edit src/layout.ts',
            },
          },
          { type: 'result' as const, sessionId },
        );
      } else {
        // Stream the reply as token-ish deltas first (mirroring the real SDK
        // under includePartialMessages), THEN the durable assistant message —
        // so the mock dev stack exercises the SAME progressive-render path the
        // real backend drives. The deltas are live-only; only the final
        // assistant message is persisted to the transcript.
        for (const chunk of chunkForStreaming(reply)) {
          defaultScript.push({ type: 'assistant_delta' as const, content: chunk });
        }
        defaultScript.push(
          { type: 'assistant' as const, content: reply },
          { type: 'result' as const, sessionId },
        );
      }
      const script: SdkEnvelope[] = queue.shift() ?? defaultScript;

      // Persist this turn to the on-disk transcript BEFORE streaming, so a
      // mid-turn `patch_history` (and post-turn pagination) see real older
      // events. We log the user prompt then each assistant text envelope.
      // Only when a projects root is configured (live host); unit tests skip.
      if (projectsRoot !== undefined) {
        const dir = join(projectsRoot, encodeFolderForTranscript(runOpts.cwd));
        try {
          mkdirSync(dir, { recursive: true });
          const transcript = join(dir, `${sessionId}.jsonl`);
          appendTranscriptLine(transcript, 'user', claudeCodePersistedUserTurn(runOpts.prompt));
          for (const ev of script) {
            appendEnvelopeToTranscript(transcript, ev);
          }
        } catch (err) {
          // NO FALLBACK silencing: a transcript write failure is surfaced so
          // the operator sees the live stack can't persist history.
          throw new Error(
            `mock backend: failed to persist transcript under ${dir}: ${(err as Error).message}`,
          );
        }
      }

      for (const ev of script) {
        if (runOpts.abortController.signal.aborted) return;
        // Yield asynchronously so consumers see real microtask boundaries.
        await Promise.resolve();
        // Stamp the (stable) sessionId onto the result so the host captures
        // it and resumes into the SAME transcript next turn.
        if (ev.type === 'result' && !ev.sessionId) {
          yield { ...ev, sessionId };
        } else {
          yield ev;
        }
      }

      // Hold the working window so stop-a-running-query is exercisable. This
      // sits AFTER content but the run only settles to idle once it returns,
      // so `activity` stays `running` (-> `working`) for the whole wait. A
      // `patch_stop` abort resolves the wait immediately.
      await abortableDelay(turnDelayMs, runOpts.abortController.signal);
    },
  };
}

/**
 * Mirror of the host `HistoryReader`'s folder encoder (history.ts
 * `encodeFolder`). Kept in lockstep so the mock writes to the exact path the
 * reader reads from. Replace `/` and `.` with `-`.
 */
function encodeFolderForTranscript(folder: string): string {
  return folder.replace(/[/.]/g, '-').replace(/^-+|-+$/g, '-');
}

/**
 * Lazy real backend — imports the SDK on first run. Fails loudly if the
 * package or OAuth is missing (NO FALLBACKS).
 */
export function createRealSdkBackend(): SdkBackend {
  return {
    run(opts: SdkRunOptions) {
      return realRun(opts);
    },
  };
}

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkModule: SdkModule | undefined;

/** `~/.patch`, matching config.ts. Read here so loadSdk needs no plumbing. */
/**
 * Load the agent SDK (spec/02 § Agent backends).
 *
 * A bare specifier, because the SDK is the host's own library dependency and
 * TRAVELS WITH IT: the artifact carries it in a `node_modules` beside
 * `daemon.mjs` (scripts/build-daemon.mjs), and a source checkout has it in the
 * monorepo's. It is not something a machine is expected to have, and nothing
 * installs it per host any more.
 *
 * What the machine DOES supply is the Claude Code binary the SDK drives — see
 * `claudeExecutable.ts`. The two are separate on purpose: ~4 MB of library in
 * the artifact, ~200 MB of CLI already on the machine.
 */
async function loadSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule;
  sdkModule = (await import(AGENT_SDK_PACKAGE).catch((err: unknown) => {
    throw new Error(
      `${AGENT_SDK_PACKAGE} could not be loaded (${(err as Error).message}). It ships inside the ` +
        'host artifact, so this build is incomplete — reinstall the host. For a stack that ' +
        'must not run real turns, set SDK_BACKEND=mock.',
    );
  })) as SdkModule;
  return sdkModule;
}

type StdioMcpServerConfig = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * SDK env (OAuth, never an API key per spec/10) + the stdio MCP servers this
 * chat gets: `patch` (this host's own tools) always and first, then
 * `opts.extraMcpServers` in list order — the caller (`chatRunner.ts`) has
 * already merged Claude Code's own discovered config (`claudeConfigMcp.ts`)
 * ahead of the host's enabled Settings → MCP list, so this function does not
 * distinguish the two. Wiring them here is what makes them reachable from a
 * DAEMON-spawned chat, since the SDK's `mcpServers` option (set explicitly
 * below) does not merge in the host's own `~/.claude/settings.json` /
 * `~/.claude.json` (spec/02 § MCP server). Everything is gated on
 * `opts.mcpServer` — unset for callers (tests, mock backends) that don't want
 * the patch tools server either. The wire schema reserves `patch`, so no entry
 * can shadow it.
 */
function buildSdkEnv(opts: SdkRunOptions): {
  env: Record<string, string | undefined>;
  mcpServers: ({ patch: StdioMcpServerConfig } & Record<string, StdioMcpServerConfig>) | undefined;
} {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  env['CLAUDE_CODE_OAUTH_TOKEN'] = opts.oauthAccessToken;
  // The chat's own shell commands learn which chat they are in (e.g. `pad
  // publish` sends Tom's edits back here). Only this run's id: never one
  // inherited from whatever launched the host.
  delete env['PATCH_CHAT_ID'];
  if (opts.chatId !== undefined) env['PATCH_CHAT_ID'] = opts.chatId;
  // Turn off the SDK's own auto-backgrounding of a foreground Bash/MCP-tool
  // call that runs past its own idle threshold — a THIRD path into the same
  // hole `RUN_IN_BACKGROUND_TOOLS` closes for the explicit `run_in_background`
  // flag. That check only fires at the moment a tool is CALLED; this is the
  // harness silently converting an already-running foreground command to a
  // background one partway through, with no `canUseTool` gate to catch it —
  // proven live (2026-09-18): an ordinary foreground `Bash` call with no
  // backgrounding flag at all ran past ~2 minutes and was auto-backgrounded,
  // then died the exact same way — orphaned, "no completion record" — when
  // this turn's process ended. Same root cause (backgroundTaskStats.ts: a
  // process the host never gets a real pid for), a path the flag check
  // cannot see because the decision happens after the tool already started,
  // not at the call. Disabling it means a command either finishes in the
  // foreground or the turn's own timeout/kill handles it loudly — never a
  // silent handoff to bookkeeping that dies with this process.
  env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'] = '1';
  env['CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND'] = '1';
  const mcpServers = opts.mcpServer
    ? {
        patch: {
          type: 'stdio' as const,
          command: opts.mcpServer.command,
          args: opts.mcpServer.args,
          env: opts.mcpServer.env,
        },
        ...Object.fromEntries(
          (opts.extraMcpServers ?? []).map((s) => [
            s.name,
            { type: 'stdio' as const, command: s.command, args: s.args, env: s.env },
          ]),
        ),
      }
    : undefined;
  return { env, mcpServers };
}

/**
 * Native Claude Code tools that are INERT in the host and must be removed from
 * the model's context (principles.md § Tool ownership). The `Cron*` family
 * assumes a resident Claude Code process with its own scheduler — in the host
 * each turn's `query()` runs to completion and exits, and we wire no Claude
 * cron/hooks, so an in-session cron has nothing to fire it. Leaving them visible
 * is a trap: the model is trained to reach for `CronCreate`, "schedules" a
 * reminder, and nothing ever fires. Patch owns durable scheduling via
 * `patch_wake_me` (self-wake, spec/02) and `patch_job_*` (jobs, spec/08).
 *
 * `SendMessage` and `ListAgents` assume a resident multi-agent "team" the SDK's
 * own harness tracks in-process — the host runs one chat as one `query()` per
 * turn, so there is no such roster to message or list; a call would address a
 * teammate that was never created. `ScheduleWakeup` is the same trap as `Cron*`
 * for the identical reason (docs/harness-parity.md): it schedules against a
 * resident process this host does not keep between turns. Patch's equivalent
 * is `patch_send_to` (cross-CHAT, not cross-teammate) and `patch_wake_me`.
 *
 * `Agent` (named `Task` in older Claude Code) and `Workflow` are Claude Code's
 * own subagents. They run inside this turn's process, so a host restart kills
 * them with it and the resumed turn has no way back to their work. Subagents
 * are patch's (`patch_spawn`), which outlive the turn and can be managed.
 *
 * `Monitor` and `TaskStop` are the same trap by a different route: `Monitor`
 * starts a background script inside the turn's own process, so a host
 * restart kills the watcher silently — and even while it's alive, the host
 * has no pid for it (only an inherited output file, like the `Bash`
 * `run_in_background` case below), so `TaskStop` can't reliably end it either.
 * `patch_watch`/`patch_watch_stop` are the durable equivalent: the host
 * spawns the command directly, holds a real pid, and re-attaches across a
 * restart.
 *
 * `PushNotification` delivers to Claude's own companion app, which Tom does
 * not use — never to the user's actual phone. `patch_notify` is the
 * equivalent that reaches him.
 *
 * `disallowedTools` removes them from context entirely (SDK option semantics).
 * Note `Bash`'s `run_in_background` flag is handled separately, in
 * `buildCanUseTool` below — Bash stays allowed for everything else it does, so
 * a blanket disallow here would be wrong; only the one flag is dead.
 */
export const DISALLOWED_NATIVE_TOOLS = [
  'Agent',
  'Task',
  'Workflow',
  'CronCreate',
  'CronList',
  'CronDelete',
  'SendMessage',
  'ListAgents',
  'ScheduleWakeup',
  'Monitor',
  'TaskStop',
  'PushNotification',
] as const;

/**
 * Native tools whose OWN backgrounding flag (`run_in_background: true`) is
 * disabled, per `buildCanUseTool` below. Keyed here rather than inline so the
 * deny check and its rationale live in one place. Only `Bash` remains: the
 * native subagent tools that also had the flag are disallowed outright (see
 * `DISALLOWED_NATIVE_TOOLS`).
 */
const RUN_IN_BACKGROUND_TOOLS = new Set(['Bash']);

/**
 * The message shown to the AGENT (not the user) when it reaches for native
 * backgrounding. Doubles as the "point the agent at patch_watch" guidance this
 * codebase would otherwise need a system prompt for (principles.md § No
 * system-prompt injection, per the comment on `SHARED_OPTS` below) — delivered
 * exactly when it's relevant instead of prepended to every turn.
 */
function backgroundToolDenyMessage(toolName: string): string {
  return (
    `${toolName}'s run_in_background is disabled. The SDK spawns that process INSIDE its own ` +
    'process tree, so the host never gets a real pid for it — only an inherited output file it ' +
    "can find indirectly (via lsof) — which means it can't be killed reliably and can't survive a " +
    'host restart (backgroundTaskStats.ts). Use patch_watch(command, description) instead: the ' +
    'host spawns it directly, holds a real pid, can kill it outright, re-attaches to it across a ' +
    'restart, and delivers a message into this chat when it finishes.'
  );
}

// Patch injects NO system prompt (principles.md § No system-prompt injection).
// `includePartialMessages` makes the SDK emit `stream_event` text-delta partials
// → `assistant_delta` envelopes → live `chat.message_delta` fan-out.
const SHARED_OPTS = {
  includePartialMessages: true as const,
};

/**
 * The Claude Code binary every query runs, as `pathToClaudeCodeExecutable`
 * (spec/02 § Agent backends — "so a host runs the same `claude` the user runs").
 *
 * Resolved ONCE per process: it is a property of the machine, not of a turn.
 * Absent, the option is omitted and the SDK says what it looked for — the
 * artifact carries the library, never the ~200 MB CLI, so there is nothing for
 * it to fall back to and nothing here should pretend otherwise.
 */
let claudeExecutable: string | undefined | null = null;
function claudeExecutablePath(): string | undefined {
  if (claudeExecutable === null) {
    claudeExecutable = resolveClaudeExecutable({
      home: homedir(),
      pathEnv: process.env['PATH'] ?? '',
      override: process.env['CLAUDE_CODE_PATH'],
    });
  }
  return claudeExecutable;
}

/** SDK options shared by both run paths, including the machine's CLI. */
function machineOpts(): { pathToClaudeCodeExecutable?: string } {
  const exe = claudeExecutablePath();
  return exe === undefined ? {} : { pathToClaudeCodeExecutable: exe };
}

/**
 * The full `disallowedTools` set for a turn: the always-inert native tools
 * (`DISALLOWED_NATIVE_TOOLS`) plus any the user has switched OFF for this chat
 * (`opts.disabledTools`, patch/todo.md — "turn them on and off"). Deduped so a
 * user disabling a Cron tool doesn't produce a duplicate entry.
 */
function disallowedToolsFor(opts: SdkRunOptions): string[] {
  return [...new Set([...DISALLOWED_NATIVE_TOOLS, ...(opts.disabledTools ?? [])])];
}

/**
 * The SDK options that turn a turn into the first turn of a FORKED session
 * (spec/04 § Branching): resume the parent transcript only up to the shared
 * prefix (`resumeSessionAt`) and land the turn in a new session (`forkSession`)
 * rather than appending to the parent. Empty when this is an ordinary turn.
 */
function forkOptsFor(opts: SdkRunOptions): Record<string, unknown> {
  if (!opts.fork) return {};
  return {
    forkSession: true,
    ...(opts.fork.resumeAtUuid !== null ? { resumeSessionAt: opts.fork.resumeAtUuid } : {}),
  };
}

/**
 * spec/14 § Document editor — Propose/Comment mode: `Edit`/`Write` on a `.md`
 * file whose sidecar mode is `propose` or `comment` is refused, naming the
 * mode, rather than landing a direct change the mode exists to prevent. A
 * fixed policy check, same reasoning (and same BEFORE-`onPermissionRequest`
 * placement) as the `run_in_background` one below — it must hold under
 * `bypassPermissions` too, not just whichever mode would otherwise escalate to
 * the user. `null` means this call is none of its business (not Edit/Write,
 * not a `.md` path, or the mode is `change`) and falls through to the normal
 * gate. Reads the sidecar synchronously off disk — same process, same cost as
 * any other `fs` call on the chat's own folder.
 */
function denyForDocMode(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): { behavior: 'deny'; message: string } | null {
  if (toolName !== 'Edit' && toolName !== 'Write') return null;
  const filePath = input['file_path'];
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.md')) return null;
  const abs = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  let mode: DocMode;
  try {
    mode = readSidecar(abs).mode;
  } catch {
    // A sidecar that fails to parse is a bug to surface loudly elsewhere
    // (docSidecar.ts's own read path), not a reason to block an edit here.
    return null;
  }
  if (mode === 'change') return null;
  const tool = toolName === 'Edit' ? 'patch_doc_suggest' : 'patch_doc_suggest or patch_doc_comment';
  return {
    behavior: 'deny',
    message:
      `This document is open in ${mode} mode — direct ${toolName} is refused. ` +
      `Use ${tool} instead, or ask the user to switch the document back to Change mode.`,
  };
}

/**
 * Bridges `SdkRunOptions.onPermissionRequest` to the real SDK's own
 * `canUseTool` gate, translating the host's simplified
 * `{approve, updatedInput?}` into the SDK's `PermissionResult` shape. A deny
 * carries the host's own `denyMessage` where it has one — an expired
 * question is not a refusal, and saying so is the difference between the agent
 * re-asking and the agent acting on a decision nobody made. Otherwise the
 * message is fixed: the wire protocol carries no user-supplied deny reason
 * (spec/03 `chat.permission_response`) for this to forward.
 *
 * Also where `Bash`'s native `run_in_background` is refused outright,
 * BEFORE `onPermissionRequest` is even asked — this is a fixed host policy
 * (backgroundTaskStats.ts's "we can never get a pid for this" limitation), not
 * a per-mode approval decision, so it must not depend on whether the SDK would
 * have escalated an ordinary call to the user under this turn's permission
 * mode. `canUseTool` is the same choke point the SDK already escalates its own
 * rare safety-check calls through even under `auto`/`bypassPermissions` (see
 * the sensitive-file case in sdkBackend's mock), so a fixed policy check here
 * runs on the same terms.
 */
function buildCanUseTool(
  onPermissionRequest: NonNullable<SdkRunOptions['onPermissionRequest']>,
  cwd: string,
  requestedMode: NonNullable<SdkRunOptions['permissionMode']>,
): CanUseTool {
  return async (toolName, input, sdkCtx) => {
    if (RUN_IN_BACKGROUND_TOOLS.has(toolName) && input['run_in_background'] === true) {
      return { behavior: 'deny', message: backgroundToolDenyMessage(toolName) };
    }
    const docDenial = denyForDocMode(toolName, input, cwd);
    if (docDenial !== null) return docDenial;
    const result = await onPermissionRequest({
      tool: toolName,
      args: input,
      ...(sdkCtx.description !== undefined ? { description: sdkCtx.description } : {}),
    });
    // An approved ExitPlanMode returns the process to the chat's mode inside the
    // approval itself, so the agent's next tool call cannot race the switch
    // (`returnFromPlanMode` follows the tool_result, which can arrive too late).
    if (result.approve && toolName === 'ExitPlanMode' && requestedMode !== 'plan') {
      return {
        behavior: 'allow',
        updatedInput: result.updatedInput ?? input,
        updatedPermissions: [{ type: 'setMode', mode: requestedMode, destination: 'session' }],
      };
    }
    return result.approve
      ? { behavior: 'allow', updatedInput: result.updatedInput ?? input }
      : { behavior: 'deny', message: result.denyMessage ?? 'Permission denied by user' };
  };
}

/**
 * The turn asked for one permission mode and Claude Code is running another —
 * and the mode it landed on is NOT `plan` (spec/02 § Permission mode's
 * plan-mode exception; see `permissionModeMismatchEnvelope` below for that
 * case, which does not throw this).
 *
 * Claude Code resolves `--permission-mode` against its OWN gates — the
 * server-side `tengu_auto_mode_config` circuit breaker, and whether the chosen
 * model supports the mode at all — and where a mode is unavailable it does not
 * refuse: it quietly substitutes another mode and carries on. `auto` on an old
 * CLI build, or `auto` on a model with `supportsAutoMode: false`, both land on
 * `default`.
 *
 * `default` asks the user to approve every tool call that is not already on an
 * allowlist. For an unattended job chat that is not a degraded mode, it is a
 * dead one: nobody is watching the chat it stalls in. And the substitution is
 * invisible — the turn looks like it is running, the agent looks like it is
 * thinking, and the only symptom is that the work never finishes.
 *
 * So patch refuses the turn instead (NO FALLBACK, spec/02 § Permission mode).
 * A chat that cannot run in the mode it was given is a chat that must say so.
 */
export class PermissionModeDowngradedError extends Error {
  constructor(
    readonly requested: string,
    readonly effective: string,
  ) {
    super(
      `Claude Code downgraded permission mode '${requested}' to '${effective}'. ` +
        `The mode this turn was given is unavailable — commonly because the host's ` +
        `\`claude\` build is too old for it, or because the chat's model does not ` +
        `support it — and running on '${effective}' instead would ask for approval on ` +
        `every tool call. Choose a mode this host can honour, update the host's ` +
        `\`claude\`, or move the chat to a model that supports the mode.`,
    );
    this.name = 'PermissionModeDowngradedError';
  }
}

/**
 * Reads the effective permission mode off Claude Code's `system`/`init`
 * message.
 *
 * `init` is the FIRST message of every query and carries the mode Claude Code
 * actually resolved, so this catches a substitution before a single tool call
 * has run. Returns the effective mode ONLY when it differs from what was
 * requested; `undefined` means either the modes match, or the message carries
 * nothing to check (not an `init` message, or a CLI too old to report the
 * field at all — that is not the same as a mismatch, and inventing one would
 * fail every turn on that host).
 */
function permissionModeMismatch(msg: unknown, requested: string): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'system' || m['subtype'] !== 'init') return undefined;
  const effective = m['permissionMode'];
  if (typeof effective !== 'string') return undefined;
  if (effective === requested) return undefined;
  return effective;
}

/**
 * Turns a mismatch `permissionModeMismatch` found into either an envelope
 * noting the plan-mode exception, or a thrown `PermissionModeDowngradedError`
 * for every other target (spec/02 § Permission mode). Shared by `oneShotRun`
 * and `persistentRun` so the two paths can't drift on which target is the
 * exception.
 */
function permissionModeMismatchEnvelope(requested: string, effective: string): SdkEnvelope {
  if (effective !== 'plan') {
    throw new PermissionModeDowngradedError(requested, effective);
  }
  return { type: 'system', permissionModeAutoDowngrade: { requested, effective: 'plan' } };
}

/**
 * The error text of a `result` message that is reporting a FAILURE — or
 * undefined when the turn genuinely succeeded.
 *
 * Claude Code reports a failed turn two different ways, and neither is a thrown
 * error:
 *
 *   - `subtype: 'success'` with `is_error: true`, the message in `result`. This
 *     is how a spend limit arrives.
 *   - `subtype: 'error_during_execution' | 'error_max_turns' | …`, the messages
 *     in `errors[]`.
 *
 * Patch read neither. `translateSdkMessage` took `result` as the turn's text and
 * emitted a plain `result` envelope, so the turn SETTLED — chat idle, no error,
 * nothing to retry, and the failure text delivered as though the agent had said
 * it. That is how dozens of chats sat there reading as finished with "You've hit
 * your monthly spend limit" as their last word: no error state, no auto-resume,
 * no icon, nothing for a human to notice. The SDK only throws when the process
 * ALSO exits non-zero, which is why some of them errored properly and others
 * looked fine — the same failure, two different outcomes, decided by whether the
 * CLI happened to exit cleanly afterwards.
 */
export function resultErrorText(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'result') return undefined;
  const subtype = typeof m['subtype'] === 'string' ? m['subtype'] : undefined;
  const isError = m['is_error'] === true;
  if (!isError && (subtype === undefined || subtype === 'success')) return undefined;
  // Prefer the specific text over the subtype label: "You've hit your monthly
  // spend limit · resets 8pm" is what the rate-limit and account-failover
  // predicates match on, and what a person needs to read.
  const errors = m['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => String(e)).join('; ');
  }
  const result = m['result'];
  if (typeof result === 'string' && result.trim().length > 0) return result;
  return subtype ?? 'unknown error';
}

/**
 * The error text of an ASSISTANT message that is really an injected failure
 * notice — or undefined when it is genuine model output.
 *
 * The third way Claude Code reports a failed turn, and the one that survived the
 * `result` fix: it injects a SYNTHETIC assistant message carrying the provider's
 * message, then ends the turn normally. In the transcript that entry is stamped
 * `isApiErrorMessage: true`, `model: "<synthetic>"`, with `apiErrorStatus` and
 * `quotaLimits` alongside; over the SDK it arrives as an `assistant` message with
 * the typed `error` field set ('rate_limit', 'billing_error', ...).
 *
 * Patch rendered it as the agent's own words. So a chat receiving a Todoist event
 * every few minutes answered each one with "You've hit your monthly spend limit"
 * and settled DONE — 492 of them across 141 sessions today, ticked green in the
 * sidebar, with nothing retrying any of it.
 *
 * Detected on the typed `error` field, NOT on the text: an agent quoting the
 * phrase must not be treated as a failure, and one was doing exactly that —
 * writing the reason into a Todoist comment to mark its own task failed. The
 * synthetic-model check is the fallback for an SDK that does not set `error`, and
 * it is paired with a limit/API-error signature so a benign synthetic notice is
 * left alone.
 */
export function assistantErrorText(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'assistant') return undefined;
  const inner = (m['message'] ?? {}) as Record<string, unknown>;
  const text = Array.isArray(inner['content'])
    ? (inner['content'] as Record<string, unknown>[])
        .filter((b) => b && b['type'] === 'text' && typeof b['text'] === 'string')
        .map((b) => String(b['text']))
        .join('\n')
        .trim()
    : '';

  // Four checks, in descending order of how much they can be trusted. The first
  // three are STRUCTURAL — a field's presence or a typed value, nothing parsed
  // out of prose. Only the last reads the text, and it is last for that reason.
  //
  // 1. The SDK's own typed field. Documented, part of the contract, and says
  //    both THAT this is an error and which kind.
  const errorKind = typeof m['error'] === 'string' ? m['error'] : undefined;
  if (errorKind !== undefined) {
    return text.length > 0 ? text : `assistant error: ${errorKind}`;
  }
  // 2. The transcript's own marker, where the SDK passes it through.
  if (m['isApiErrorMessage'] === true) {
    return text.length > 0 ? text : 'api error (no text)';
  }
  // 3. Fields that only exist ON an error. `apiErrorStatus` is the HTTP status
  //    that failed; `quotaLimits` is the limit that was hit. Neither appears on
  //    a normal message, so their presence is the fact — no prose involved.
  if (m['apiErrorStatus'] !== undefined || m['quotaLimits'] !== undefined) {
    const status = m['apiErrorStatus'];
    return text.length > 0 ? text : `api error${status === undefined ? '' : ` ${String(status)}`}`;
  }
  // 4. LAST RESORT, and the only text-dependent one: a message the CLI generated
  //    rather than the model (`<synthetic>`, and no input tokens — a real model
  //    turn always consumes some) whose text reads as a failure.
  //
  //    Kept narrow deliberately. A synthetic message is not always an error —
  //    compaction notices arrive the same way — so dropping the text check here
  //    would fail turns that merely got compacted. If this arm is ever the one
  //    doing the work, checks 1-3 have stopped being surfaced and that is worth
  //    knowing rather than papering over: it is logged as such by the caller.
  const usage = (inner['usage'] ?? {}) as Record<string, unknown>;
  const noModelInput = usage['input_tokens'] === 0;
  if (inner['model'] === '<synthetic>' && noModelInput && text.length > 0) {
    if (isAccountExhaustedError(text) || /api error|overloaded|rate limit/i.test(text)) return text;
  }
  return undefined;
}

/**
 * Did this assistant message come from the MODEL at all?
 *
 * A real turn consumes input tokens; an injected notice consumes none and is
 * stamped `<synthetic>`. Structural, so it holds whatever the notice says — and
 * it is what lets the caller notice a turn that produced nothing real even when
 * none of the error markers above fired. That is the case that has bitten twice
 * now: a failure patch had no idea was a failure.
 */
export function isModelOutput(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'assistant') return false;
  const inner = (m['message'] ?? {}) as Record<string, unknown>;
  if (inner['model'] === '<synthetic>') return false;
  const usage = (inner['usage'] ?? {}) as Record<string, unknown>;
  // Absent usage is treated as real: an older CLI may not report it, and calling
  // a genuine turn fake is worse than missing a fake one here — the error
  // markers above are the primary defence, this is only the safety net.
  if (usage['input_tokens'] === undefined) return true;
  return Number(usage['input_tokens']) > 0;
}

/**
 * Fail the turn when Claude Code reported an error result.
 *
 * Thrown rather than emitted as some new envelope kind so it lands in the ONE
 * place that already knows what to do with a failed turn: the rate-limit park,
 * the account failover, the retry ladder and the `chat.error` the surfaces
 * render. The message is prefixed exactly as the SDK's own transport-level throw
 * prefixes it, so every predicate matching on that text keeps working whichever
 * way the failure arrived.
 */
/**
 * The limit an error message states, as structured data rather than prose.
 *
 * Claude Code puts it on the synthetic assistant message alongside the text:
 *
 *   "quotaLimits": { "status": "rejected", "resetsAt": 1788804000,
 *                    "rateLimitType": "five_hour", ... }
 *   "error": "rate_limit", "apiErrorStatus": 429
 *
 * Every consumer downstream used to read the PROSE instead — deciding "is this
 * an account limit?" by substring and recovering the reset time by parsing
 * "· your session limit resets 6pm (UTC)". The structured field was sitting
 * right there on the same message and was thrown away at the error boundary
 * below. Prose is a worse source twice over: a wording change breaks it
 * silently, and a stated hour has to be re-derived into an instant, where the
 * exact epoch needs no interpretation at all.
 *
 * `resetsAt` is in SECONDS here (1788804000 = 2026-09-07T18:00Z, the "6pm
 * (UTC)" that message states) while everything inside Patch works in ms, so it
 * is normalised on the way out. Anything already large enough to be ms is left
 * alone rather than multiplied into the year 58000.
 */
export interface LimitFacts {
  /** The SDK's typed error kind: 'rate_limit', 'billing_error', … */
  kind?: string;
  /** 'allowed' | 'allowed_warning' | 'rejected' — 'rejected' means blocked NOW. */
  status?: string;
  /** Which window was hit: 'five_hour', 'seven_day', … */
  rateLimitType?: string;
  /** When it lifts, epoch MILLISECONDS. */
  resetsAt?: number;
}

/** Seconds or milliseconds in, milliseconds out. */
function toEpochMs(value: number): number {
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

export function limitFactsOf(msg: unknown): LimitFacts | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  const facts: LimitFacts = {};
  if (typeof m['error'] === 'string') facts.kind = m['error'];
  const quota = m['quotaLimits'];
  if (typeof quota === 'object' && quota !== null) {
    const q = quota as Record<string, unknown>;
    if (typeof q['status'] === 'string') facts.status = q['status'];
    if (typeof q['rateLimitType'] === 'string') facts.rateLimitType = q['rateLimitType'];
    if (typeof q['resetsAt'] === 'number') facts.resetsAt = toEpochMs(q['resetsAt']);
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/**
 * A failed turn, carrying what the provider said about it in structured form.
 *
 * The text is still the message — every existing predicate matches on it — but
 * `limit` rides along so the rate-limit park can use an exact reset instant and
 * a typed status instead of re-reading the sentence it came from.
 */
export class TurnFailedError extends Error {
  readonly limit: LimitFacts | undefined;
  constructor(message: string, limit: LimitFacts | undefined) {
    super(message);
    this.name = 'TurnFailedError';
    this.limit = limit;
  }
}

function assertResultNotAnError(msg: unknown): void {
  const text = resultErrorText(msg) ?? assistantErrorText(msg);
  if (text !== undefined) {
    throw new TurnFailedError(`Claude Code returned an error result: ${text}`, limitFactsOf(msg));
  }
}

/**
 * `sessionStore` for this run, or `{}` when the caller hasn't wired one
 * (mock-backend tests, or a call site not yet passing it) — the SDK then
 * falls back to its own local-disk resume, unaffected.
 */
function sessionStoreOptFor(opts: SdkRunOptions): {
  sessionStore?: ReturnType<typeof createClaudeSessionStore>;
} {
  if (!opts.claudeSessionStore) return {};
  const cs = opts.claudeSessionStore;
  return {
    sessionStore: createClaudeSessionStore({
      chatId: opts.chatId ?? '',
      folder: opts.cwd,
      nativeDir: cs.nativeDir,
      claudeProjectsRoot: cs.claudeProjectsRoot,
      logger: cs.logger,
      ...(cs.onAppend ? { onAppend: cs.onAppend } : {}),
      ...(cs.reseed && opts.resumeSessionId
        ? {
            reseed: {
              sessionId: opts.resumeSessionId,
              events: cs.reseed.events,
              model: cs.reseed.model,
            },
          }
        : {}),
    }),
  };
}

/**
 * The SDK `hooks` option that delivers {@link SdkRunOptions.onToolBoundary}
 * text at each tool boundary. Empty when the run has no boundary callback, so a
 * run without one is configured exactly as before.
 */
export function boundaryHooks(opts: Pick<SdkRunOptions, 'onToolBoundary'>): {
  hooks?: { PostToolBatch: HookCallbackMatcher[] };
} {
  const { onToolBoundary } = opts;
  if (onToolBoundary === undefined) return {};
  return {
    hooks: {
      PostToolBatch: [
        {
          hooks: [
            async () => {
              const text = await onToolBoundary();
              if (text === undefined || text === '') return {};
              return {
                hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: text },
              };
            },
          ],
        },
      ],
    },
  };
}

/** A bare string, or — when images ride along — one user turn of image + text blocks. */
function oneShotPrompt(opts: SdkRunOptions): string | AsyncIterable<SDKUserMessage> {
  const images = opts.images ?? [];
  if (images.length === 0) return opts.prompt;
  const turn = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((i) => ({
          type: 'image',
          source: { type: 'base64', media_type: i.mediaType, data: i.data },
        })),
        { type: 'text', text: opts.prompt },
      ],
    },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
  return (async function* () {
    yield turn;
  })();
}

async function* oneShotRun(opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> {
  const { query } = await loadSdk();
  const { env, mcpServers } = buildSdkEnv(opts);
  const q = query({
    prompt: oneShotPrompt(opts),
    options: {
      cwd: opts.cwd,
      abortController: opts.abortController,
      resume: opts.resumeSessionId,
      ...forkOptsFor(opts),
      ...sessionStoreOptFor(opts),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      permissionMode: opts.permissionMode ?? 'auto',
      ...(opts.onPermissionRequest
        ? {
            canUseTool: buildCanUseTool(
              opts.onPermissionRequest,
              opts.cwd,
              opts.permissionMode ?? 'auto',
            ),
          }
        : {}),
      ...SHARED_OPTS,
      ...machineOpts(),
      ...boundaryHooks(opts),
      disallowedTools: disallowedToolsFor(opts),
      env,
      mcpServers,
      ...systemPromptOption(opts),
      ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
      ...(opts.settingSources !== undefined ? { settingSources: opts.settingSources } : {}),
    },
  });
  const toolNames = new Map<string, string>();
  const requestedMode = opts.permissionMode ?? 'auto';
  for await (const msg of q) {
    const mismatch = permissionModeMismatch(msg, requestedMode);
    assertResultNotAnError(msg);
    if (mismatch !== undefined) yield permissionModeMismatchEnvelope(requestedMode, mismatch);
    const envs = translateSdkMessage(msg, toolNames);
    yield* envs;
    await returnFromPlanMode(q, envs, requestedMode);
  }
}

/**
 * The agent's own `ExitPlanMode`, once approved, leaves the running process on
 * whatever mode Claude Code picks — not necessarily the one the chat was asked
 * to run under. chatRunner puts the chat's displayed mode back; this puts the
 * process back, so a `bypassPermissions` chat stops asking for approval on
 * every tool call after a plan.
 */
async function returnFromPlanMode(
  q: Pick<Query, 'setPermissionMode'>,
  envs: readonly SdkEnvelope[],
  requestedMode: NonNullable<SdkRunOptions['permissionMode']>,
): Promise<void> {
  if (requestedMode === 'plan') return;
  const exited = envs.some(
    (e) =>
      e.type === 'tool_result' &&
      e.toolResult?.name === 'ExitPlanMode' &&
      e.toolResult.isError !== true,
  );
  if (exited) await q.setPermissionMode(requestedMode);
}

// ---- Persistent streaming-input sessions (PATCH_PERSISTENT_SESSIONS=1) -------
// One warm Claude Code process per chat, kept open across turns so the ~1.8s
// process spawn is paid ONCE, not every utterance. Barge-in / stop interrupts
// the current turn via `query.interrupt()` WITHOUT killing the process. An idle
// session self-closes after PERSIST_IDLE_MS to free the process. Opt-in + the
// one-shot path remains the safe fallback (a broken session is dropped + the
// next turn re-opens fresh).
interface PersistSession {
  query: Query;
  push: (prompt: string) => void;
  end: () => void;
  cwd: string;
  idle?: ReturnType<typeof setTimeout> | undefined;
}
const PERSIST_IDLE_MS = 120_000;
const persistSessions = new Map<string, PersistSession>();

function openPersistSession(opts: SdkRunOptions, query: SdkModule['query']): PersistSession {
  const { env, mcpServers } = buildSdkEnv(opts);
  const inbox: SDKUserMessage[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const push = (prompt: string): void => {
    inbox.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage);
    notify?.();
    notify = null;
  };
  const end = (): void => {
    ended = true;
    notify?.();
    notify = null;
  };
  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!ended) {
      const next = inbox.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (notify = r));
    }
  }
  const q = query({
    // No per-turn abortController here: barge-in/stop calls q.interrupt() so the
    // process stays warm. `resume` only matters on (re)open; within the live
    // session context is in-process.
    prompt: input(),
    options: {
      cwd: opts.cwd,
      resume: opts.resumeSessionId,
      ...forkOptsFor(opts),
      ...sessionStoreOptFor(opts),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      permissionMode: opts.permissionMode ?? 'auto',
      ...(opts.onPermissionRequest
        ? {
            canUseTool: buildCanUseTool(
              opts.onPermissionRequest,
              opts.cwd,
              opts.permissionMode ?? 'auto',
            ),
          }
        : {}),
      ...SHARED_OPTS,
      ...machineOpts(),
      ...boundaryHooks(opts),
      disallowedTools: disallowedToolsFor(opts),
      env,
      mcpServers,
      ...systemPromptOption(opts),
      ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
      ...(opts.settingSources !== undefined ? { settingSources: opts.settingSources } : {}),
    },
  });
  return { query: q, push, end, cwd: opts.cwd };
}

/**
 * The SDK's `systemPrompt` option for this run.
 *
 * `toolsPrompt` is patch's own tool guidance and must ADD to the prompt in
 * force, never replace it: the SDK's preset form carries `append` for exactly
 * this, and a bare string would drop the harness prompt the agent depends on.
 * With a per-host override in play there is no preset to append to, so the two
 * are concatenated instead — the override still wins the parts it names.
 */
type SdkSystemPrompt = NonNullable<Options['systemPrompt']>;

function systemPromptOption(opts: SdkRunOptions): { systemPrompt?: SdkSystemPrompt } {
  const { systemPrompt, toolsPrompt } = opts;
  if (!toolsPrompt) return systemPrompt ? { systemPrompt } : {};
  if (systemPrompt) return { systemPrompt: `${systemPrompt}\n\n${toolsPrompt}` };
  return { systemPrompt: { type: 'preset', preset: 'claude_code', append: toolsPrompt } };
}

async function* persistentRun(opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> {
  const { query } = await loadSdk();
  const chatId = opts.chatId as string;
  let session = persistSessions.get(chatId);
  // Re-open if absent or the working dir changed (a different cwd is a different
  // context — never reuse). The host serializes turns per chat, so a session
  // is never mid-turn when the next turn arrives.
  if (!session || session.cwd !== opts.cwd) {
    if (session) session.end();
    session = openPersistSession(opts, query);
    persistSessions.set(chatId, session);
  }
  const s = session;
  if (s.idle) {
    clearTimeout(s.idle);
    s.idle = undefined;
  }
  // Barge-in / stop interrupts THIS turn but leaves the process warm.
  const onAbort = (): void => {
    void s.query.interrupt().catch(() => undefined);
  };
  opts.abortController.signal.addEventListener('abort', onAbort, { once: true });
  const toolNames = new Map<string, string>();
  try {
    s.push(opts.prompt);
    for (;;) {
      const next = await s.query.next();
      if (next.done === true) {
        persistSessions.delete(chatId);
        return;
      }
      const msg: unknown = next.value;
      const requestedMode = opts.permissionMode ?? 'auto';
      const mismatch = permissionModeMismatch(msg, requestedMode);
      assertResultNotAnError(msg);
      if (mismatch !== undefined) yield permissionModeMismatchEnvelope(requestedMode, mismatch);
      const envs = translateSdkMessage(msg, toolNames);
      yield* envs;
      await returnFromPlanMode(s.query, envs, requestedMode);
      if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'result') {
        break;
      }
    }
  } catch (err) {
    // NO silent recovery: drop the broken session so the next turn re-opens
    // fresh, and rethrow so chatRunner marks the turn errored.
    persistSessions.delete(chatId);
    s.end();
    throw err;
  } finally {
    opts.abortController.signal.removeEventListener('abort', onAbort);
    if (persistSessions.get(chatId) === s) {
      s.idle = setTimeout(() => {
        s.end();
        if (persistSessions.get(chatId) === s) persistSessions.delete(chatId);
      }, PERSIST_IDLE_MS);
    }
  }
}

async function* realRun(opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> {
  if (process.env['PATCH_PERSISTENT_SESSIONS'] === '1' && opts.chatId !== undefined) {
    yield* persistentRun(opts);
    return;
  }
  yield* oneShotRun(opts);
}

/**
 * The plain text of a user message, whether the SDK delivers it as a bare
 * string or as text content blocks. Non-text blocks (tool results) contribute
 * nothing — they are not prose the chat should show.
 */
function userMessageText(msg: Record<string, unknown>): string {
  const message = msg['message'];
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
    }
  }
  return text;
}

// Best-effort translation. The wire layer downstream is permissive about
// `unknown` content — we just shape the envelope(s).
//
// Returns an ARRAY: real Claude Code packs a message's blocks into one
// `content` array, so a single assistant SDK message can carry narration text
// AND one or more `tool_use` blocks, and a follow-up user message carries the
// `tool_result` blocks. Each block becomes its own envelope (mirroring
// history.ts's `jsonlLineToWire`, which does the same walk for REPLAY) so a
// live turn's tool calls reach the wire as `chat.tool_call`/`chat.tool_result`
// events as they happen, instead of only being recoverable retroactively on
// reconnect/replay.
//
// `toolNames` mirrors history.ts's `jsonlLineToWire` param: a tool_result
// block never carries its own name (only `tool_use_id`), so the name has to
// come from the `tool_use` block seen earlier in the SAME live stream.
// Callers walking a whole run (oneShotRun/persistentRun) thread ONE map
// across every message so a result can see a call from an earlier message;
// omitted (fresh map per call) falls back to the literal `'tool'` placeholder
// when truly unmatched — same convention as the replay path.
export function translateSdkMessage(
  msg: unknown,
  toolNames: Map<string, string> = new Map(),
): SdkEnvelope[] {
  if (typeof msg !== 'object' || msg === null) {
    return [{ type: 'system', raw: msg }];
  }
  const m = msg as Record<string, unknown>;
  const type = m['type'];
  if (type === 'stream_event') {
    // SDKPartialAssistantMessage — a raw Anthropic streaming event. We only
    // care about text deltas (`content_block_delta` → `text_delta`); every
    // other partial (message_start, content_block_start for tool_use,
    // message_delta usage, ping, etc.) carries no chat-visible text and is
    // mapped to a no-content `system` envelope the host ignores. The
    // turn's COMPLETE text still arrives as the final `assistant` message,
    // and its tool_use blocks arrive as their own final `assistant` message.
    const event = m['event'];
    if (typeof event === 'object' && event !== null) {
      const e = event as Record<string, unknown>;
      if (e['type'] === 'content_block_delta') {
        const delta = e['delta'];
        if (typeof delta === 'object' && delta !== null) {
          const d = delta as Record<string, unknown>;
          if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
            return [{ type: 'assistant_delta', content: d['text'], raw: msg }];
          }
        }
      }
    }
    return [{ type: 'system', raw: msg }];
  }
  // Claude Code's own id for the message, on every envelope made from it.
  const nativeId = typeof m['uuid'] === 'string' && m['uuid'].length > 0 ? m['uuid'] : undefined;
  const withNative = <T extends SdkEnvelope>(env: T): T =>
    nativeId !== undefined ? { ...env, nativeId } : env;
  if (type === 'result') {
    const sessionId = typeof m['session_id'] === 'string' ? m['session_id'] : undefined;
    const result = typeof m['result'] === 'string' ? m['result'] : undefined;
    return [{ type: 'result', sessionId, content: result, raw: msg }];
  }
  if (type === 'rate_limit_event') {
    const info = m['rate_limit_info'];
    if (typeof info === 'object' && info !== null) {
      const i = info as Record<string, unknown>;
      const status = i['status'];
      const rateLimitType = i['rateLimitType'];
      const scope =
        rateLimitType === 'five_hour' ? 'session' : rateLimitType === 'seven_day' ? 'week' : null;
      if (
        scope &&
        (status === 'allowed' || status === 'allowed_warning' || status === 'rejected')
      ) {
        const utilization = typeof i['utilization'] === 'number' ? i['utilization'] : undefined;
        const resetsAt = typeof i['resetsAt'] === 'number' ? i['resetsAt'] : undefined;
        return [
          {
            type: 'system',
            rateLimit: {
              scope,
              window: {
                status,
                ...(utilization !== undefined ? { utilization } : {}),
                ...(resetsAt !== undefined ? { resetsAt } : {}),
              },
            },
            raw: msg,
          },
        ];
      }
    }
    return [{ type: 'system', raw: msg }];
  }
  if (type === 'assistant') {
    const message = m['message'];
    const sessionId = typeof m['session_id'] === 'string' ? m['session_id'] : undefined;
    const content =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)['content']
        : undefined;
    if (!Array.isArray(content)) {
      return [{ type: 'assistant', content: '', sessionId, raw: msg }];
    }
    const out: SdkEnvelope[] = [];
    const thinking: SdkEnvelope[] = [];
    let text = '';
    const flushText = (): void => {
      if (text.length === 0) return;
      out.push(withNative({ type: 'assistant', content: text, sessionId, raw: msg }));
      text = '';
    };
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        text += b['text'];
      } else if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
        if (b['thinking'].length > 0) {
          thinking.push(withNative({ type: 'system', thinking: b['thinking'], raw: msg }));
        }
      } else if (b['type'] === 'tool_use') {
        flushText();
        const name = typeof b['name'] === 'string' ? b['name'] : '';
        const callId = typeof b['id'] === 'string' ? b['id'] : '';
        if (name.length === 0 || callId.length === 0) continue;
        toolNames.set(callId, name);
        out.push(
          withNative({ type: 'tool_use', tool: { name, args: b['input'], callId }, raw: msg }),
        );
      }
    }
    flushText();
    // Every prior assistant message shape produced exactly one envelope, even
    // one with `content: ''` — downstream code (and existing tests) rely on
    // that "one message → at least one envelope" guarantee. Only messages
    // with a real tool_use block break that 1:1 mapping on purpose. Thinking
    // rides on envelopes of its own ahead of them, and does not count.
    if (out.length === 0)
      out.push(withNative({ type: 'assistant', content: '', sessionId, raw: msg }));
    return [...thinking, ...out];
  }
  if (type === 'user') {
    // spec/02 § Background task completions. A finished background task is
    // reported on a user message, and is the one thing such a message's own
    // TEXT carries that the chat must show — otherwise the agent visibly
    // reacts to something that was never on screen. Everything else a user
    // message's text carries (the turn's own prompt echo) stays
    // chat-invisible; its `tool_result` blocks (below) are NOT text and get
    // their own `chat.tool_result` envelope so a live tool call's result is
    // visible, matching history.ts's replay reconstruction.
    const summary = taskNotificationSummary(userMessageText(m));
    if (summary !== null) return [{ type: 'system', content: summary, raw: msg }];
    const message = m['message'];
    const content =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)['content']
        : undefined;
    if (!Array.isArray(content)) return [{ type: 'user', raw: msg }];
    const out: SdkEnvelope[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;
      const callId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '';
      if (callId.length === 0) continue;
      out.push(
        withNative({
          type: 'tool_result',
          toolResult: {
            // Named after the matching tool_use seen earlier in this stream
            // (see the `toolNames` doc above). 'tool' is a last-resort,
            // non-empty placeholder for the rare case no matching call is in
            // scope (e.g. this run started mid-turn).
            name: toolNames.get(callId) ?? 'tool',
            callId,
            result: b['content'],
            ...(b['is_error'] === true ? { isError: true } : {}),
          },
          raw: msg,
        }),
      );
    }
    if (out.length === 0) return [{ type: 'user', raw: msg }];
    return out;
  }
  // spec/02 § Context compression — the one system message that IS chat-visible.
  if (type === 'system' && m['subtype'] === 'compact_boundary') {
    const compaction = compactionFromSdkMetadata(m['compact_metadata']);
    return [{ type: 'system', content: compactionSummaryLine(compaction), compaction, raw: msg }];
  }
  // spec/02 § Provider-level context — Claude Code's OWN `type: "attachment"`
  // stream entries (environment, model identity, token counts, ...). Same
  // translation `history.ts`'s replay path uses, so a live turn and a replayed
  // one describe the identical shape.
  if (type === 'attachment') {
    const item = translateAttachment(m);
    if (item === null) return [{ type: 'system', raw: msg }];
    return [{ type: 'provider_context', providerContext: item, raw: msg }];
  }
  return [{ type: 'system', raw: msg }];
}
