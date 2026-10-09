// spec/14 § Skill autocomplete — the menu matches any part of a skill name, not
// just its start (Tom, Patch Updates).

import { describe, it, expect } from 'vitest';
import { matchTier, rankByQuery } from '../lib/skillMatch.js';

describe('matchTier', () => {
  it('ranks a prefix above a mid-name hit above a loose one', () => {
    expect(matchTier('deploy-pending', 'dep')).toBe(0);
    expect(matchTier('deploy-pending', 'pending')).toBe(1);
    expect(matchTier('deploy-pending', 'dpg')).toBe(2);
  });

  it('finds the word that actually identifies the skill', () => {
    // The distinguishing word of a kebab-cased name is rarely the first one.
    expect(matchTier('weekly-timesheet', 'timesheet')).toBe(1);
    expect(matchTier('app-update-catchup', 'catchup')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(matchTier('Weekly-Timesheet', 'TIMEsheet')).toBe(1);
  });

  it('matches everything on an empty query, so `/` lists the menu', () => {
    expect(matchTier('anything', '')).toBe(0);
  });

  it('returns null when the letters are absent or out of order', () => {
    expect(matchTier('deploy', 'zzz')).toBeNull();
    expect(matchTier('deploy', 'yold')).toBeNull();
  });
});

describe('rankByQuery', () => {
  const skills = ['app-update', 'deploy', 'deploy-pending', 'weekly-timesheet'];

  it('puts prefix matches first and keeps the caller order within a tier', () => {
    expect(rankByQuery(skills, 'dep', (s) => s)).toEqual(['deploy', 'deploy-pending']);
  });

  it('finds a skill by a word in the middle of its name', () => {
    expect(rankByQuery(skills, 'update', (s) => s)).toEqual(['app-update']);
    expect(rankByQuery(skills, 'timesheet', (s) => s)).toEqual(['weekly-timesheet']);
  });

  it('drops non-matches entirely', () => {
    expect(rankByQuery(skills, 'zzzz', (s) => s)).toEqual([]);
  });

  it('reads the name off an object when told how', () => {
    const items = [{ name: 'clear' }, { name: 'unclear-thing' }];
    expect(rankByQuery(items, 'clear', (c) => c.name)).toEqual([
      { name: 'clear' },
      { name: 'unclear-thing' },
    ]);
  });
});
