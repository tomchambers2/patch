// spec/04 ## Message queueing — the chip on a queued turn says WHEN it goes in:
// the head of the queue reads `Queued`, the rest read their place in the line,
// and each names the event that releases it.

import { describe, it, expect } from 'vitest';
import { queueChipLabel, queueChipTitle } from '../lib/queueLabel';

describe('queueChipLabel', () => {
  it('reads "Queued" at the head of the queue', () => {
    expect(queueChipLabel(1)).toBe('Queued');
  });

  it('reads the ordinal place for everything behind the head', () => {
    expect(queueChipLabel(2)).toBe('2nd in queue');
    expect(queueChipLabel(3)).toBe('3rd in queue');
    expect(queueChipLabel(4)).toBe('4th in queue');
  });

  // A queue this deep is unlikely, but a wrong ordinal is the kind of thing
  // that reads as a bug in the whole panel.
  it('gets the awkward ordinals right', () => {
    expect(queueChipLabel(11)).toBe('11th in queue');
    expect(queueChipLabel(12)).toBe('12th in queue');
    expect(queueChipLabel(13)).toBe('13th in queue');
    expect(queueChipLabel(21)).toBe('21st in queue');
    expect(queueChipLabel(22)).toBe('22nd in queue');
    expect(queueChipLabel(23)).toBe('23rd in queue');
    expect(queueChipLabel(111)).toBe('111th in queue');
  });
});

describe('queueChipTitle', () => {
  it('names the running turn as the release event for the head', () => {
    expect(queueChipTitle(1)).toBe('Runs when the current turn finishes');
  });

  it('counts what is ahead for the rest, singular and plural', () => {
    expect(queueChipTitle(2)).toBe('Runs after the current turn and 1 message ahead of it');
    expect(queueChipTitle(3)).toBe('Runs after the current turn and 2 messages ahead of it');
  });
});
