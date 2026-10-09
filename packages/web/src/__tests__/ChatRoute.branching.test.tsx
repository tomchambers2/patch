// spec/04 § Branching + spec/14 § Main chat panel ("Edit / fork a turn, and
// switch tracks") — a chat is a graph: editing a user turn forks a new track
// from it, and a fork point offers a track switcher.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useSideThreadsStore, DRAFT_TAB_ID } from '../stores/sideThreadsStore.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getChatHistory: vi.fn().mockResolvedValue({ events: [] }),
  },
}));

function seedChat(chatId: string, timeline: ChatEventEntry[]): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: timeline } }));
}

function renderChat(chatId: string, ws: Parameters<typeof ChatRoute>[0]['ws'] = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TWO_TRACKS = {
  type: 'chat.branches' as const,
  chatId: 'c-fork',
  activeBranchId: 'b1',
  branches: [
    { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
    { branchId: 'b1', parentBranchId: 'b0', forkFromSeq: 4, label: 'edit 1', createdAt: 1 },
  ],
};

beforeEach(() => {
  useChatStore.getState()._reset();
  useUiStore.getState().clearToasts();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHostOnline('d1', true);
  setActiveWs(null);
});
afterEach(() => cleanup());

describe('editing a user turn forks a track', () => {
  it('offers an edit affordance on a settled USER turn only', () => {
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
      // Still in flight (carries a localId) — it is not in the transcript yet,
      // so there is nothing to fork from.
      { seq: 6, kind: 'message', role: 'user', content: 'in flight', localId: 'L9', at: 0 },
    ]);
    renderChat('c-fork');
    expect(screen.getAllByTestId('msg-edit')).toHaveLength(1);
  });

  it('saving an edit fires chat.fork_request with that turn seq and the new text', () => {
    const send = vi.fn();
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('msg-edit'));
    const field = screen.getByTestId('msg-edit-input') as HTMLTextAreaElement;
    // Pre-filled with the turn's own text — an edit, not a blank composer.
    expect(field.value).toBe('ask one');
    fireEvent.change(field, { target: { value: 'ask one, rephrased' } });
    fireEvent.click(screen.getByTestId('msg-edit-save'));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.fork_request',
        chatId: 'c-fork',
        seq: 4,
        message: 'ask one, rephrased',
      }),
    );
    // The old track's transcript is dropped — the host's replay of the new
    // track is the authority, so no stale turns linger from the track we left.
    expect(useChatStore.getState().timelines['c-fork']).toEqual([]);
  });

  it('cancelling an edit sends nothing and restores the message', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('msg-edit'));
    fireEvent.click(screen.getByTestId('msg-edit-cancel'));
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByTestId('msg-edit-input')).toBeNull();
    expect(screen.getByTestId('msg-content').textContent).toContain('ask one');
  });

  // spec/14 § Keyboard shortcuts — `⌘↵` commits the field being typed in. The
  // message editor had NO key handler at all, so the only way to save an edited
  // turn was to take your hands off the keyboard and find the button.
  it('⌘↵ in the edit box saves it, exactly as the Save button does', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('msg-edit'));
    const field = screen.getByTestId('msg-edit-input');
    fireEvent.change(field, { target: { value: 'ask one, rephrased' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.fork_request',
        chatId: 'c-fork',
        seq: 4,
        message: 'ask one, rephrased',
      }),
    );
    // Saved means closed — the same end state the button leaves behind.
    expect(screen.queryByTestId('msg-edit-input')).toBeNull();
  });

  it('Ctrl↵ saves it too, for the keyboard that has no ⌘', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('msg-edit'));
    fireEvent.change(screen.getByTestId('msg-edit-input'), { target: { value: 'redone' } });
    fireEvent.keyDown(screen.getByTestId('msg-edit-input'), { key: 'Enter', ctrlKey: true });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.fork_request', message: 'redone' }),
    );
  });

  it('bare ↵ and ⇧↵ leave the edit box alone — a turn can be several lines', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('msg-edit'));
    const field = screen.getByTestId('msg-edit-input');
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, shiftKey: true });

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId('msg-edit-input')).toBeTruthy();
  });

  it('⌘↵ cannot fork on an emptied edit box, which is what Save is disabled for', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('msg-edit'));
    const field = screen.getByTestId('msg-edit-input');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByTestId('msg-edit-save')).toBeDisabled();
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId('msg-edit-input')).toBeTruthy();
  });

  it('the Save button names the chord that presses it (spec/14 § Discoverability)', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork');
    fireEvent.click(screen.getByTestId('msg-edit'));
    const save = screen.getByTestId('msg-edit-save');
    // jsdom's navigator is not a Mac, so the chord is named in PC words.
    expect(save.hasAttribute('title')).toBe(false);
    expect(screen.getByTestId('msg-edit-save-chord').textContent).toBe('Ctrl+Enter');
  });

  // The side-thread feature was removed (Todoist) and is now being rebuilt in
  // three steps (spec/04 § Side threads, spec/14 § Side threads panel) — this
  // step wires up the trigger on every settled message, user or assistant.
  it('offers no side-thread affordance on a turn still in flight (no fork point yet)', () => {
    seedChat('c-fork', [
      { seq: 6, kind: 'message', role: 'user', content: 'in flight', localId: 'L9', at: 0 },
    ]);
    renderChat('c-fork');
    expect(screen.queryByTestId('msg-side-thread-trigger')).toBeNull();
  });
});

