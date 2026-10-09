// Background-task completion notices (spec/02 § Background task completions,
// spec/14 § Background task completions).
//
// A background task finishing is reported by the agent layer as a
// `<task-notification>` block on an otherwise chat-invisible user message. The
// host lifts the block's `<summary>` — an already-readable sentence — onto
// the transcript as a system message, and surfaces recover the structure from
// that sentence to render it.
//
// The summary is the contract between the two, so it is passed through
// verbatim rather than reformatted: a surface that does not know about
// background tasks still shows a sentence that reads correctly on its own.

/** A background task the agent layer ran and has now finished. */
export interface BackgroundTaskNotice {
  /** A shell command run in the background, or a sub-agent. */
  kind: 'command' | 'agent';
  /** What the task was for, as the agent described it when launching it. */
  description: string;
  /** How it ended — `completed` is the common case, but never the only one. */
  status: string;
  /** Process exit code; `null` when the task is not a process (an agent). */
  exitCode: number | null;
}

const NOTIFICATION_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>/;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
const TASK_ID = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/g;
const TOOL_USE_ID = /<tool-use-id>\s*([A-Za-z0-9_-]+)\s*<\/tool-use-id>/;
const STATUS = /<status>\s*([a-z][a-z-]*)\s*<\/status>/;

/**
 * How a summary sentence spells out the end of the task it names.
 *
 * THE TAIL IS NOT ENUMERATED, deliberately. The previous grammar listed the
 * wordings it knew — `failed with exit code N`, `was stopped[ by Claude]`, and
 * a SINGLE lowercase word with an optional exit code — and claimed that last
 * branch made it permissive. It did not: it capped the outcome at one word, so
 * any multi-word phrase fell through, `parseBackgroundTaskNotice` returned
 * null, and on the live path (where the host lifts the block to its sentence
 * and drops the authoritative `<status>` tag — sdkBackend.ts, `type === 'user'`)
 * NOTHING was left that could end the task. It then read as running for the
 * rest of the chat's life.
 *
 * Seen 2026-09-15, in a real session, twice:
 *
 *   Background agent "<name>" didn't finish before the previous session ended
 *
 * — which missed on BOTH counts: the prefix is `Background agent "`, not
 * `Agent "`, and the tail is a sentence, not a word.
 *
 * So: the anchors are the prefix and the quoted description, and ANY non-empty
 * tail ends the task. The wordings we can read exactly still yield their exact
 * status and exit code; one we cannot still ends its task, under the honest
 * status `ended`. An unknown phrasing must never be able to pin a task open
 * again — that is the whole point of this grammar.
 */
const OUTCOME = String.raw`.+`;

// The description is matched greedily so a description containing its own
// quotes still resolves — it runs to the LAST `" ` in the sentence, and what
// follows is the outcome.
const COMMAND = new RegExp(String.raw`^Background command "(.+)" (${OUTCOME})$`);
// Both spellings the agent layer uses for a sub-agent.
const AGENT = new RegExp(String.raw`^(?:Background a|A)gent "(.+)" (${OUTCOME})$`);

const FAILED_WITH_EXIT = /^failed with exit code (-?\d+)$/;
const WAS_STOPPED = /^was stopped(?: by Claude)?$/;
const WORD_WITH_EXIT = /^([a-z][a-z-]*)(?: \(exit code (-?\d+)\))?$/;

/**
 * The status and exit code inside an outcome tail the patterns above have
 * already matched, so this is a re-read of known-good text rather than a second
 * validation. `was stopped by Claude` and `was stopped` are one end, not two —
 * they both land on the word the block's own `<status>` tag uses.
 */
function readOutcome(tail: string): { status: string; exitCode: number | null } {
  const failed = FAILED_WITH_EXIT.exec(tail);
  if (failed) return { status: 'failed', exitCode: Number(failed[1]) };
  if (WAS_STOPPED.test(tail)) return { status: 'stopped', exitCode: null };
  const word = WORD_WITH_EXIT.exec(tail);
  if (word) {
    return {
      status: word[1] as string,
      exitCode: word[2] === undefined ? null : Number(word[2]),
    };
  }
  // A phrase we have no reading for. It still ENDED the task — that is what the
  // sentence is for — so say `ended` rather than inventing one of the four
  // statuses we would only be guessing at. NO FALLBACK: guessing `completed`
  // here would report a task that died as having succeeded.
  return { status: 'ended', exitCode: null };
}

/** The identity a raw `<task-notification>` block carries and its summary does not. */
export interface TaskNotificationBlock {
  /** The launching tool call's id — exact identity, where the block names one. */
  toolUseId: string | null;
  /** Every background id the block ends; one per task, and a sweep ends several. */
  taskIds: string[];
  /** The block's own word for how the task ended. */
  status: string | null;
}

/**
 * Whether a message's text carries a `<task-notification>` block at all.
 *
 * Surfaces need this on its own, separately from the summary: the host only
 * lifts the block on the LIVE path, so replay — and any host whose host
 * predates that lifting — hands the whole raw block over as a user message. A
 * surface that can spot one renders it as the completion it is instead of as a
 * turn the user typed, and it can do that for a block with no summary too.
 */
export function hasTaskNotification(text: string): boolean {
  return NOTIFICATION_BLOCK.test(text);
}

/**
 * The chat-visible sentence inside a `<task-notification>` block, or `null`
 * when the text carries no such block. A block with no `<summary>` also yields
 * `null` — there is nothing to show, and inventing a sentence would hide that.
 */
export function taskNotificationSummary(text: string): string | null {
  if (!NOTIFICATION_BLOCK.test(text)) return null;
  const summary = SUMMARY.exec(text);
  if (!summary?.[1]) return null;
  const trimmed = summary[1].trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Recover a notice's structure from its summary sentence, or `null` when the
 * sentence is not one — an ordinary system message stays an ordinary system
 * message.
 */
export function parseBackgroundTaskNotice(summary: string): BackgroundTaskNotice | null {
  const command = COMMAND.exec(summary);
  if (command) {
    return {
      kind: 'command',
      description: command[1] as string,
      ...readOutcome(command[2] as string),
    };
  }
  const agent = AGENT.exec(summary);
  if (agent) {
    // A sub-agent is not a process, so it has no exit code of its own even
    // where its wording borrowed one.
    return {
      kind: 'agent',
      description: agent[1] as string,
      status: readOutcome(agent[2] as string).status,
      exitCode: null,
    };
  }
  return null;
}

/**
 * The structure of a raw `<task-notification>` block, or `null` when the text
 * carries no such block.
 *
 * A summary sentence names its task by description and nothing else, which is
 * the only identity it and the launch share. The raw block is richer: its
 * `<tool-use-id>` IS the id of the tool call that launched the task, and its
 * `<task-id>` is the background id. So wherever a surface is handed the block
 * rather than the lifted sentence — replay, and any host on a host that
 * predates the lifting — it can attribute the end exactly instead of by name,
 * and it can attribute one that has no readable sentence at all.
 */
export function parseTaskNotificationBlock(text: string): TaskNotificationBlock | null {
  const block = NOTIFICATION_BLOCK.exec(text);
  if (!block) return null;
  const body = block[0];
  const status = STATUS.exec(body);
  return {
    toolUseId: TOOL_USE_ID.exec(body)?.[1] ?? null,
    taskIds: [...body.matchAll(TASK_ID)].map((m) => m[1] as string),
    status: status?.[1] ?? null,
  };
}
