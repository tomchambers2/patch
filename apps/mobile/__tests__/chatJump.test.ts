// src/lib/chatJump.ts — the pure halves of opening a chat at a search hit
// (spec/03 § Chat search): reading the route's `seq`, and finding the list row
// that holds it (a folded tool run holds every seq inside it; a re-run turn
// keeps every seq it ran as).

import { describe, it, expect } from 'vitest';
import { parseSeqParam, rowIndexForSeq } from '../src/lib/chatJump';
import type { TimelineRow } from '../src/lib/toolSummary';
import type { ChatEventEntry } from '../src/stores/chatStore';

const entry = (seq: number, extra: Partial<ChatEventEntry> = {}): ChatEventEntry => ({
  seq,
  kind: 'message',
  role: 'assistant',
  content: `m${seq}`,
  ...extra,
});

describe('parseSeqParam', () => {
  it('reads a non-negative integer, and nothing else', () => {
    expect(parseSeqParam('42')).toBe(42);
    expect(parseSeqParam('0')).toBe(0);
    expect(parseSeqParam(['7', '8'])).toBe(7);
    expect(parseSeqParam(undefined)).toBeNull();
    expect(parseSeqParam([])).toBeNull();
    expect(parseSeqParam('')).toBeNull();
    expect(parseSeqParam('-1')).toBeNull();
    expect(parseSeqParam('1.5')).toBeNull();
    expect(parseSeqParam('abc')).toBeNull();
  });
});

describe('rowIndexForSeq', () => {
  const rows: TimelineRow[] = [
    { kind: 'entry', key: 'e5', entry: entry(5) },
    {
      kind: 'group',
      key: 'g',
      entries: [entry(3, { kind: 'tool_call' }), entry(4, { kind: 'tool_result' })],
    },
    { kind: 'entry', key: 'e2', entry: entry(2, { attempts: [{ seq: 1 }, { seq: 2 }] }) },
  ];

  it('finds a plain row, a row inside a tool run, and a re-run turn by any attempt', () => {
    expect(rowIndexForSeq(rows, 5)).toBe(0);
    expect(rowIndexForSeq(rows, 4)).toBe(1);
    expect(rowIndexForSeq(rows, 2)).toBe(2);
    expect(rowIndexForSeq(rows, 1)).toBe(2);
  });

  it('is -1 for a seq the list does not hold', () => {
    expect(rowIndexForSeq(rows, 99)).toBe(-1);
    expect(rowIndexForSeq([], 1)).toBe(-1);
  });
});
