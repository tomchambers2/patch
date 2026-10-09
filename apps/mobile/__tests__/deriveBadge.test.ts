// spec/15 § Status badges — parity with web's deriveBadge precedence
// (packages/web/src/__tests__/backgroundBadge.test.tsx), for the three
// states mobile's Chats list badge didn't draw at all: `errored`,
// `background`, `monitoring`. Ordering mirrors web: permission > errored >
// working > unread (`done`) > background > monitoring > read.

import { describe, it, expect } from 'vitest';
import { deriveBadge } from '../src/stores/types';
import type { ChatRow } from '../src/stores/types';

function row(overrides: Partial<ChatRow>): ChatRow {
  return {
    chatId: 'c1',
    name: 'One',
    daemonId: 'd1',
    folder: '~/x',
    activity: 'idle',
    permissionMode: 'auto',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastVisitedAt: 0,
    preview: '',
    pendingPermissions: [],
    lastSeq: 0,
    pendingWake: null,
    snoozedUntil: null,
    backgroundTasks: null,
    model: null,
    jobId: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    goal: null,
    reminder: null,
    todos: [],
    disabled: false,
    ...overrides,
  } as ChatRow;
}

describe('deriveBadge — background', () => {
  it('replaces the read tick when a background task is still running', () => {
    expect(deriveBadge(row({}))).toBe('read');
    expect(deriveBadge(row({ backgroundTasks: 1 }))).toBe('background');
  });

  it('NO FALLBACK: an unknown or zero count never shows background', () => {
    expect(deriveBadge(row({ backgroundTasks: null }))).toBe('read');
    expect(deriveBadge(row({ backgroundTasks: 0 }))).toBe('read');
  });

  it('unread beats background, always', () => {
    expect(deriveBadge(row({ lastUpdated: 1, lastVisitedAt: 0, backgroundTasks: 1 }))).toBe('done');
  });
});

describe('deriveBadge — monitoring', () => {
  it('shows monitoring when a wake is pending and there is nothing else to say', () => {
    expect(
      deriveBadge(row({ pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined } })),
    ).toBe('monitoring');
  });

  it('unread still beats monitoring, same as background', () => {
    expect(
      deriveBadge(
        row({
          lastUpdated: 1,
          lastVisitedAt: 0,
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('done');
  });

  it('a running background job beats a monitoring wake — the job is the stronger claim', () => {
    expect(
      deriveBadge(
        row({
          backgroundTasks: 1,
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('background');
  });
});

describe('deriveBadge — errored', () => {
  it('ranks above working and below permission', () => {
    expect(deriveBadge(row({ status: 'errored' }))).toBe('errored');
    expect(deriveBadge(row({ activity: 'errored' }))).toBe('errored');
    expect(deriveBadge(row({ status: 'errored', activity: 'running' }))).toBe('errored');
    expect(deriveBadge(row({ status: 'errored', activity: 'awaiting-permission' }))).toBe(
      'permission',
    );
  });

  it('outranks background and monitoring', () => {
    expect(deriveBadge(row({ status: 'errored', backgroundTasks: 1 }))).toBe('errored');
    expect(
      deriveBadge(
        row({
          status: 'errored',
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('errored');
  });
});
