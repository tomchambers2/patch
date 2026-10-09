// spec/15 ## Chat detail — mobile's tool rows follow web's rules (spec/14 ##
// Main chat panel): a one-line summary that says what the call is DOING, and a
// consecutive run of more than one call folded into a single row.
//
// The summary half is a deliberate mirror of `packages/web/src/lib/
// toolSummary.ts`; the two surfaces share no code of their own (same
// arrangement as `deliveryTracker.ts`) — only primitives out of `@patch/wire`,
// like `folderName` — so a rule changed there has to be changed here too.
// The grouping half mirrors the run-detection in web's `ChatRoute.tsx`, but is
// a pure function here because the mobile transcript is a FlatList and needs
// its rows as data.

import { folderName, isGroupableToolCall } from '@patch/wire';

import type { ChatEventEntry } from '../stores/chatStore';

/** Longest description we'll put on a row before eliding — the row is one line. */
const MAX_DESCRIPTION = 60;
/** Commands are noisier per character than prose, so they get less room. */
const MAX_COMMAND = 40;

function clip(text: string, max: number): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The run's status line: the agent's own sentence just before it ("Researching how to set up shaver…"). */
const MAX_NARRATION = 80;

export function runNarration(
  prev: { kind: string; role?: string | undefined; content?: string | undefined } | undefined,
): string | null {
  if (!prev || prev.kind !== 'message' || prev.role !== 'assistant') return null;
  const line = (prev.content ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  const text = clip(line.replace(/^[-*#>\s]+/, '').replace(/\*\*/g, ''), MAX_NARRATION);
  return text === '' ? null : text;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * A path-valued target reads as its FILENAME, never the absolute path.
 *
 * The row is one line and truncates at the TAIL, and every path from one chat's
 * folder shares the same long absolute prefix, so drawing the whole path spent
 * the row on the part that is identical on every row and cut the filename off —
 * the only part that differs (Todoist "can't see filename", 28 Aug 2026). A
 * collapsed run is tighter still: three summaries share that one line. The full
 * path is not lost, it is in the expanded args a tap away.
 *
 * Same rule (and the same primitive, `folderName`) as the folder pickers and
 * the chat-detail crumb: show the name, keep the path as secondary detail.
 */
function fileName(path: string): string {
  return folderName(path);
}

/**
 * The part of the summary after the tool name: what this call acted on.
 * Free text (a command, a search) is quoted so it reads as a value rather than
 * running into the tool name; identifiers (paths, URLs, agent names) are not.
 */
function toolCallTarget(tool: string, args: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const path = str(args, 'file_path');
      return path ? fileName(path) : undefined;
    }
    case 'NotebookEdit': {
      const path = str(args, 'notebook_path') ?? str(args, 'file_path');
      return path ? fileName(path) : undefined;
    }
    case 'Glob':
      return str(args, 'pattern');
    case 'Grep': {
      const pattern = str(args, 'pattern');
      return pattern ? `"${pattern}"` : undefined;
    }
    case 'Bash': {
      const command = str(args, 'command');
      return command ? `"${clip(command, MAX_COMMAND)}"` : undefined;
    }
    case 'WebFetch':
      return str(args, 'url');
    case 'WebSearch': {
      const query = str(args, 'query');
      return query ? `"${query}"` : undefined;
    }
    case 'Task':
      return str(args, 'subagent_type');
    case 'Skill':
      return str(args, 'skill');
    default:
      return undefined;
  }
}

/**
 * One line naming the call: `<tool> <what it's doing>`, or the bare tool name
 * when the tool offers nothing to name. Tools that carry their own
 * `description` (Bash, Task) win over the raw argument — the model already
 * wrote the readable version of what it is up to.
 */
export function toolCallSummary(tool: string | undefined, rawArgs: unknown): string {
  const name = tool ?? 'tool';
  const args =
    typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  const described = str(args, 'description');
  const detail = described ? clip(described, MAX_DESCRIPTION) : toolCallTarget(name, args);
  return detail ? `${name} ${detail}` : name;
}

/**
 * A collapsed run's one line: a sentence saying what the batch DID, grouped by
 * kind of work in the order it first happened — "Ran 3 commands, read 2 files,
 * searched for 1 pattern" — rather than a bare count of calls. Counts, never
 * targets: which files and which commands is what expanding the run is for.
 */
export function toolRunNarrative(calls: { tool?: string | undefined }[]): string {
  const counts = new Map<string, number>();
  const phrase = new Map<string, (n: number) => string>();
  for (const call of calls) {
    const [key, say] = toolActivity(call.tool ?? 'tool');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    phrase.set(key, say);
  }
  const clauses = [...counts].map(([key, n]) => phrase.get(key)!(n));
  const text = clauses.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function times(n: number): string {
  return n === 1 ? '' : ` ${n} times`;
}

/** The kind of work a call does, and how to say N of them. */
function toolActivity(tool: string): [string, (n: number) => string] {
  switch (tool) {
    case 'Read':
      return ['read', (n) => `read ${plural(n, 'file', 'files')}`];
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return ['write', (n) => `edited ${plural(n, 'file', 'files')}`];
    case 'Grep':
    case 'Glob':
      return ['search', (n) => `searched for ${plural(n, 'pattern', 'patterns')}`];
    case 'Bash':
      return ['bash', (n) => `ran ${plural(n, 'command', 'commands')}`];
    case 'WebFetch':
      return ['fetch', (n) => `fetched ${plural(n, 'page', 'pages')}`];
    case 'WebSearch':
      return ['websearch', (n) => `searched the web${times(n)}`];
    case 'Task':
    case 'Agent':
      return ['agent', (n) => `ran ${plural(n, 'agent', 'agents')}`];
    case 'Skill':
      return ['skill', (n) => `used ${plural(n, 'skill', 'skills')}`];
    case 'TodoWrite':
      return ['todo', () => 'updated the todo list'];
    case 'ToolSearch':
      return ['toolsearch', () => 'loaded tools'];
  }
  // An MCP tool reads as its server — "called playwright 4 times" — since a run
  // driving one server usually spreads across several of its tools.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const name = mcp ? (mcp[1] === 'patch' ? mcp[2]! : mcp[1]!) : tool;
  return [`call:${name}`, (n) => `called ${name}${times(n)}`];
}

function isViewFileCall(entry: ChatEventEntry): boolean {
  return entry.tool === 'view_file' || entry.tool === 'mcp__patch__view_file';
}

/** A transcript row: either one timeline entry, or a folded run of tool entries. */
export type TimelineRow =
  | { kind: 'entry'; key: string; entry: ChatEventEntry; result?: ChatEventEntry }
  | { kind: 'group'; key: string; entries: ChatEventEntry[]; narration: string | null };

/**
 * Can this entry be folded into a run? A file-edit call renders its own inline
 * diff, a `Monitor` call names the watcher it armed and a `view_file` is the
 * file itself, so each keeps its own row (`@patch/wire`'s `isGroupableToolCall`).
 */
function isGroupable(entry: ChatEventEntry): boolean {
  if (entry.kind === 'tool_result') return true;
  if (entry.kind !== 'tool_call') return false;
  // Shared with web and with the host that summarises each run.
  return isGroupableToolCall(entry.tool, entry.toolArgs);
}

/**
 * This call's own result, if it is the very next entry and shares its
 * `callId` — what a lone call's result looks like. A BATCH does not: the
 * agent emits every call and then every result, so a run of more than one
 * call folds into a `group` row above instead (mirrors web's `pairedResult`,
 * `packages/web/src/routes/ChatRoute.tsx`).
 */
export function pairedResult(timeline: ChatEventEntry[], i: number): ChatEventEntry | undefined {
  const call = timeline[i];
  const next = timeline[i + 1];
  if (!call || !next || next.kind !== 'tool_result') return undefined;
  if (!call.callId || call.callId !== next.callId) return undefined;
  return next;
}

/**
 * Fold each maximal consecutive run of groupable tool entries making MORE than
 * one call into a single row. Keys carry the entry's real index so they stay
 * unique when two entries share a seq (an optimistic entry and its echo). A
 * run of exactly one call folds its own result into the same row instead (Tom,
 * via screenshot: a lone call still rendered as two rows — "tool call appears
 * twice", the bug web already fixed) rather than leaving that result to be
 * emitted as its own row on the next iteration.
 */
export function groupToolRuns(timeline: ChatEventEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < timeline.length) {
    const entry = timeline[i];
    if (!entry) break;
    if (isGroupable(entry)) {
      let end = i;
      let calls = 0;
      for (let j = i; j < timeline.length; j++) {
        const next = timeline[j];
        if (!next || !isGroupable(next)) break;
        if (next.kind === 'tool_call') calls++;
        end = j + 1;
      }
      if (calls > 1) {
        rows.push({
          kind: 'group',
          key: `g-${entry.seq}-${i}`,
          entries: timeline.slice(i, end),
          narration: runNarration(timeline[i - 1]),
        });
        i = end;
        continue;
      }
      if (entry.kind === 'tool_call') {
        const result = pairedResult(timeline, i);
        if (result) {
          rows.push({ kind: 'entry', key: `${entry.seq}-${i}`, entry, result });
          i += 2;
          continue;
        }
      }
    }
    // A `view_file` is never grouped, but its row IS the file, so it still has
    // to take its own result: the ack carries the URL the row renders. Left
    // unpaired, the result became a separate "done" row and no file showed.
    if (entry.kind === 'tool_call' && isViewFileCall(entry)) {
      const result = pairedResult(timeline, i);
      if (result) {
        rows.push({ kind: 'entry', key: `${entry.seq}-${i}`, entry, result });
        i += 2;
        continue;
      }
    }
    rows.push({ kind: 'entry', key: `${entry.seq}-${i}`, entry });
    i++;
  }
  return rows;
}
