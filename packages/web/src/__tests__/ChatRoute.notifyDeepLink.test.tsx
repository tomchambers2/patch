// spec/09 § `### push`, spec/14 ## Main chat panel — a patch_notify call
// carrying deepLink renders that link as a tappable row on the collapsed
// tool-call summary itself, not buried in the expanded JSON.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
  },
}));

const NOW = 1_800_000_000_000;

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'deploy',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute — patch_notify deepLink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('renders a tappable link row on the collapsed summary when deepLink is present', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'patch_notify',
      args: {
        channel: 'push',
        message: 'Route ready',
        deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
      },
      callId: 'call-1',
    });
    renderChat();
    const row = screen.getByTestId('tool-call-deeplink');
    expect(row.getAttribute('href')).toBe(
      'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
    );
    expect(row.getAttribute('target')).toBe('_blank');
    expect(row.textContent).toContain('citymapper://directions');
  });

  it('renders no link row for a patch_notify call without deepLink', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'patch_notify',
      args: { channel: 'desktop', message: 'Build finished' },
      callId: 'call-1',
    });
    renderChat();
    expect(screen.queryByTestId('tool-call-deeplink')).toBeNull();
    expect(screen.getByTestId('notify-box')?.textContent).toContain('Patch notify');
  });

  it('shows every patch_notify as a green box carrying its message', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'patch_notify',
      args: { message: 'Build finished', importance: 'urgent' },
      callId: 'call-1',
    });
    renderChat();
    const box = screen.getByTestId('notify-box');
    expect(box.textContent).toContain('Build finished');
    expect(box.textContent).toContain('urgent');
    expect(box.getAttribute('data-importance')).toBe('urgent');
  });

  it('keeps a patch_notify visible between other tool calls instead of folding it into the run', () => {
    seed();
    const ev = (seq: number, tool: string, args: Record<string, unknown>, callId: string) =>
      useChatStore
        .getState()
        .applyEvent({ type: 'chat.tool_call', chatId: 'c1', seq, tool, args, callId });
    ev(1, 'Bash', { command: 'ls' }, 'a');
    ev(2, 'patch_notify', { message: 'Halfway there' }, 'b');
    ev(3, 'Bash', { command: 'pwd' }, 'c');
    ev(4, 'Read', { file_path: '/x' }, 'd');
    renderChat();
    const box = screen.getByTestId('notify-box');
    expect(box.textContent).toContain('Halfway there');
    expect(box.textContent).toContain('Patch notify');
    expect(box.textContent).not.toContain('patch_notify');
  });
});
