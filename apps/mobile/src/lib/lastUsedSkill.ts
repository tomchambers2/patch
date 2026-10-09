// Per-folder last-used skill, so the `/` menu defaults to the skill you last
// ran in that folder (spec/15 § Skill autocomplete). Mirrors the web module of
// the same name; persistence is MMKV (the same store the credential uses).
//
// ORDERING ONLY — the fetched skill set and the typed filter are untouched. One
// key per folder (no JSON blob to parse). A stored name no longer in the
// folder's list simply doesn't match and the order is left alone: a legitimate
// first-run / removed-skill state, not a hidden error.

import { store } from './credential';

const LAST_USED_SKILL_PREFIX = 'patch.skill.lastUsed:';

/** The skill last completed in `folder`, or null if there isn't one yet. */
export function getLastUsedSkill(folder: string): string | null {
  if (folder === '') return null;
  const v = store().getString(LAST_USED_SKILL_PREFIX + folder);
  return v !== undefined && v !== '' ? v : null;
}

/**
 * Remember the skill just completed in `folder`. An empty folder (the composer
 * has none) or an empty name is ignored — nothing could later read it back.
 */
export function setLastUsedSkill(folder: string, name: string): void {
  if (folder === '' || name === '') return;
  store().set(LAST_USED_SKILL_PREFIX + folder, name);
}

/**
 * `skills` with `last` moved to the front (the default the user sees first). A
 * null `last`, or one absent from the list, leaves the order untouched.
 */
export function orderSkillsByLastUsed(skills: string[], last: string | null): string[] {
  if (last === null || !skills.includes(last)) return skills;
  return [last, ...skills.filter((s) => s !== last)];
}
