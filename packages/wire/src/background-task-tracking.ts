// Background-task tracking — which of a chat's background commands and
// sub-agents are still running (spec/02 § Background task completions,
// spec/14 § Main chat panel — Background task bar, spec/14 § Status badges).
//
// The agent can launch a shell command (`Bash`) or a sub-agent (`Task`) with
// `run_in_background`, and that work outlives the turn that started it — so the
// chat can be idle with something still in flight. Nothing on the wire is a
// background-task record, so the state is read off the chat's own stream:
//
//   Bash/Task call with run_in_background → running
//   its tool result                       → carries the background id
//   matching completion notice            → ended
//   KillShell / TaskStop naming that id   → ended, killed
//
// This lives in `@patch/wire` rather than in either surface because TWO readers
// need the identical answer and they read it from different ends of the same
// stream: the host folds its own outgoing events as they are emitted (so a
// chat's running count can ride on `chat.state` and reach a sidebar that holds
// no transcript at all), and the web surface folds the timeline it already has
// (so the open chat's bar can name each task). A second implementation of the
// pairing rules would be two answers to one question, and the one the sidebar
// showed would be the one nobody could check.
//
// A task that has ended is KEPT, carrying how it ended, rather than spliced
// away: the bar lists ended tasks behind its Show all checkbox (spec/14), and a
// list that forgets them has nothing to show there.
//
// How an end is attributed to a launch depends on what the end arrived as, and
// the two paths are not equally well identified. A raw `<task-notification>`
// block — replay, and any host on a host that predates the lifting — names
// the launching tool call outright in `<tool-use-id>` and the background id in
// `<task-id>`, so it is attributed EXACTLY. A block the host has already
// lifted to its summary sentence (spec/02 § Background task completions) has
// been reduced to prose: the sentence names the task by the description the
// agent gave it and carries no id of any kind, so description is all there is
// to pair on, and two live tasks sharing one are closed oldest-first so the
// count still nets out.
//
// Where a block names ids AND they match, they win over the sentence: an id is
// an answer and a name is only a resemblance, so a block whose sentence and
// whose `<tool-use-id>` point at different live tasks closes the one the id
// names. Where its ids match nothing here — a launch outside this transcript,
// or one whose result never reported an id — it falls back to the sentence, but
// that is the SAME description pairing every lifted notice uses, not a second
// weaker guess bolted on.
//
// NO FALLBACK past that point, and the two rules that enforce it are worth
// stating: a notice that matches no launch by either route closes nothing, and
// is never attributed to whatever happens to be running; and a notice that
// reports no end at all ends nothing — a `Monitor` event block has exactly this
// shape, a task id and a summary, and is a watcher reporting a line of output
// rather than a task finishing.

import {
  parseBackgroundTaskNotice,
  parseTaskNotificationBlock,
  taskNotificationSummary,
  type BackgroundTaskNotice,
} from './background-task.js';

export type BackgroundTaskKind = BackgroundTaskNotice['kind'];

/**
 * The bit of a chat stream entry this fold reads — a structural subset of both
 * the web store's `ChatEventEntry` and the host's own outgoing events, so
 * each side passes what it already holds rather than converting to a third
 * shape. Anything not named here is not consulted.
 */
export interface BackgroundTaskEntry {
  /** Transcript position. Orders the list and nothing else. */
  seq: number;
  /** Which kind of stream item this is; only these three are consulted. */
  kind: 'message' | 'tool_call' | 'tool_result' | (string & {});
  /** Tool name on a `tool_call`. */
  tool?: string | undefined;
  /** The tool call's id, on a `tool_call` and on its matching `tool_result`. */
  callId?: string | undefined;
  /** The tool call's arguments, on a `tool_call`. */
  toolArgs?: unknown;
  /** What the call returned, on a `tool_result`. */
  toolResult?: unknown;
  /** The message text, on a `message`. */
  content?: string | undefined;
}

