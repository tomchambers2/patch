import { describe, expect, it } from 'vitest';
import {
  RESERVED_SPECIAL_THREAD_IDS,
  threadRowState,
  threadRows,
  type ThreadRankInput,
} from '../src/index.js';

const NOW = 1_000_000;

function row(chatId: string, over: Partial<ThreadRankInput> = {}): ThreadRankInput {
  return {
    chatId,
    status: 'active',
    activity: 'idle',
    lastUpdated: 1,
    snoozedUntil: null,
    pendingPermissions: [],
    statusKind: null,
    statusDeclared: null,
    ...over,
  };
}

describe('threadRowState', () => {
  it('ranks a pending permission, then a declared question, report, running, idle', () => {
    expect(threadRowState(row('a', { pendingPermissions: [{}] }))).toBe('permission');
    expect(threadRowState(row('a', { activity: 'awaiting-permission' }))).toBe('permission');
    expect(threadRowState(row('a', { statusKind: 'question', statusDeclared: true }))).toBe(
      'question',
    );
    expect(threadRowState(row('a', { statusKind: 'report' }))).toBe('report');
    expect(threadRowState(row('a', { activity: 'running' }))).toBe('working');
    expect(threadRowState(row('a'))).toBe('idle');
  });

  it('does not treat a generated question guess as blocked', () => {
    expect(threadRowState(row('a', { statusKind: 'question', statusDeclared: false }))).toBe(
      'idle',
    );
  });
});

describe('threadRows', () => {
  it('orders needs-you first, then by recency, and drops inactive, snoozed and special rows', () => {
    const ids = threadRows(
      [
        row('idle-new', { lastUpdated: 50 }),
        row('idle-old', { lastUpdated: 10 }),
        row('running', { activity: 'running', lastUpdated: 5 }),
        row('perm', { pendingPermissions: [{}], lastUpdated: 1 }),
        row('archived', { status: 'archived', lastUpdated: 99 }),
        row('snoozed', { snoozedUntil: NOW + 1, lastUpdated: 99 }),
        row('woken', { snoozedUntil: NOW, lastUpdated: 20 }),
        row('thread_manager', { activity: 'running' }),
      ],
      NOW,
    ).map((r) => r.chatId);
    expect(ids).toEqual(['perm', 'running', 'idle-new', 'woken', 'idle-old']);
  });

  it('accepts a keyed record as well as an array', () => {
    expect(threadRows({ a: row('a') }, NOW).map((r) => r.chatId)).toEqual(['a']);
  });

  it('excludes exactly the reserved special threads', () => {
    const specials = [...RESERVED_SPECIAL_THREAD_IDS].map((id) => row(id));
    expect(threadRows(specials, NOW)).toEqual([]);
  });
});