describe('spec/14 § Side threads panel — trigger', () => {
  beforeEach(() => {
    useSideThreadsStore.setState({
      panelChatId: null,
      activeTabByChatId: {},
      closedTabsByChatId: {},
      tabOrderByChatId: {},
      pendingNewTab: {},
      draftByChatId: {},
    });
  });

  it('hovering reveals a side-thread button on a SETTLED message of either role', () => {
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork');
    expect(screen.getAllByTestId('msg-side-thread-trigger')).toHaveLength(2);
  });

  it('clicking it opens the panel on a draft, "Off <quoted message>", cursor in its composer', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork');
    fireEvent.click(screen.getByTestId('msg-side-thread-trigger'));

    const state = useSideThreadsStore.getState();
    expect(state.panelChatId).toBe('c-fork');
    expect(state.activeTabByChatId['c-fork']).toBe(DRAFT_TAB_ID);
    expect(state.draftByChatId['c-fork']).toEqual({ seq: 4, quotedMessage: 'ask one' });
  });

  it('right-click offers "Open side thread" in the message context menu', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork');
    fireEvent.contextMenu(screen.getByTestId('msg'));
    const item = screen.getByText('Open side thread');
    fireEvent.click(item);

    expect(useSideThreadsStore.getState().draftByChatId['c-fork']).toEqual({
      seq: 4,
      quotedMessage: 'ask one',
    });
  });

  it('a message with a side thread carries a marker; clicking it opens the panel on that tab', async () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-fork',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
        {
          branchId: 'b1',
          parentBranchId: 'b0',
          forkFromSeq: 4,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
          name: 'Annual vs monthly',
        },
      ],
    });
    renderChat('c-fork');
    const marker = await screen.findByTestId('side-thread-marker-b1');
    expect(marker.textContent).toContain('Side thread');

    fireEvent.click(marker);
    const state = useSideThreadsStore.getState();
    expect(state.panelChatId).toBe('c-fork');
    expect(state.activeTabByChatId['c-fork']).toBe('b1');
  });

  it('a side thread is never offered as a track to SWITCH to — only the marker', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-fork',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
        {
          branchId: 'b1',
          parentBranchId: 'b0',
          forkFromSeq: 4,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
        },
      ],
    });
    renderChat('c-fork');
    expect(screen.queryByTestId('track-switcher')).toBeNull();
  });
});

describe('switching between tracks at a fork point', () => {
  it('renders a track switcher on the forked turn showing which track is active', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent(TWO_TRACKS);
    renderChat('c-fork');
    expect(screen.getByTestId('track-switcher').textContent).toContain('2/2');
  });

  it('the ‹ arrow switches to the previous track', () => {
    const send = vi.fn();
    const requestReplay = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent(TWO_TRACKS);
    renderChat('c-fork', { send, requestReplay } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('track-prev'));
    expect(send).toHaveBeenCalledWith({
      type: 'chat.branch_switch_request',
      chatId: 'c-fork',
      branchId: 'b0',
    });
    expect(useChatStore.getState().timelines['c-fork']).toEqual([]);
    // The cleared timeline always recomputes fromSeq -1 — forcing past the
    // dedup cursor is the only way the new track's history actually arrives
    // (see api/ws.ts's requestReplay: without `force` this collides with the
    // cursor cached by the chat's very first load and is silently dropped).
    expect(requestReplay).toHaveBeenCalledWith('c-fork', { force: true });
  });

  it('a chat with a single root track shows no switcher at all', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-fork',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
      ],
    });
    renderChat('c-fork');
    expect(screen.queryByTestId('track-switcher')).toBeNull();
  });
});