export interface BackgroundTaskRow {
  /** The launching tool call's id — stable identity for the task. */
  callId: string;
  /** A shell command run in the background, or a sub-agent. */
  kind: BackgroundTaskKind;
  /** The description the agent gave it; what a completion notice names it by. */
  description: string;
  /** What to show — the description, else the command / sub-agent it runs. */
  label: string;
  /** The background id, once the launch's own result reports it. */
  taskId: string | null;
  /** Transcript position — orders the list newest-first. */
  seq: number;
  /** Null while the task is running; how it ended once it has. */
  ended: BackgroundTaskEnd | null;
}

/** How a background task ended, taken from whatever reported the end. */
export interface BackgroundTaskEnd {
  /** The end's own word for itself — `completed`, `failed`, `stopped`, `killed`. */
  status: string;
  /** The process exit code, where the end reported one. A sub-agent has none. */
  exitCode: number | null;
  /** Transcript position of the end — orders ended tasks most-recently-ended first. */
  seq: number;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function argsOf(entry: BackgroundTaskEntry): Record<string, unknown> {
  const a = entry.toolArgs;
  return typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
}

/** `Bash` backgrounds a command; `Task` backgrounds a sub-agent. */
function launchKind(tool: string | undefined): BackgroundTaskKind | null {
  if (tool === 'Bash') return 'command';
  if (tool === 'Task') return 'agent';
  return null;
}

/**
 * The background id out of the launch's own result. The two kinds of launch
 * report it differently and neither spelling is optional:
 *
 *   Bash  → `Command running in background with ID: baiw888mq.`
 *   Task  → `agentId: a94ad268600127112 (internal ID - do not mention to user...)`
 *
 * A sub-agent's id is the one `TaskStop` names and the one its output file is
 * called after, so missing it cost the row its kill, its measurement and its
 * terminal all at once. The patterns are tried in order rather than merged into
 * one alternation, because an alternation matches at the EARLIEST position in
 * the text and a sub-agent's result mentions `agentId` in prose before it
 * states one. `task <id>` is the `Monitor` tool's spelling for the same thing.
 */
// No `\b` on `agentId`: a Task result arrives as content blocks rather than a
// string, so it is read as JSON, where the newline before it is the two
// characters `\` and `n` and the `n` leaves no word boundary at all.
const ID_PATTERNS = [
  /agentId:\s*([A-Za-z0-9_-]+)/,
  /\bID:\s*([A-Za-z0-9_-]+)/,
  /\btask\s+([A-Za-z0-9_-]+)/,
];

function backgroundId(result: unknown): string | null {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  for (const pattern of ID_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return m[1] as string;
  }
  return null;
}

/**
 * A message's completion notice, whether the host already lifted it to its
 * summary sentence (the live path) or it still carries the whole raw block
 * (replay, and hosts on an older host). Not a notice at all → `null`.
 */
function noticeOf(entry: BackgroundTaskEntry): BackgroundTaskNotice | null {
  if (entry.kind !== 'message') return null;
  const content = entry.content ?? '';
  return parseBackgroundTaskNotice(taskNotificationSummary(content) ?? content);
}

/**
 * What a message says ENDED a task, or `null` when it does not say a task
 * ended. Either half of the notice can name the outcome: the raw block carries
 * it as a `<status>` tag, and the lifted sentence carries it in prose along
 * with an exit code where the task was a process.
 *
 * A notification block that names no outcome at all is not an end. A `Monitor`
 * event block is exactly that shape — a task id, a summary, and an event — and
 * it is a watcher reporting a line of output, not a task finishing.
 */
function endOf(
  block: { status: string | null } | null,
  notice: BackgroundTaskNotice | null,
  seq: number,
): BackgroundTaskEnd | null {
  const status = block?.status ?? notice?.status ?? null;
  if (status === null) return null;
  return { status, exitCode: notice?.exitCode ?? null, seq };
}

/** The id a `KillShell` / `TaskStop` call is ending. */
function killedId(entry: BackgroundTaskEntry): string | null {
  const args = argsOf(entry);
  const id = str(args, 'shell_id') || str(args, 'task_id') || str(args, 'taskId');
  return id === '' ? null : id;
}

/**
 * Fold ONE stream entry into a running list of this chat's background tasks,
 * in place.
 *
 * Entries must arrive in transcript order, which is what makes an end able to
 * close only a launch that came before it and never re-close a task that has
 * already ended. Both callers satisfy that naturally — the host emits in
 * order, and a surface's timeline is held in order.
 *
 * Exposed as the single-entry step rather than only as the whole-transcript
 * walk below because the host has no transcript in memory to re-walk: it sees
 * each event once, as it emits it, and keeps the rows.
 */
export function applyBackgroundTaskEntry(
  rows: BackgroundTaskRow[],
  entry: BackgroundTaskEntry,
): void {
  const open = (): BackgroundTaskRow[] => rows.filter((r) => r.ended === null);

  if (entry.kind === 'tool_call') {
    const kind = launchKind(entry.tool);
    if (kind && entry.callId && argsOf(entry)['run_in_background'] === true) {
      const args = argsOf(entry);
      const description = str(args, 'description');
      rows.push({
        callId: entry.callId,
        kind,
        description,
        label:
          description || (kind === 'command' ? str(args, 'command') : str(args, 'subagent_type')),
        taskId: null,
        seq: entry.seq,
        ended: null,
      });
      return;
    }
    if (entry.tool === 'KillShell' || entry.tool === 'TaskStop') {
      const id = killedId(entry);
      const row = id === null ? undefined : open().find((r) => r.taskId === id);
      // The call names the id and nothing else, so it is the whole of the
      // pairing: a kill for an id this chat never saw reported closes nothing.
      if (row) row.ended = { status: 'killed', exitCode: null, seq: entry.seq };
    }
    return;
  }

  if (entry.kind === 'tool_result' && entry.callId) {
    const row = rows.find((r) => r.callId === entry.callId);
    if (row && row.taskId === null) row.taskId = backgroundId(entry.toolResult);
    return;
  }

  if (entry.kind !== 'message') return;
  const block = parseTaskNotificationBlock(entry.content ?? '');
  const notice = noticeOf(entry);
  const end = endOf(block, notice, entry.seq);
  if (end === null) return;

  // An end that names ids is answered by those ids first, because an id is an
  // answer and a name is a resemblance. One block can end several tasks at
  // once: the sweep a session runs at start-up marks every task the previous
  // session left unfinished and reports them together, one `<task-id>` each.
  if (block !== null) {
    const named = open().filter(
      (row) =>
        (block.toolUseId !== null && row.callId === block.toolUseId) ||
        (row.taskId !== null && block.taskIds.includes(row.taskId)),
    );
    if (named.length > 0) {
      for (const row of named) row.ended = end;
      return;
    }
  }

  // Nothing usable but the sentence, so nothing but the description — the
  // pairing every lifted notice uses, reached here either because the host
  // lifted this one or because the block's ids name a launch this transcript
  // does not hold. The oldest match closes, so N launches sharing a
  // description and M completions of it leave N−M running. This is NOT a
  // guess at an unmatched notice: a notice whose description matches nothing
  // closes nothing, and stays that way.
  if (notice) {
    const row = open().find((r) => r.kind === notice.kind && r.description === notice.description);
    if (row) row.ended = end;
  }
}

/**
 * The list a surface draws: still-running first, newest first, then the ones
 * that have ended, most recently ended first.
 */
export function sortBackgroundTasks(rows: readonly BackgroundTaskRow[]): BackgroundTaskRow[] {
  const running = rows.filter((r) => r.ended === null).sort((a, b) => b.seq - a.seq);
  const ended = rows
    .filter((r) => r.ended !== null)
    .sort((a, b) => (b.ended as BackgroundTaskEnd).seq - (a.ended as BackgroundTaskEnd).seq);
  return [...running, ...ended];
}

/**
 * Every background task a chat has launched, folded from its whole transcript
 * and ordered for display. The walk is in transcript order, so an end can only
 * ever close a launch that came before it.
 */
export function deriveBackgroundTasks(
  entries: readonly BackgroundTaskEntry[],
): BackgroundTaskRow[] {
  const rows: BackgroundTaskRow[] = [];
  for (const entry of entries) applyBackgroundTaskEntry(rows, entry);
  return sortBackgroundTasks(rows);
}

/** How many of these tasks are still running. */
export function countRunningBackgroundTasks(rows: readonly BackgroundTaskRow[]): number {
  let n = 0;
  for (const row of rows) if (row.ended === null) n += 1;
  return n;
}
