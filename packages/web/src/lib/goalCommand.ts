// patch/todo.md — `/goal` slash command. Typing `/goal <text>` in the composer
// sets the chat's goal instead of sending a message; the goal then shows at the
// top of the chat (GoalBanner). A bare `/goal` (no text) CLEARS the goal.
//
// This is a pure parse so it's unit-testable in isolation and the composer's
// send path stays a thin dispatch. `/goal` is matched case-insensitively on the
// command word only; the goal text itself is preserved verbatim (trimmed).

export interface GoalCommand {
  /** True when the message is a `/goal` command (and NOT a normal chat turn). */
  isGoal: boolean;
  /** The goal to set — `null` clears it. Only meaningful when `isGoal`. */
  goal: string | null;
}

const NOT_GOAL: GoalCommand = { isGoal: false, goal: null };

/**
 * Parse a composer message. Returns `{ isGoal: true, goal }` when the message
 * is a `/goal` command — `goal` is the trimmed text after the command, or
 * `null` when nothing followed (a clear). Any other message → `isGoal: false`.
 */
export function parseGoalCommand(message: string): GoalCommand {
  const m = /^\/goal(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!m) return NOT_GOAL;
  const rest = (m[1] ?? '').trim();
  return { isGoal: true, goal: rest.length > 0 ? rest : null };
}

/** The built-in command entry for the slash-command autocomplete dropdown. */
export const GOAL_COMMAND_NAME = 'goal';
export const GOAL_COMMAND_DESCRIPTION = 'Set the chat goal; bare /goal clears it';
