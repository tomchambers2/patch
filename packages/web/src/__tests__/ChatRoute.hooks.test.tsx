// spec/20-hooks.md § On the user's message — the composer's hook-check flow:
// Checking… while in flight, pass sends silently, advise sends with a note,
// block holds the message behind a card with Use suggestion / Edit / Send
// anyway, and a failed/timed-out hook is shown exactly like a block.

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
    checkHooks: vi.fn(),
  },
}));

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'chat',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

function renderChat(ws: {
  send: ReturnType<typeof vi.fn>;
  requestReplay?: ReturnType<typeof vi.fn>;
}): ReturnType<typeof render> {
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

describe('ChatRoute — message hooks', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.checkHooks).mockReset();
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('a pass sends normally with no card and no note', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({ decision: 'pass', results: [] });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('hello there');
    await waitFor(() => expect(ws.send).toHaveBeenCalled());
    expect(screen.queryByTestId('hook-block-card')).toBeNull();
    expect(screen.queryByTestId('msg-hook-advise')).toBeNull();
    expect(screen.getByTestId('composer-input')).toHaveValue('');
  });

  it('shows Checking… while the request is in flight, then clears it', async () => {
    let resolve!: (v: { decision: 'pass'; results: [] }) => void;
    vi.mocked(api.checkHooks).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('hello there');
    await waitFor(() => expect(screen.getByTestId('composer-checking')).toBeInTheDocument());
    expect(screen.queryByTestId('send-btn')).toBeNull();
    resolve({ decision: 'pass', results: [] });
    await waitFor(() => expect(screen.queryByTestId('composer-checking')).toBeNull());
    expect(ws.send).toHaveBeenCalled();
  });

  it('an advise result sends the message and attaches an expandable note', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({
      decision: 'advise',
      results: [
        {
          hookId: 'hook_a',
          hookName: 'tone check',
          status: 'ok',
          decision: 'advise',
          analysis: 'a little blunt',
          durationMs: 5,
        },
      ],
    });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('do it now');
    await waitFor(() => expect(ws.send).toHaveBeenCalled());
    const note = await screen.findByTestId('msg-hook-advise');
    expect(note).toHaveTextContent('tone check');
    expect(screen.queryByTestId('msg-hook-advise-body')).toBeNull();
    fireEvent.click(screen.getByTestId('msg-hook-advise-toggle'));
    expect(screen.getByTestId('msg-hook-advise-body')).toHaveTextContent('a little blunt');
  });

  it('a block holds the message, shows the card, and Edit just closes it', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({
      decision: 'block',
      results: [
        {
          hookId: 'hook_b',
          hookName: 'no secrets',
          status: 'ok',
          decision: 'block',
          analysis: 'looks like a password',
          suggestion: 'my [redacted] password',
          durationMs: 5,
        },
      ],
    });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('my hunter2 password');
    const card = await screen.findByTestId('hook-block-card');
    expect(card).toHaveTextContent('no secrets');
    expect(card).toHaveTextContent('looks like a password');
    expect(ws.send).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-input')).toHaveValue('my hunter2 password');
    fireEvent.click(screen.getByTestId('hook-block-edit'));
    expect(screen.queryByTestId('hook-block-card')).toBeNull();
    expect(screen.getByTestId('composer-input')).toHaveValue('my hunter2 password');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('Use suggestion replaces the composer text without sending', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({
      decision: 'block',
      results: [
        {
          hookId: 'hook_b',
          hookName: 'no secrets',
          status: 'ok',
          decision: 'block',
          analysis: 'looks like a password',
          suggestion: 'my [redacted] password',
          durationMs: 5,
        },
      ],
    });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('my hunter2 password');
    await screen.findByTestId('hook-block-card');
    fireEvent.click(screen.getByTestId('hook-use-suggestion-hook_b'));
    expect(screen.queryByTestId('hook-block-card')).toBeNull();
    expect(screen.getByTestId('composer-input')).toHaveValue('my [redacted] password');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('Send anyway sends the original text and skips a second check', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({
      decision: 'block',
      results: [
        {
          hookId: 'hook_b',
          hookName: 'no secrets',
          status: 'ok',
          decision: 'block',
          analysis: 'looks like a password',
          durationMs: 5,
        },
      ],
    });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('my hunter2 password');
    await screen.findByTestId('hook-block-card');
    fireEvent.click(screen.getByTestId('hook-block-send-anyway'));
    await waitFor(() => expect(ws.send).toHaveBeenCalled());
    expect(vi.mocked(api.checkHooks)).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('hook-block-card')).toBeNull();
    const sent = ws.send.mock.calls[0]?.[0] as { message?: string };
    expect(sent.message).toBe('my hunter2 password');
  });

  it('a failed hook holds the message and shows its error, not an analysis', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({
      decision: 'block',
      results: [
        {
          hookId: 'hook_c',
          hookName: 'broken hook',
          status: 'failed',
          error: 'command exited non-zero: boom',
          durationMs: 5,
        },
      ],
    });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('hello');
    const card = await screen.findByTestId('hook-block-card');
    expect(card).toHaveTextContent('broken hook');
    expect(screen.getByTestId('hook-block-error')).toHaveTextContent('boom');
    expect(screen.queryByTestId(`hook-use-suggestion-hook_c`)).toBeNull();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a timed-out hook holds the message and says so', async () => {
    vi.mocked(api.checkHooks).mockResolvedValue({
      decision: 'block',
      results: [{ hookId: 'hook_d', hookName: 'slow hook', status: 'timeout', durationMs: 15000 }],
    });
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('hello');
    const card = await screen.findByTestId('hook-block-card');
    expect(screen.getByTestId('hook-block-error')).toHaveTextContent('Timed out');
    expect(ws.send).not.toHaveBeenCalled();
    expect(card).toBeTruthy();
  });
});
