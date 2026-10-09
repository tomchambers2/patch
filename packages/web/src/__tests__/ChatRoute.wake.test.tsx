// patch/todo.md — "cron should be visible in a bar above the chat, showing how
// long until next wakeup and the prompt".
//
// The "cron" here is the chat's pending self-wake (spec/02 § Self-wake — patch
// disallows CronCreate and owns the timer itself). When one is armed, the chat
// shows a read-only bar above the transcript with a live countdown to `fireAt`
// and the wake message. These tests lock in: (1) the bar shows countdown +
// message, (2) no bar without a pending wake, (3) the countdown ticks down live,
// (4) a due-but-undelivered wake reads "Wakes now", and (5) a `chat.state`
// clearing `pendingWake` (fired/cancelled) removes the bar.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatRow } from '../stores/types.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
    setLoop: vi.fn(async () => undefined),
  },
}));

const NOW = 1_800_000_000_000;

function seed(pendingWake: ChatRow['pendingWake']): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'bus watch',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake,
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

describe('ChatRoute — pending self-wake bar', () => {
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

  it('shows the countdown to the next wake and its prompt', () => {
    seed({ message: 'check whether the bus has left', fireAt: NOW + 9 * 60_000 });
    renderChat();
    const bar = screen.getByTestId('wake-bar');
    expect(bar).toBeInTheDocument();
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('9m');
    expect(screen.getByTestId('wake-bar-message')).toHaveTextContent(
      'check whether the bus has left',
    );
  });

  it('does NOT show the bar when the chat has no pending wake', () => {
    seed(null);
    renderChat();
    expect(screen.queryByTestId('wake-bar')).not.toBeInTheDocument();
  });

  it('ticks the countdown down live', () => {
    seed({ message: 'nag about bed', fireAt: NOW + 2 * 60_000 + 5_000 });
    renderChat();
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('2m 5s');
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('1m 59s');
  });

  it('reads "now" once the fire time has passed but the turn has not landed', () => {
    seed({ message: 'overdue', fireAt: NOW - 1_000 });
    renderChat();
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('now');
  });

  it('formats a long wait in hours and minutes', () => {
    seed({ message: 'tomorrow-ish', fireAt: NOW + (3 * 3600 + 4 * 60) * 1000 });
    renderChat();
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('3h 4m');
  });

  it('shows "Loops every" + a stop control for a recurring wake, instead of the plain read-only countdown', () => {
    seed({ message: 'check on the build', fireAt: NOW + 5 * 60_000, every: 5 * 60_000 });
    renderChat();
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('Loops every 5m');
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent('5m');
    expect(screen.getByTestId('wake-bar-stop-btn')).toBeInTheDocument();
  });

  // spec/02 § Self-wake — "count the interval from the end of the turn": a
  // loop tick due while the chat's turn is running is absorbed, not queued,
  // and `fireAt` goes stale until the host re-arms it. The bar must not
  // read a (bogus) countdown off that stale time.
  it('shows "waiting for current turn" instead of a countdown when the loop is absorbing a tick', () => {
    seed({ message: 'check on the build', fireAt: NOW - 5_000, every: 5 * 60_000, waiting: true });
    renderChat();
    expect(screen.getByTestId('wake-bar-countdown')).toHaveTextContent(
      'Loops every 5m · waiting for current turn',
    );
    expect(screen.getByTestId('wake-bar-countdown')).not.toHaveTextContent('now');
  });

  it('does NOT show a stop control for a plain one-shot wake (read-only, agent-owned)', () => {
    seed({ message: 'check whether the bus has left', fireAt: NOW + 9 * 60_000 });
    renderChat();
    expect(screen.getByTestId('wake-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('wake-bar-stop-btn')).not.toBeInTheDocument();
  });

  // NOTE: this describe block runs under `vi.useFakeTimers()` (for the live
  // countdown), which stalls RTL's `waitFor` polling (it never advances the
  // faked clock) — see ChatHeader.snooze.test.tsx's note on the same trap.
  // Flush the promise microtask queue directly under `act` instead.
  it('the stop control on a recurring wake calls api.setLoop(chatId, null)', async () => {
    seed({ message: 'check on the build', fireAt: NOW + 5 * 60_000, every: 5 * 60_000 });
    renderChat();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wake-bar-stop-btn'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.setLoop).toHaveBeenCalledWith('c1', null);
  });

  it('surfaces a toast if stopping the loop fails (NO FALLBACK)', async () => {
    vi.mocked(api.setLoop).mockRejectedValueOnce(new Error('network down'));
    seed({ message: 'check on the build', fireAt: NOW + 5 * 60_000, every: 5 * 60_000 });
    renderChat();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wake-bar-stop-btn'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('loop');
  });

  it('removes the bar when a chat.state clears the pending wake (fired or cancelled)', () => {
    seed({ message: 'check the bus', fireAt: NOW + 60_000 });
    renderChat();
    expect(screen.getByTestId('wake-bar')).toBeInTheDocument();
    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity: 'running',
        lastUpdated: NOW + 60_000,
        pendingWake: null,
        todos: [],
      });
    });
    expect(screen.queryByTestId('wake-bar')).not.toBeInTheDocument();
  });
});
