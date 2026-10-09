// App Updates: "should show which workspace I am in somewhere" — the window
// title must track the active chat's folder (same basename ChatHeader's crumb
// shows), fall back to plain "patch" where there is no workspace to show
// (special thread, or no active chat), and keep updating across client-side
// navigation rather than only at first mount.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { documentTitleFor, useDocumentTitleSync } from '../lib/documentTitle.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '/home/tom/projects/foo',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

describe('documentTitleFor (pure derivation)', () => {
  it('reads "<basename> — patch" for a chat with a real folder', () => {
    expect(documentTitleFor('c1', '/home/tom/projects/bus')).toBe('bus — patch');
  });

  it('falls back to plain "patch" when there is no active chat', () => {
    expect(documentTitleFor(null, undefined)).toBe('patch');
  });

  it('falls back to plain "patch" for every special thread, regardless of its folder', () => {
    expect(documentTitleFor(SPECIAL_THREAD_IDS.manager, '/home/tom/.patch/threads/manager')).toBe(
      'patch',
    );
    expect(documentTitleFor(SPECIAL_THREAD_IDS.speakers, '/home/tom/.patch/threads/speakers')).toBe(
      'patch',
    );
  });

  it('falls back to plain "patch" for a chat with no real folder (NO FALLBACK placeholder)', () => {
    expect(documentTitleFor('c1', '')).toBe('patch');
    expect(documentTitleFor('c1', '.')).toBe('patch');
  });

  it("agrees with the folder crumb's own basename-only derivation on a deep path", () => {
    expect(documentTitleFor('c1', '/home/tom/projects/portfolio/patch')).toBe('patch — patch');
  });
});

function Probe(): null {
  useDocumentTitleSync();
  return null;
}

describe('useDocumentTitleSync (live store wiring)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    document.title = 'stale';
  });
  afterEach(() => {
    cleanup();
  });

  it('sets the title for the active chat on mount', () => {
    useChatStore.getState().hydrate([row({ chatId: 'c1', folder: '/home/tom/projects/bus' })]);
    useChatStore.getState().setActiveChat('c1');
    render(<Probe />);
    expect(document.title).toBe('bus — patch');
  });

  it('follows client-side navigation between two chats, not just the initial load', () => {
    useChatStore
      .getState()
      .hydrate([
        row({ chatId: 'c1', folder: '/home/tom/projects/bus' }),
        row({ chatId: 'c2', folder: '/home/tom/projects/portfolio' }),
      ]);
    useChatStore.getState().setActiveChat('c1');
    render(<Probe />);
    expect(document.title).toBe('bus — patch');

    act(() => {
      useChatStore.getState().setActiveChat('c2');
    });
    expect(document.title).toBe('portfolio — patch');
  });

  it('falls back to "patch" leaving a chat for a route with none (Settings, Jobs, empty state)', () => {
    useChatStore.getState().hydrate([row({ chatId: 'c1', folder: '/home/tom/projects/bus' })]);
    useChatStore.getState().setActiveChat('c1');
    render(<Probe />);
    expect(document.title).toBe('bus — patch');

    act(() => {
      useChatStore.getState().setActiveChat(null);
    });
    expect(document.title).toBe('patch');
  });

  it('falls back to "patch" for a special thread even though it carries a folder', () => {
    useChatStore.getState().hydrate([
      row({
        chatId: SPECIAL_THREAD_IDS.manager,
        folder: '/home/tom/.patch/threads/manager',
      }),
    ]);
    useChatStore.getState().setActiveChat(SPECIAL_THREAD_IDS.manager);
    render(<Probe />);
    expect(document.title).toBe('patch');
  });
});
