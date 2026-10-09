import { describe, it, expect } from 'vitest';
import { parseGoalOutcome } from '../src/goal-outcome.js';

describe('parseGoalOutcome', () => {
  it('parses a met outcome', () => {
    expect(parseGoalOutcome('[goal: met]\nAll tests pass and the release is tagged')).toEqual({
      outcome: 'met',
      reason: 'All tests pass and the release is tagged',
    });
  });

  it('parses an impossible outcome', () => {
    expect(parseGoalOutcome('[goal: impossible]\nThe target repo no longer exists')).toEqual({
      outcome: 'impossible',
      reason: 'The target repo no longer exists',
    });
  });

  it('trims the reason', () => {
    expect(parseGoalOutcome('[goal: met]\n  done  \n')).toEqual({ outcome: 'met', reason: 'done' });
  });

  it('returns null for an ordinary system message', () => {
    expect(parseGoalOutcome('Session rotated · digest carried over')).toBeNull();
    expect(parseGoalOutcome('')).toBeNull();
  });

  it('returns null for a goal-shaped line with an unrecognised outcome', () => {
    expect(parseGoalOutcome('[goal: not_met]\nkeep going')).toBeNull();
  });
});
