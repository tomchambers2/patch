// A goal resolving met/impossible (spec/04 § Goals). Unlike a background-task
// notice (background-task.ts), this format is entirely Patch's own on both
// ends — the host writes it, a surface reads it — so it needs no tolerance
// for natural-language phrasing; a plain fixed prefix is enough.

export interface GoalOutcomeNotice {
  outcome: 'met' | 'impossible';
  reason: string;
}

const OUTCOME_LINE = /^\[goal: (met|impossible)\]\n([\s\S]*)$/;

/**
 * Recover a goal outcome's structure from a system-role message's content, or
 * `null` when it is not one — an ordinary system message stays an ordinary
 * system message.
 */
export function parseGoalOutcome(content: string): GoalOutcomeNotice | null {
  const m = OUTCOME_LINE.exec(content);
  if (!m) return null;
  return { outcome: m[1] as 'met' | 'impossible', reason: (m[2] ?? '').trim() };
}
