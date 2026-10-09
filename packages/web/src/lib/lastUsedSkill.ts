// Per-folder last-used skill, so pressing `/` in the composer preselects the
// skill you last ran in that folder (spec/14 § Skill autocomplete). This is
// ORDERING ONLY — the fetched skill set and the typed prefix filter are
// untouched.
//
// One localStorage key per folder (no JSON blob to parse, so no corrupt-value
// branch to swallow). A stored name that is no longer in the folder's list
// simply doesn't match and the list keeps its natural order — a legitimate
// first-run / removed-skill state, not a hidden error.

const LAST_USED_SKILL_PREFIX = 'patch.skill.lastUsed:';

/** The skill last completed in `folder`, or null if there isn't one yet. */
export function getLastUsedSkill(folder: string): string | null {
  if (folder === '') return null;
  const raw = localStorage.getItem(LAST_USED_SKILL_PREFIX + folder);
  return raw !== null && raw !== '' ? raw : null;
}

/**
 * Remember the skill just completed in `folder`. An unknown folder ('' — the
 * composer has no folder) or an empty name is ignored: there is nothing a later
 * lookup could do with it.
 */
export function setLastUsedSkill(folder: string, name: string): void {
  if (folder === '' || name === '') return;
  localStorage.setItem(LAST_USED_SKILL_PREFIX + folder, name);
}

/**
 * `skills` with `last` moved to the front (it becomes the highlighted default).
 * A null `last`, or one absent from the list, leaves the order untouched.
 */
export function orderSkillsByLastUsed(skills: string[], last: string | null): string[] {
  if (last === null || !skills.includes(last)) return skills;
  return [last, ...skills.filter((s) => s !== last)];
}
