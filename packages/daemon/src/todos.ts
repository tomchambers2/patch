// patch/todo.md § Features to add — "todo list": a managing feature that keeps
// the agent focused. The agent tracks its work with Claude Code's native
// TodoWrite tool; the host observes those tool calls, mirrors the list onto
// chat state, and — when a turn settles with items still pending — fires the
// next pending item back into the chat as a fresh `[todo]` turn. Working the
// list one focused turn at a time is what stops the agent getting distracted.
//
// This module holds the two PURE pieces (no I/O), so they're trivially testable
// and the host wiring in chatRunner stays thin.

import type { TodoItem } from '@patch/wire';

/** Data marker on a fired todo turn — parity with `[wake]` (self-wake). */
export const TODO_PREFIX = '[todo] ';

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/**
 * Normalise a native TodoWrite tool call's args into our `TodoItem[]`, or
 * `null` when the args aren't the expected shape. NO FALLBACK: malformed input
 * is declined (the caller leaves the existing list untouched and logs), never
 * coerced into fabricated todos. TodoWrite's `activeForm` is dropped — the
 * host only needs the item text and its status.
 */
export function parseTodoWriteArgs(args: unknown): TodoItem[] | null {
  if (typeof args !== 'object' || args === null) return null;
  const raw = (args as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const content = (item as { content?: unknown }).content;
    const status = (item as { status?: unknown }).status;
    if (typeof content !== 'string' || content.trim() === '') return null;
    if (typeof status !== 'string' || !TODO_STATUSES.has(status)) return null;
    out.push({ text: content, status: status as TodoItem['status'] });
  }
  return out;
}

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
};

/**
 * Build the `<system-reminder>` block that tells the agent a surface rewrote its
 * task list (spec/02 § Task list), prefixed onto the chat's next turn. The
 * agent's native TodoWrite state can only be written by the agent itself, so
 * this is the entire mechanism: state the list, instruct it to adopt it. Item
 * text is JSON.stringify'd so quotes/newlines can't break the numbered list.
 */
export function buildTodoEditSystemReminder(todos: TodoItem[]): string {
  const body =
    todos.length === 0
      ? "The user emptied this chat's task list. Call TodoWrite with an empty list to match, then continue."
      : `The user edited this chat's task list. It is now, in order:\n${todos
          .map((t, i) => `${i + 1}. [${STATUS_LABEL[t.status]}] ${JSON.stringify(t.text)}`)
          .join(
            '\n',
          )}\nThis replaces your own list. Call TodoWrite with exactly these items and statuses before continuing, then work the list as usual.`;
  return `<system-reminder>\n${body}\n</system-reminder>\n\n`;
}

/**
 * The `<system-reminder>` that rides a fired `[todo]` turn (spec/02 § Task
 * list). Without it the turn is a bare `[todo] <text>` line that never tells the
 * agent the line IS one of its own TodoWrite items — so it does the work, never
 * calls TodoWrite, and the item reads `pending` for ever. Stripped from the
 * persisted/displayed user turn like every other leading reminder block.
 */
export function buildTodoFireSystemReminder(text: string): string {
  return (
    '<system-reminder>\n' +
    `This turn was fired from this chat's task list, from the item ${JSON.stringify(text)} — an ` +
    'item on your own TodoWrite list. Call TodoWrite to mark it in_progress now, and again to ' +
    'mark it completed the moment it is genuinely done; the list does not advance past it until ' +
    'you do. If you cannot finish it, leave it incomplete and say what you need.\n' +
    '</system-reminder>\n\n'
  );
}

export type AdvanceDecision =
  | { action: 'fire'; text: string }
  | { action: 'clear' }
  | { action: 'stalled'; text: string };

/**
 * Decide what to do with a chat's todo list when its turn settles.
 *
 * - No incomplete item left (or empty list) → `clear`: reset the fired-marker so
 *   a later list that reuses the same text can fire again.
 * - The head incomplete item is the one we already fired (`lastFired`) →
 *   `stalled`: a whole turn was spent on it and it came back incomplete (the
 *   agent likely asked the user a question / got stuck). Do NOT re-fire — that
 *   would nag the agent in a loop and steamroll the user's turn. Leave it for
 *   the user, but say on the list that it was started (`markTodoStarted`).
 * - Otherwise → `fire` the head incomplete item's text (progress was made, or
 *   nothing has been fired yet). `in_progress` counts as incomplete.
 */
export function selectNextTodo(todos: TodoItem[], lastFired: string | null): AdvanceDecision {
  const head = todos.find((t) => t.status !== 'completed');
  if (!head) return { action: 'clear' };
  if (head.text === lastFired) return { action: 'stalled', text: head.text };
  return { action: 'fire', text: head.text };
}

/**
 * Promote a stalled item from `pending` to `in_progress`, or `null` when there
 * is nothing to change. A turn was demonstrably spent on this item, so showing
 * it as `pending` — never started — is a lie. NO FALLBACK in the other
 * direction: an item is never marked `completed` on the host's say-so; only
 * the agent or the user closes one out.
 */
export function markTodoStarted(todos: TodoItem[], text: string): TodoItem[] | null {
  const index = todos.findIndex((t) => t.text === text && t.status === 'pending');
  if (index === -1) return null;
  return todos.map((t, i) => (i === index ? { ...t, status: 'in_progress' } : t));
}

/**
 * The `<system-reminder>` that tells the agent its chat's goal was set,
 * replaced or cleared (spec/04 § Goals; `null` = cleared). Prefixed onto its
 * next turn, once per change.
 */
export function buildGoalSystemReminder(goal: string | null): string {
  const body =
    goal === null
      ? "This chat's goal has been cleared: there is no longer a condition to meet, and nothing is evaluating your turns against one."
      : `A goal has been set on this chat: ${goal}\nKeep working until this condition is met. After each turn the host checks it and will send you back if it is not yet satisfied. If it can never be met, say so plainly.`;
  return `<system-reminder>\n${body}\n</system-reminder>\n\n`;
}

/**
 * The `<system-reminder>` that tells the agent its chat was hidden or shown
 * (spec/04 § Hidden), prefixed onto its next turn like a permission-mode
 * change is surfaced: the agent keeps working either way, it just knows
 * whether the user is watching the chat in their list.
 */
export function buildHiddenSystemReminder(state: 'hidden' | 'shown'): string {
  const body =
    state === 'hidden'
      ? 'This chat is now in hidden mode: the user has moved it out of their chat list. You are still running and nothing about the task changes, but they are not watching. Use patch_ask_human if you need them, or patch_report for something worth seeing; either brings the chat back into the list.'
      : "This chat is no longer in hidden mode: it is back in the user's chat list and they may be reading along.";
  return `<system-reminder>\n${body}\n</system-reminder>\n\n`;
}
