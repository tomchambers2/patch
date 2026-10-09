// The live send path, end to end through the surface, as the host actually
// drives it: optimistic bubble → `chat.input_ack` → the persisted user turn →
// whatever the turn produced. Two failures observed in production (2026-08-07)
// are pinned here, because every existing test proved a different sequence:
//
//   1. The turn's user message rendered TWICE. The optimistic bubble is
//      reconciled against the persisted echo, and the host now ships a
//      `localId` on it — but the surface reconciles on `localId !== undefined`
//      AND exact content, so any live event that clears the localId first (the
//      ack path) leaves nothing to match and the persisted copy appends.
//   2. A turn that FAILED rendered as nothing at all. `chat.error` is a
//      first-class transcript event on the wire and the host emits it at a
//      canonical seq, but the surface's reducer had no case for it: the message
//      sat there with no reply and no reason (spec/12 — "no fallbacks. when
//      something breaks, it's visible, not silently absorbed").

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
  },
}));

const CHAT = 'c-live';

function seedRow(): void {
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: null,
      folder: '/home/claude-dev/Unite',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

/** Every event the surface receives goes through both observers, in ws.ts order. */
function receive(event: Record<string, unknown>): void {
  deliveryTracker.observe(event as never);
  useChatStore.getState().applyEvent(event as never);
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('a message sent into a live chat', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    seedRow();
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('renders ONCE when the host echoes it back as the persisted user turn', () => {
    useChatStore.getState().addLocalMessage(CHAT, 'hey', 'lid-1', '/home/claude-dev/Unite');
    receive({ type: 'chat.input_ack', chatId: CHAT, localId: 'lid-1' });
    receive({
      type: 'chat.message',
      chatId: CHAT,
      role: 'user',
      content: 'hey',
      seq: 0,
      localId: 'lid-1',
    });

    const users = useChatStore
      .getState()
      .timelines[CHAT]!.filter((e) => e.kind === 'message' && e.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.seq).toBe(0);

    renderChat();
    expect(screen.getAllByText('hey')).toHaveLength(1);
  });

  it('reconciles on localId even when the persisted text differs from what was typed', () => {
    // The host persists what the transcript will yield, which is not always
    // byte-identical to the composer's text. localId is the identity; content
    // is not.
    useChatStore.getState().addLocalMessage(CHAT, 'hey', 'lid-2', '/home/claude-dev/Unite');
    receive({
      type: 'chat.message',
      chatId: CHAT,
      role: 'user',
      content: 'hey ',
      seq: 0,
      localId: 'lid-2',
    });

    const users = useChatStore
      .getState()
      .timelines[CHAT]!.filter((e) => e.kind === 'message' && e.role === 'user');
    expect(users).toHaveLength(1);
  });

  it('shows the failure on the originating message (tap to retry), not a standalone error line, when the turn errors', () => {
    // spec/12 — an unclassified sdk_error is attached to the message that
    // failed via the seq of its persisted echo (causeSeq), same "tap to
    // retry" treatment as an undelivered input, rather than a separate error
    // row. Not localId: the persisted echo (below) reconciles and clears the
    // optimistic entry's localId before the SDK query that can fail even
    // starts, so causeSeq is the only identity that survives to attach to.
    useChatStore.getState().addLocalMessage(CHAT, 'hey', 'lid-3', '/home/claude-dev/Unite');
    receive({
      type: 'chat.message',
      chatId: CHAT,
      role: 'user',
      content: 'hey',
      seq: 0,
      localId: 'lid-3',
    });
    receive({
      type: 'chat.error',
      chatId: CHAT,
      error: { code: 'sdk_error', message: 'the agent backend is not installed on this machine' },
      seq: 1,
      causeSeq: 0,
    });

    const errors = useChatStore.getState().timelines[CHAT]!.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(0);
    const failedMessage = useChatStore
      .getState()
      .timelines[CHAT]!.find((e) => e.kind === 'message' && e.seq === 0);
    expect(failedMessage?.turnFailed).toBe(true);
    expect(failedMessage?.turnErrorMessage).toBe(
      'the agent backend is not installed on this machine',
    );

    renderChat();
    expect(screen.getByTestId('turn-failed')).toBeInTheDocument();
  });

  // Opening a chat on a cold start asks for its transcript (ChatRoute mounts and
  // requests a replay); the socket finishing its connect a moment later asks
  // AGAIN for every held chat — and the active chat is held even with an empty
  // timeline. Both requests carry `fromSeq: -1`, because neither has rendered
  // anything yet, so the host honours both and the ENTIRE transcript arrives
  // twice. That is what put two of every message on screen.
  //
  // The cursor race is worth avoiding, but the durable guarantee is here: a
  // persisted event carries a canonical seq — "the seq a surface saw live is the
  // seq that message replays under" — so re-applying one must update the turn in
  // place, never append a second copy, no matter how many replays arrive.
  it('renders a transcript once when the whole replay arrives twice', () => {
    const transcript = [
      { type: 'chat.message', chatId: CHAT, role: 'user', content: 'hey', seq: 0 },
      { type: 'chat.message', chatId: CHAT, role: 'assistant', content: 'hello back', seq: 1 },
    ];
    for (const e of transcript) receive(e);
    for (const e of transcript) receive(e);

    const messages = useChatStore.getState().timelines[CHAT]!.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(2);

    renderChat();
    expect(screen.getAllByText('hey')).toHaveLength(1);
    expect(screen.getAllByText('hello back')).toHaveLength(1);
  });

  it('still renders two turns that happen to say the same thing', () => {
    // Dedup is on the canonical seq, not on the text: asking the same question
    // twice is an ordinary thing to do.
    receive({ type: 'chat.message', chatId: CHAT, role: 'user', content: 'again?', seq: 0 });
    receive({ type: 'chat.message', chatId: CHAT, role: 'user', content: 'again?', seq: 2 });
    expect(
      useChatStore.getState().timelines[CHAT]!.filter((e) => e.kind === 'message'),
    ).toHaveLength(2);
  });

  it('does not stack the same error twice when it is replayed', () => {
    const err = {
      type: 'chat.error',
      chatId: CHAT,
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
    };
    receive(err);
    receive(err);
    expect(useChatStore.getState().timelines[CHAT]!.filter((e) => e.kind === 'error')).toHaveLength(
      1,
    );
  });
});
