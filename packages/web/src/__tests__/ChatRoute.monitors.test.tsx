// Monitors (historical) — `Monitor` and `TaskStop` are disallowed native tools
// now (sdkBackend.ts's `DISALLOWED_NATIVE_TOOLS`, spec/14 § Monitors
// (historical)), so no chat can arm a new one. A transcript that predates the
// change still replays: the `Monitor` call reads as `Monitor · <description>`
// with its command on the row, same as any other tool-call row.

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
    watchList: vi.fn(async () => ({ tasks: [] })),
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

function armMonitor(): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool: 'Monitor',
    args: {
      command: 'tail -f deploy.log | grep --line-buffered ERROR',
      description: 'errors in deploy.log',
      persistent: true,
    },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    tool: 'Monitor',
    callId: 'call-1',
    result: 'Monitor started (task task_7f3, persistent — runs until TaskStop or session end).',
  });
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

describe('ChatRoute — monitors (historical replay)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.getState().setBackgroundTasksCollapsed(false);
    useUiStore.getState().setBackgroundTasksShowAll(false);
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

  it('renders the Monitor call as a tool call naming what it watches', () => {
    seed();
    armMonitor();
    renderChat();
    const rows = screen.getAllByTestId('tool-call');
    const text = rows.map((r) => r.textContent ?? '').join('\n');
    expect(text).toContain('Monitor · errors in deploy.log');
    expect(text).toContain('tail -f deploy.log');
  });

  it('does not add a background-task-bar row for a replayed Monitor call', () => {
    seed();
    armMonitor();
    renderChat();
    expect(screen.queryByTestId('background-task-bar')).toBeNull();
  });
});
