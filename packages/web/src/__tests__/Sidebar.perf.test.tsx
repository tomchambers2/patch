// spec/14 ## Sidebar — "A commit that changes no row must not invalidate the
// chat list".
//
// Tom, patch/todo.md — "Check app for performance". The transcript was already
// made O(changed) ("Chat page slow"), but the *sidebar* was still paying full
// price for every streamed token: `applyEvent` always commits a fresh `chats`
// container (and a fresh row object for the streaming chat) even when no
// row FIELD changed, so a `chat.message_delta` — one per token — invalidated
// the sidebar's `s.chats` subscription, re-ran `groupChats` (a sort over every
// chat) and re-rendered every folder and row. A long reply in a busy workspace
// therefore did O(tokens × chats) work that nothing on screen needed.
//
// Two probes, one at each level:
//   1. store — a delta that changes nothing keeps `chats` (and the row)
//      referentially identical.
//   2. component — `StatusBadge` is mocked with a counting stub, so each call
//      is one sidebar row render. A burst of deltas must render zero rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';

const counter = vi.hoisted(() => ({ rows: 0 }));

vi.mock('../components/StatusBadge.js', () => ({
  StatusBadge: ({ badge }: { badge: string }) => {
    counter.rows++;
    return <span data-testid="badge">{badge}</span>;
  },
}));

const CHATS = 40;
const STREAMING = 'chat-0';

function seed(): void {
  const rows = [];
  for (let i = 0; i < CHATS; i++) {
    rows.push({
      chatId: `chat-${i}`,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: `chat ${i}`,
      folder: `~/proj-${i % 4}`,
      activity: 'idle' as const,
      status: 'active' as const,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 1_000 + i,
    });
  }
  useChatStore.getState().hydrate(rows);
}

/**
 * The FIRST delta of a turn legitimately changes the row (it raises `lastSeq`,
 * which flips the badge to `done`). Everything after it changes nothing — and
 * a turn is hundreds of tokens, so that tail is the whole cost. Land the first
 * delta before measuring.
 */
function openTurn(): void {
  act(() => {
    useChatStore.getState().applyEvent({
      type: 'chat.message_delta',
      chatId: STREAMING,
      messageSeq: 7,
      delta: 'Hello',
    });
  });
}

function delta(text: string): void {
  act(() => {
    useChatStore.getState().applyEvent({
      type: 'chat.message_delta',
      chatId: STREAMING,
      messageSeq: 7,
      delta: text,
    });
  });
}

describe('sidebar render cost while a reply streams', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    useUiStore.getState().setSearchQuery('');
    counter.rows = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the chats container and row identical when a delta changes no field', () => {
    seed();
    openTurn();

    const before = useChatStore.getState().chats;
    const rowBefore = before[STREAMING];

    delta(' world');

    const after = useChatStore.getState().chats;
    // The transcript changed; nothing about any sidebar ROW did.
    expect(after[STREAMING]).toBe(rowBefore);
    expect(after).toBe(before);
  });

  it('renders zero sidebar rows across a burst of streamed tokens', () => {
    seed();
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    openTurn();

    // Mount + the first (genuinely row-changing) delta are the baseline.
    counter.rows = 0;

    for (let i = 0; i < 25; i++) delta(`tok${i}`);

    expect(counter.rows).toBe(0);
  });
});
