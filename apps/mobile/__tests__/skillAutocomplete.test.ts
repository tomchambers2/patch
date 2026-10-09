// Skill autocomplete parsing for the mobile composer (spec/15 § Composer).
import { describe, it, expect } from 'vitest';
import {
  filterSkills,
  activeSlashToken,
  findChipTokens,
  chipEndingAt,
  spliceCompletion,
} from '../src/lib/skillAutocomplete';

describe('filterSkills', () => {
  const skills = ['plant', 'plan-travel', 'deploy', 'Deep-Research'];
  it('prefix-filters case-insensitively', () => {
    expect(filterSkills(skills, 'pl')).toEqual(['plant', 'plan-travel']);
    expect(filterSkills(skills, 'de')).toEqual(['deploy', 'Deep-Research']);
  });
  it('returns everything on an empty query', () => {
    expect(filterSkills(skills, '')).toEqual(skills);
  });
  it('returns nothing when nothing matches', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([]);
  });
});

// spec/15 § Composer — Skill autocomplete: `/` opens anywhere a word starts,
// and a completed token becomes a chip (Patch Updates: "patch skill becomes
// a chip anywhere in the composer, with preview").
describe('activeSlashToken', () => {
  it('is active at the start of the draft', () => {
    expect(activeSlashToken('/pl', 3)).toEqual({ start: 0, query: 'pl' });
  });
  it('opens mid-draft, right after a space', () => {
    const text = 'please run /pl';
    expect(activeSlashToken(text, text.length)).toEqual({ start: 11, query: 'pl' });
  });
  it('is not active once closed with a space', () => {
    expect(activeSlashToken('/plant and then some', 8)).toBeNull();
  });
  it('is not active when the slash does not begin a word', () => {
    expect(activeSlashToken('foo/bar', 7)).toBeNull();
  });
});

describe('findChipTokens', () => {
  const known = new Set(['plant']);
  it('finds a chip mid-draft', () => {
    expect(findChipTokens('please run /plant now', known)).toEqual([
      { start: 11, end: 17, name: 'plant' },
    ]);
  });
  it('does not chip a token still being typed', () => {
    expect(findChipTokens('/plant', known)).toEqual([]);
  });
  it('does not chip an unrecognised name', () => {
    expect(findChipTokens('/nope here', known)).toEqual([]);
  });
});

describe('chipEndingAt', () => {
  const known = new Set(['plant']);
  it('finds the chip immediately before the cursor', () => {
    expect(chipEndingAt('run /plant ', 11, known)).toEqual({ start: 4 });
  });
  it('is null with no trailing space yet', () => {
    expect(chipEndingAt('/plant', 6, known)).toBeNull();
  });
});

describe('spliceCompletion', () => {
  it('replaces a mid-draft token, keeping the rest of the text', () => {
    expect(spliceCompletion('please /pl now', 7, 10, 'plant')).toEqual({
      text: 'please /plant  now',
      cursor: 14,
    });
  });
});
