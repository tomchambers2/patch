import { describe, it, expect } from 'vitest';
import { linkSkillTokens } from '../lib/skillToken.js';

const known = new Set(['plant', 'deploy']);

describe('linkSkillTokens', () => {
  it('links a known skill at the start, middle and end of a message', () => {
    expect(linkSkillTokens('/plant now then /deploy', known)).toBe(
      '[/plant](patch-skill:plant) now then [/deploy](patch-skill:deploy)',
    );
  });
  it('leaves unknown names, paths and code alone', () => {
    expect(linkSkillTokens('/nope see a/plant `/plant` ```\n/plant\n```', known)).toBe(
      '/nope see a/plant `/plant` ```\n/plant\n```',
    );
  });
  it('does nothing without known skills', () => {
    expect(linkSkillTokens('/plant', new Set())).toBe('/plant');
  });
});
