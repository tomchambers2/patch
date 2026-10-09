// 02-daemon.md § Self-wake — `/loop` slash command.
//
// Typing `/loop <interval> <message>` in the composer arms a durable recurring
// self-wake INSTEAD of sending a chat turn — the host re-delivers `message`
// into this chat every `interval`, forever, mechanically (no agent re-arming
// needed each tick, unlike a plain `patch_wake_me`). A bare `/loop` stops it.
// These tests lock in: (1) `/loop <interval> <message>` calls the API and
// sends no chat turn, (2) a bare `/loop` cancels, (3) `/loop <interval>` with
// no message is a usage error (no guessed fallback, no API call), (4) an API
// failure surfaces a toast (NO FALLBACK).

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
    setLoop: vi.fn(async () => undefined),
    checkHooks: vi.fn(async () => ({ decision: 'pass', results: [] })),
  },
}));

function seed(): void {
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
      pendingWake: null,
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

describe('ChatRoute — /loop command (02-daemon.md § Self-wake)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.setLoop)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('`/loop <interval> <message>` arms the loop via the API WITHOUT sending a chat turn', async () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/loop 5m check on the build');

    await waitFor(() => {
      expect(api.setLoop).toHaveBeenCalledWith('c1', {
        every: '5m',
        message: 'check on the build',
      });
    });
    // Not a chat turn: nothing rendered as a user message, nothing on the WS.
    expect(screen.queryByTestId('msg')).not.toBeInTheDocument();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a bare `/loop` cancels via the API with `null`', async () => {
    seed();
    renderChat();
    typeAndSend('/loop');

    await waitFor(() => {
      expect(api.setLoop).toHaveBeenCalledWith('c1', null);
    });
  });

  it('`/loop <interval>` with no message is a usage error — no API call, no guessed message', async () => {
    seed();
    renderChat();
    typeAndSend('/loop 5m');

    expect(useUiStore.getState().errors[0]?.message).toContain('/loop');
    expect(api.setLoop).not.toHaveBeenCalled();
  });

  it('reverts nothing but surfaces a toast on API failure when arming (NO FALLBACK)', async () => {
    vi.mocked(api.setLoop).mockRejectedValueOnce(new Error('network down'));
    seed();
    renderChat();
    typeAndSend('/loop 5m check on the build');

    await waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('loop');
    });
  });

  it('does NOT match a normal message (sends a real chat turn instead)', async () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('loop back on this later');

    expect(api.setLoop).not.toHaveBeenCalled();
    await waitFor(() => expect(ws.send).toHaveBeenCalled());
  });
});
