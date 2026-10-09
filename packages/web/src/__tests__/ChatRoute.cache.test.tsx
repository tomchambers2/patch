// The device's own copy of a transcript (spec/12 § Cold start).
//
// Opening a chat you have opened before paints from here immediately and
// then asks the host only for what is newer. The host stays the record: when
// it says the chat is on a different TRACK than the cache holds, the cache
// is thrown away whole rather than merged into something plausible.
//
// IndexedDB itself is not exercised here (jsdom has none, and the cache
// degrades to a no-op without it, which every other test in this package
// relies on). What is tested is the wiring, which is where the behaviour
// lives.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { WireEvent } from '@patch/wire';

const loadTranscript = vi.fn();
const dropTranscript = vi.fn();
const setBranch = vi.fn();
const trimCache = vi.fn();

vi.mock('../lib/transcriptCache.js', () => ({
  loadTranscript: (...a: unknown[]) => loadTranscript(...a),
  dropTranscript: (...a: unknown[]) => dropTranscript(...a),
  setBranch: (...a: unknown[]) => setBranch(...a),
  trimCache: (...a: unknown[]) => trimCache(...a),
  saveEvents: vi.fn(),
}));
vi.mock('../api/rest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/rest.js')>();
  return {
    ...actual,
    api: { ...actual.api, markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })) },
  };
});

const { ChatRoute } = await import('../routes/ChatRoute.js');
const { useChatStore } = await import('../stores/chatStore.js');

function hydrate(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle' as const,
      status: 'active' as const,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 1,
    },
  ]);
}

function renderChat(chatId: string, ws: unknown) {
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <Routes>
        <Route
          path="/chats/:chatId"
          element={<ChatRoute ws={ws as Parameters<typeof ChatRoute>[0]['ws']} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const msg = (seq: number, content: string): WireEvent =>
  ({ type: 'chat.message', chatId: 'c-cache', seq, role: 'user', content }) as WireEvent;

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  loadTranscript.mockResolvedValue(null);
});

describe('the device’s cached transcript', () => {
  it('paints what the device already holds, then asks the host for the rest', async () => {
    loadTranscript.mockResolvedValue({
      events: [msg(0, 'from the cache'), msg(1, 'also cached')],
      branchId: 'c-cache-b0',
    });
    hydrate('c-cache');
    const requestReplay = vi.fn();
    renderChat('c-cache', { send() {}, requestReplay });

    await waitFor(() => {
      expect(useChatStore.getState().timelines['c-cache']?.length).toBe(2);
    });
    // And only then is the host asked — `requestReplay` derives its cursor
    // from the timeline, so by now it is asking for seq > 1, not the lot.
    expect(requestReplay).toHaveBeenCalledWith('c-cache');
  });

  it('still asks the host when the device holds nothing', async () => {
    loadTranscript.mockResolvedValue(null);
    hydrate('c-cache');
    const requestReplay = vi.fn();
    renderChat('c-cache', { send() {}, requestReplay });
    await waitFor(() => expect(requestReplay).toHaveBeenCalledWith('c-cache'));
    expect(useChatStore.getState().timelines['c-cache'] ?? []).toHaveLength(0);
  });

  it('throws the cache away when the host says the chat is on a different track', async () => {
    loadTranscript.mockResolvedValue({ events: [msg(0, 'old track')], branchId: 'c-cache-b0' });
    hydrate('c-cache');
    const requestReplay = vi.fn();
    renderChat('c-cache', { send() {}, requestReplay });
    await waitFor(() => expect(useChatStore.getState().timelines['c-cache']?.length).toBe(1));

    // The host's own word on which branch is live — a fork or an edit.
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-cache',
      activeBranchId: 'c-cache-b1',
      branches: [
        { branchId: 'c-cache-b1', parentBranchId: null, forkFromSeq: null, label: 'main' },
      ],
    } as WireEvent);

    await waitFor(() => expect(dropTranscript).toHaveBeenCalledWith('c-cache'));
    // Dropped whole and refetched, not merged into a half-right transcript.
    expect(useChatStore.getState().timelines['c-cache'] ?? []).toHaveLength(0);
    expect(requestReplay).toHaveBeenCalledWith('c-cache', { force: true });
  });

  it('records the branch the cached events belong to when they agree', async () => {
    loadTranscript.mockResolvedValue(null);
    hydrate('c-cache');
    renderChat('c-cache', { send() {}, requestReplay: vi.fn() });
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-cache',
      activeBranchId: 'c-cache-b0',
      branches: [
        { branchId: 'c-cache-b0', parentBranchId: null, forkFromSeq: null, label: 'main' },
      ],
    } as WireEvent);
    await waitFor(() => expect(setBranch).toHaveBeenCalledWith('c-cache', 'c-cache-b0'));
    expect(dropTranscript).not.toHaveBeenCalled();
  });
});
