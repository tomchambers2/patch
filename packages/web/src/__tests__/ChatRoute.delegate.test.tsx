// spec/14 § Main chat panel — Delegate tool row: a `patch_delegate` call
// carries a live status pill (sourced from `chat.delegate_update`) and an
// "Open transcript" action, rather than collapsing like an ordinary tool
// call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

const getDelegateHistory = vi.fn(async () => ({
  events: [
    { seq: 0, role: 'user', content: 'go do the thing' },
    { seq: 1, role: 'assistant', content: 'done, here is the result' },
  ],
}));

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
    getDelegateHistory: (...args: unknown[]) =>
      (getDelegateHistory as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  },
}));

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'parent chat',
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

function renderChat(retry: number | false = false): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function emitDelegateCall(tool: string, result: unknown): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool,
    args: { prompt: 'go do the thing' },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'call-1',
    result,
  } as never);
}

describe('ChatRoute — patch_delegate tool row', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    getDelegateHistory.mockClear();
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows a Running pill and Open transcript link once the ack lands', () => {
    seed();
    emitDelegateCall('mcp__patch__patch_delegate', { id: 'sub-1', label: 'draft the email' });
    renderChat();
    expect(screen.getByTestId('delegate-status-pill').textContent).toBe('Running');
    expect(screen.getByTestId('delegate-open-transcript')).toBeDefined();
  });

  it('falls back to the ordinary disclosure row before the ack has landed', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'mcp__patch__patch_delegate',
      args: { prompt: 'go do the thing' },
      callId: 'call-1',
    });
    renderChat();
    expect(screen.queryByTestId('delegate-status-pill')).toBeNull();
    expect(screen.getByTestId('tool-call')).toBeDefined();
  });

  it('updates the pill in place from chat.delegate_update, by the subagent id the ack returned', () => {
    seed();
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    renderChat();
    expect(screen.getByTestId('delegate-status-pill').textContent).toBe('Running');

    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.delegate_update',
        chatId: 'c1',
        delegateId: 'sub-1',
        label: 'draft the email',
        status: 'awaiting-permission',
        seq: 3,
      });
    });
    expect(screen.getByTestId('delegate-status-pill').textContent).toBe('Awaiting permission');

    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.delegate_update',
        chatId: 'c1',
        delegateId: 'sub-1',
        label: 'draft the email',
        status: 'failed',
        seq: 4,
      });
    });
    expect(screen.getByTestId('delegate-status-pill').textContent).toBe('Failed');
  });

  it('a delegate_update for a DIFFERENT subagent id leaves this row alone', () => {
    seed();
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    renderChat();
    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.delegate_update',
        chatId: 'c1',
        delegateId: 'sub-2',
        label: 'something else',
        status: 'done',
        seq: 3,
      });
    });
    expect(screen.getByTestId('delegate-status-pill').textContent).toBe('Running');
  });

  it('is a collapsible row: collapsed by default, expands inline to the read-only transcript, collapses again', async () => {
    seed();
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    renderChat();
    const toggle = screen.getByTestId('delegate-open-transcript');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(getDelegateHistory).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delegate-transcript-stream')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(getDelegateHistory).toHaveBeenCalledWith('c1', 'sub-1');
    await waitFor(() => {
      expect(screen.getAllByTestId('delegate-transcript-msg')).toHaveLength(2);
    });
    const stream = screen.getByTestId('delegate-transcript-stream');
    expect(stream.textContent).toContain('go do the thing');
    expect(stream.textContent).toContain('done, here is the result');
    // Inline in the transcript: no dialog, no overlay, no composer, no permission cards.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('delegate-transcript-overlay')).toBeNull();
    expect(screen.queryByTestId('stp-permission-card')).toBeNull();
    expect(screen.getByTestId('tool-call').contains(stream)).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('delegate-transcript-stream')).toBeNull();
  });

  it("a failed transcript fetch shows the error straight away, without the app's retry stretching the wait", async () => {
    seed();
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    getDelegateHistory.mockRejectedValueOnce(new Error('daemon_timeout'));
    // main.tsx runs queries with retry: 1; each attempt can sit out a 5s daemon timeout.
    renderChat(1);
    fireEvent.click(screen.getByTestId('delegate-open-transcript'));
    await waitFor(() => {
      expect(screen.getByText("Couldn't load transcript.")).toBeTruthy();
    });
    expect(getDelegateHistory).toHaveBeenCalledTimes(1);
  });

  it('reads the ack out of an MCP text block, not just a direct object', () => {
    seed();
    emitDelegateCall('patch_delegate', {
      content: [{ type: 'text', text: JSON.stringify({ id: 'sub-1', label: 'draft the email' }) }],
    });
    renderChat();
    expect(screen.getByTestId('delegate-status-pill')).toBeDefined();
  });

  it('leaves patch_delegate_list / patch_delegate_stop on the ordinary collapsed row', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'mcp__patch__patch_delegate_list',
      args: {},
      callId: 'call-1',
    });
    renderChat();
    expect(screen.queryByTestId('delegate-status-pill')).toBeNull();
  });

  describe('running delegates strip', () => {
    function update(id: string, label: string, status: 'running' | 'done', seq: number): void {
      act(() => {
        useChatStore.getState().applyEvent({
          type: 'chat.delegate_update',
          chatId: 'c1',
          delegateId: id,
          label,
          status,
          seq,
        });
      });
    }

    it('lists each running subagent with its label and running time, and drops it when done', () => {
      seed();
      renderChat();
      expect(screen.queryByTestId('delegate-strip')).toBeNull();
      update('sub-1', 'draft the email', 'running', 1);
      update('sub-2', 'build the design', 'running', 2);
      const items = screen.getAllByTestId('delegate-strip-item');
      expect(items).toHaveLength(2);
      expect(items[0]!.textContent).toContain('draft the email');
      expect(screen.getAllByTestId('delegate-strip-time')[0]!.textContent).toMatch(/^\d+s$/);
      update('sub-1', 'draft the email', 'done', 3);
      expect(screen.getAllByTestId('delegate-strip-item')).toHaveLength(1);
      update('sub-2', 'build the design', 'done', 4);
      expect(screen.queryByTestId('delegate-strip')).toBeNull();
    });

    it('opens the subagent read-only transcript from the strip', async () => {
      seed();
      renderChat();
      update('sub-1', 'draft the email', 'running', 1);
      fireEvent.click(screen.getByTestId('delegate-strip-open'));
      expect(getDelegateHistory).toHaveBeenCalledWith('c1', 'sub-1');
      await waitFor(() => {
        expect(screen.getAllByTestId('delegate-transcript-msg')).toHaveLength(2);
      });
    });
  });
});
