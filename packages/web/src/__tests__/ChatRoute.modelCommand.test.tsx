// spec/04-chats-and-folders.md § Model — `/model <name>` slash command.
//
// Typing `/model <name>` in the composer changes the chat's model the same way
// the picker does — a `chat.model_request` on the live socket — WITHOUT
// sending a chat turn. These tests lock in: (1) a name that matches the
// catalogue sends the request, (2) a bare `/model` is a usage error, (3) a
// name matching nothing is refused, (4) a name matching more than one entry is
// refused as ambiguous, (5) it does not match a normal message.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
    checkHooks: vi.fn(async () => ({ decision: 'pass', results: [] })),
  },
}));

function seed(model: string | null = 'claude-sonnet-5-5'): void {
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
      model,
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

describe('ChatRoute — /model command (spec/04 § Model)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    setModelCatalog({
      models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5' },
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      ],
      status: 'ready',
    });
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
    resetModelCatalog();
  });

  it('`/model <name>` sends `chat.model_request` for a unique catalogue match WITHOUT a chat turn', () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/model opus');

    expect(ws.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-opus-5-5',
    });
    expect(screen.queryByTestId('msg')).not.toBeInTheDocument();
  });

  it('matches case-insensitively on the catalogue label', () => {
    seed('claude-opus-5-5');
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/model SONNET 5.5');

    expect(ws.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-sonnet-5-5',
    });
  });

  it('a bare `/model` is a usage error — no request sent', () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/model');

    expect(useUiStore.getState().errors[0]?.message).toContain('/model');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a name matching nothing in the catalogue is refused, naming it', () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/model gpt-nonexistent');

    expect(useUiStore.getState().errors[0]?.message).toContain('gpt-nonexistent');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a name matching more than one catalogue entry is refused as ambiguous', () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/model 5.5');

    expect(useUiStore.getState().errors[0]?.message).toContain('5.5');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('choosing the model the chat is already on is a silent no-op', () => {
    seed('claude-opus-5-5');
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('/model opus');

    expect(ws.send).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('does NOT match a normal message (sends a real chat turn instead)', async () => {
    seed();
    const ws = { send: vi.fn(), requestReplay: vi.fn() };
    renderChat(ws);
    typeAndSend('let us model this out');

    await waitFor(() => expect(ws.send).toHaveBeenCalled());
    expect(ws.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.model_request' }),
    );
  });
});
