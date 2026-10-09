// spec/14 ## Main chat panel — a tool call's one-line summary says what the
// call is DOING, not just which tool ran. ONE derivation feeds both surfaces of
// that rule: an ungrouped tool-call row's own summary and a collapsed run's
// per-call labels. They used to disagree (the run named its target, the single
// row was name-only), which is exactly the split this module exists to prevent.
//
// `apps/mobile/src/lib/toolSummary.ts` is a deliberate mirror of this file —
// the two surfaces share no code of their own (same arrangement as
// `deliveryTracker.ts`), only primitives out of `@patch/wire` like
// `folderName` — so a rule changed here has to be changed there too.

import { folderName } from '@patch/wire';

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
