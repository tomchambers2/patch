// patch/todo.md — Reminders. Typing `/remind <text>` in the composer sets the
// chat's reminder instead of sending a message; the reminder then shows at the
// top of the chat (ReminderBanner). A bare `/remind` (no text) CLEARS it.
//
// This is a pure parse so it's unit-testable in isolation and the composer's
// send path stays a thin dispatch. `/remind` is matched case-insensitively on
// the command word only; the reminder text itself is preserved verbatim (trimmed).

export interface ReminderCommand {
  /** True when the message is a `/remind` command (and NOT a normal chat turn). */
  isReminder: boolean;
  /** The reminder to set — `null` clears it. Only meaningful when `isReminder`. */
  reminder: string | null;
}

const NOT_REMINDER: ReminderCommand = { isReminder: false, reminder: null };

/**
 * Parse a composer message. Returns `{ isReminder: true, reminder }` when the
 * message is a `/remind` command — `reminder` is the trimmed text after the
 * command, or `null` when nothing followed (a clear). Any other message →
 * `isReminder: false`.
 */
export function parseReminderCommand(message: string): ReminderCommand {
  const m = /^\/remind(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!m) return NOT_REMINDER;
  const rest = (m[1] ?? '').trim();
  return { isReminder: true, reminder: rest.length > 0 ? rest : null };
}
