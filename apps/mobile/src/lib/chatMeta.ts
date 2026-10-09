// Optimistic writes for a chat's own settings — goal, reminder, task list and
// the special-thread Disable switch. Same routes and the same contract as web
// (GoalBanner / ReminderBanner / TaskBar / ChatHeader's toggleDisabled): the
// store flips at once, and a refused request puts the previous value back AND
// says so in an error toast. Never a silent revert, never a silent success.

import type { TodoItem } from '@patch/wire';
import { api } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';

function row(chatId: string) {
  const r = useChatStore.getState().chats[chatId];
  if (!r) throw new Error(`chat ${chatId} is not loaded`);
  return r;
}

function fail(what: string, e: unknown): void {
  useUiStore.getState().pushError(`${what} failed: ${(e as Error).message}`);
}

/** Set (text) or clear (`null`) the chat's goal. */
export async function writeGoal(chatId: string, next: string | null): Promise<void> {
  const prev = row(chatId).goal;
  useChatStore.getState().setGoal(chatId, next);
  try {
    await api.setGoal(chatId, next);
  } catch (e) {
    useChatStore.getState().setGoal(chatId, prev);
    fail(next === null ? 'clearing goal' : 'updating goal', e);
  }
}

/** Set (text) or clear (`null`) the chat's reminder. */
export async function writeReminder(chatId: string, next: string | null): Promise<void> {
  const prev = row(chatId).reminder;
  useChatStore.getState().setReminder(chatId, next);
  try {
    await api.setReminder(chatId, next);
  } catch (e) {
    useChatStore.getState().setReminder(chatId, prev);
    fail(next === null ? 'clearing reminder' : 'updating reminder', e);
  }
}

/**
 * Re-arm a chat's loop wake with new text, same interval. Not optimistic: the
 * host echoes `chat.state` with the new wake, which is what the bar shows.
 * Returns whether the write was accepted.
 */
export async function writeLoopMessage(
  chatId: string,
  message: string,
  everyMs: number,
): Promise<boolean> {
  try {
    await api.setLoop(chatId, { message, every: Math.round(everyMs / 1000) });
    return true;
  } catch (e) {
    fail('updating wake', e);
    return false;
  }
}

/** Replace the chat's task list — always the WHOLE list, as the host expects. */
export async function writeTodos(chatId: string, next: TodoItem[]): Promise<void> {
  const prev = row(chatId).todos;
  useChatStore.getState().setTodos(chatId, next);
  try {
    await api.setTodos(chatId, next);
  } catch (e) {
    useChatStore.getState().setTodos(chatId, prev);
    fail('updating tasks', e);
  }
}

/** Turn a special thread off or back on (spec/06 § Disabled). */
export async function toggleDisabled(chatId: string): Promise<void> {
  const next = !row(chatId).disabled;
  useChatStore.getState().setDisabled(chatId, next);
  try {
    await api.disableChat(chatId, next);
  } catch (e) {
    useChatStore.getState().setDisabled(chatId, !next);
    fail(next ? 'disable' : 'enable', e);
  }
}

/**
 * Manual session rotation (spec/06 § Session rotation), same route as web's
 * `ChatHeader.clearContext`: retire the special thread's Claude session and
 * start fresh, seeded with a handoff digest. No optimistic flip — there's no
 * boolean to show — the host posts its own "Session rotated" system message
 * into the transcript once it happens, and a refusal (mid-turn, digest
 * failure) is logged server-side rather than answered here.
 */
export async function clearContext(chatId: string): Promise<void> {
  try {
    await api.rotateChat(chatId);
  } catch (e) {
    fail('clear context', e);
  }
}

/** pending → in progress → done → pending: one control covers the lifecycle. */
export const NEXT_TODO_STATUS: Record<TodoItem['status'], TodoItem['status']> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending',
};

export const TODO_STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'done',
};

/**
 * The collapsed task bar's one line: the item in progress, else the next
 * pending one; `null` once everything is done. Plus the done count.
 */
export function todoSummary(todos: TodoItem[]): { head: string | null; done: number } {
  const done = todos.filter((t) => t.status === 'completed').length;
  const head =
    todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'completed');
  return { head: head ? head.text : null, done };
}
