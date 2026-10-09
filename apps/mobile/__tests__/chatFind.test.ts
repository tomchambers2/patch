import { describe, expect, it } from 'vitest';
import { findMessageSeqs, stepIndex } from '../src/lib/chatFind';
import type { ChatEventEntry } from '../src/stores/chatStore';

const m = (seq: number, content: string): ChatEventEntry =>
  ({ seq, kind: 'message', role: 'assistant', content, at: 0 }) as ChatEventEntry;

describe('chatFind', () => {
  it('matches messages case-insensitively, in order, ignoring blank queries', () => {
    const tl = [m(1, 'Hello there'), m(2, 'nothing'), m(3, 'HELLO again')];
    expect(findMessageSeqs(tl, ' hello ')).toEqual([1, 3]);
    expect(findMessageSeqs(tl, '  ')).toEqual([]);
  });
  it('wraps stepping', () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});
