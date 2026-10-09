// spec/14 § Skill autocomplete — "the list defaults to the last-used skill".
// Per-folder persistence + the ordering rule it feeds.

import { describe, it, expect, beforeEach } from 'vitest';
import { getLastUsedSkill, setLastUsedSkill, orderSkillsByLastUsed } from '../lib/lastUsedSkill';

describe('lastUsedSkill', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips the last used skill per folder', () => {
    expect(getLastUsedSkill('/proj')).toBeNull();
    setLastUsedSkill('/proj', 'plant');
    setLastUsedSkill('/other', 'deploy');
    expect(getLastUsedSkill('/proj')).toBe('plant');
    expect(getLastUsedSkill('/other')).toBe('deploy');
    // Overwritten by the next completion.
    setLastUsedSkill('/proj', 'plan-travel');
    expect(getLastUsedSkill('/proj')).toBe('plan-travel');
  });

  it('ignores an empty folder or an empty skill name, and reads them back as null', () => {
    setLastUsedSkill('', 'plant');
    setLastUsedSkill('/proj', '');
    expect(getLastUsedSkill('')).toBeNull();
    expect(getLastUsedSkill('/proj')).toBeNull();
  });

  it('treats an empty stored value as "none"', () => {
    localStorage.setItem('patch.skill.lastUsed:/proj', '');
    expect(getLastUsedSkill('/proj')).toBeNull();
  });

  it('sorts the last-used skill to the top, preserving the rest of the order', () => {
    expect(orderSkillsByLastUsed(['plant', 'plan-travel', 'deploy'], 'deploy')).toEqual([
      'deploy',
      'plant',
      'plan-travel',
    ]);
  });

  it('leaves the order untouched with no last-used skill or one not in the list', () => {
    const skills = ['plant', 'deploy'];
    expect(orderSkillsByLastUsed(skills, null)).toEqual(['plant', 'deploy']);
    expect(orderSkillsByLastUsed(skills, 'retired-skill')).toEqual(['plant', 'deploy']);
  });
});
