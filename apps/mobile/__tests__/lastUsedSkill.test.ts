// spec/15 § Skill autocomplete — "the list defaults to the last-used skill".
// Per-folder MMKV persistence + the ordering rule the composer feeds it into.

import { describe, it, expect, beforeEach } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import { store } from '../src/lib/credential';
import {
  getLastUsedSkill,
  setLastUsedSkill,
  orderSkillsByLastUsed,
} from '../src/lib/lastUsedSkill';

beforeEach(() => {
  __clearAllMmkv();
});

describe('lastUsedSkill', () => {
  it('round-trips per folder and overwrites on the next completion', () => {
    expect(getLastUsedSkill('work')).toBeNull();
    setLastUsedSkill('work', 'plant');
    setLastUsedSkill('elsewhere', 'deploy');
    expect(getLastUsedSkill('work')).toBe('plant');
    expect(getLastUsedSkill('elsewhere')).toBe('deploy');
    setLastUsedSkill('work', 'plan-travel');
    expect(getLastUsedSkill('work')).toBe('plan-travel');
  });

  it('ignores an empty folder or an empty skill name', () => {
    setLastUsedSkill('', 'plant');
    setLastUsedSkill('work', '');
    expect(getLastUsedSkill('')).toBeNull();
    expect(getLastUsedSkill('work')).toBeNull();
  });

  it('treats a blank stored value as "none"', () => {
    store().set('patch.skill.lastUsed:work', '');
    expect(getLastUsedSkill('work')).toBeNull();
  });

  it('sorts the last-used skill to the top, keeping the rest in order', () => {
    expect(orderSkillsByLastUsed(['plant', 'plan-travel', 'deploy'], 'deploy')).toEqual([
      'deploy',
      'plant',
      'plan-travel',
    ]);
  });

  it('leaves the order untouched with no last-used skill or one not in the list', () => {
    const skills = ['plant', 'deploy'];
    expect(orderSkillsByLastUsed(skills, null)).toEqual(['plant', 'deploy']);
    expect(orderSkillsByLastUsed(skills, 'retired')).toEqual(['plant', 'deploy']);
  });
});
