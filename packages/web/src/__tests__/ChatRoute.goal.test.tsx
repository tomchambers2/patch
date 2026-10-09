// spec/04 § Goals — "one visible goal per chat... VISIBLE, which is what Claude
// Code lacks".
//
// Typing `/goal <text>` in the composer sets the chat's goal AND starts a turn
// with the condition as the directive; the goal then shows in a bar at the top
// of the chat with its live progress (running time, turns evaluated, tokens
// spent, the evaluator's latest reason). A bare `/goal` clears it, sending
// nothing. These tests lock in: (1) a chat with a goal shows the bar, (2)
// `/goal <text>` persists via the API AND sends the condition as a turn, (3)
// `/goal` alone clears it and sends nothing, (4) a chat with no goal shows no
// bar, and (5) the bar's live metrics render from `goalProgress`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { api } from '../api/rest.js';
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
    checkHooks: vi.fn(async () => ({ decision: 'pass' as const, results: [] })),
  },
}));

function seed(
  goal: string | null,
  goalProgress: {
    startedAt: number;
    turnsEvaluated: number;
    tokensSpent: number;
    lastVerdict: 'not_met' | null;
    lastReason: string | null;
  } | null = null,
): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'fix layout',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal,
      goalProgress,
    },
  ]);
}

function renderChat(
  ws: { send: ReturnType<typeof vi.fn>; requestReplay?: ReturnType<typeof vi.fn> } | null = null,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws as unknown as null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function typeAndSend(text: string): void {
  const input = screen.getByTestId('composer-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('ChatRoute — /goal command + goal banner', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.setGoal)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows the goal banner with the goal text when the chat has a goal', () => {
    seed('Ship the release by Friday');
    renderChat();
    const banner = screen.getByTestId('goal-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Ship the release by Friday');
  });

  it('does NOT show the goal banner when the chat has no goal', () => {
    seed(null);
    renderChat();
    expect(screen.queryByTestId('goal-banner')).not.toBeInTheDocument();
  });

  it('`/goal <text>` sets the goal via the API AND starts a turn with the condition as the directive', async () => {
    seed(null);
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/goal Ship the release by Friday');

    // Optimistic: goal is set locally, banner appears.
    expect(useChatStore.getState().chats['c1']?.goal).toBe('Ship the release by Friday');
    await waitFor(() => {
      expect(api.setGoal).toHaveBeenCalledWith('c1', 'Ship the release by Friday');
    });
    expect(screen.getByTestId('goal-banner')).toHaveTextContent('Ship the release by Friday');

    // Unlike the bare-clear case below, setting a NEW goal starts a turn with
    // the condition as the directive (Claude Code's own `/goal`) — the goal
    // is not merely recorded, the agent is actually set working toward it.
    expect(ws.send).toHaveBeenCalled();
    const sent = ws.send.mock.calls.map((c) => c[0]);
    expect(
      sent.some((e) => e.type === 'chat.input' && e.message === 'Ship the release by Friday'),
    ).toBe(true);
  });

  it('a bare `/goal` clears the goal', async () => {
    seed('an old goal');
    renderChat();
    expect(screen.getByTestId('goal-banner')).toBeInTheDocument();
    typeAndSend('/goal');
    // The first Enter completes the `/goal` autocomplete row into a chip; the
    // second sends it.
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });

    expect(useChatStore.getState().chats['c1']?.goal).toBe(null);
    await waitFor(() => {
      expect(api.setGoal).toHaveBeenCalledWith('c1', null);
    });
    expect(screen.queryByTestId('goal-banner')).not.toBeInTheDocument();
  });

  it('reverts the goal + surfaces a toast on API failure (NO FALLBACK)', async () => {
    vi.mocked(api.setGoal).mockRejectedValueOnce(new Error('network down'));
    seed(null);
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/goal try this');

    // Optimistic set first.
    expect(useChatStore.getState().chats['c1']?.goal).toBe('try this');
    // Reverts on failure and surfaces the error.
    await waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.goal).toBe(null);
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('goal');
  });

  it('shows live progress — running time, turns, tokens — once the evaluator has judged a turn', () => {
    seed('Ship the release by Friday', {
      startedAt: Date.now() - 9 * 60_000,
      turnsEvaluated: 3,
      tokensSpent: 8200,
      lastVerdict: 'not_met',
      lastReason: 'Tests are still red',
    });
    renderChat();
    const metrics = screen.getByTestId('goal-banner-metrics');
    expect(metrics).toHaveTextContent('9m');
    expect(metrics).toHaveTextContent('3 turns');
    expect(metrics).toHaveTextContent('8.2k tokens');
    expect(screen.getByTestId('goal-banner-reason')).toHaveTextContent(
      'Not met: Tests are still red',
    );
  });

  it('shows no metrics/reason before the first evaluation has landed', () => {
    seed('Ship the release by Friday', {
      startedAt: Date.now(),
      turnsEvaluated: 0,
      tokensSpent: 0,
      lastVerdict: null,
      lastReason: null,
    });
    renderChat();
    expect(screen.queryByTestId('goal-banner-reason')).not.toBeInTheDocument();
  });

  it('editing the goal text in the bar saves the new text via the API', async () => {
    seed('Ship the release by Friday');
    renderChat({ send: vi.fn(), requestReplay: vi.fn() });
    fireEvent.click(screen.getByTestId('goal-banner-text'));
    const input = screen.getByTestId('goal-edit-input');
    fireEvent.change(input, { target: { value: 'Ship the release by Monday' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));
    expect(screen.queryByTestId('goal-edit-modal')).not.toBeInTheDocument();

    expect(useChatStore.getState().chats['c1']?.goal).toBe('Ship the release by Monday');
    await waitFor(() => {
      expect(api.setGoal).toHaveBeenCalledWith('c1', 'Ship the release by Monday');
    });
    expect(screen.getByTestId('goal-banner')).toHaveTextContent('Ship the release by Monday');
  });

  it('cancelling the goal modal changes nothing', () => {
    seed('Ship the release by Friday');
    renderChat({ send: vi.fn(), requestReplay: vi.fn() });
    fireEvent.click(screen.getByTestId('goal-banner-text'));
    fireEvent.change(screen.getByTestId('goal-edit-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('goal-edit-cancel'));
    expect(screen.queryByTestId('goal-edit-modal')).not.toBeInTheDocument();
    expect(api.setGoal).not.toHaveBeenCalled();
    expect(useChatStore.getState().chats['c1']?.goal).toBe('Ship the release by Friday');
  });
});
