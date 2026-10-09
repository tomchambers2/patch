// spec/14 § Composer — unsent composer text is OWNED by the chat it was typed
// in. It follows that chat: it is still there when you come back, and it is
// never shown in a different chat.
//
// Two mechanisms together. `key={chatId}` on <Composer> forces a remount on
// every client-side navigation (archive's navigateAfterArchive, a sidebar row
// click, a keyboard switch), so no instance's local `value` can survive a
// chatId change and leak; `composerDraftStore` is what then puts the RIGHT
// chat's text back. Drop either and the feature is wrong in one direction.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { useComposerAttachmentStore } from '../stores/composerAttachmentStore.js';

// `hydrate` REPLACES the whole `chats` map from the rows it's given (it must
// — it's also how a chat disappearing server-side is reflected locally), so
// both chats have to be seeded in ONE call or the second call wipes the
// first back out.
function seedChats(chatIds: string[]): void {
  useChatStore.getState().hydrate(
    chatIds.map((chatId) => ({
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
    })),
  );
}

/** Two known chats + plain client-side links between them, mirroring how the
 *  sidebar/archive navigation moves the user between chats without a full
 *  page reload. */
function renderChatSwitcher(chatIdA: string, chatIdB: string) {
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatIdA}`]}>
      <Routes>
        <Route
          path="/chats/:chatId"
          element={
            <>
              <Link to={`/chats/${chatIdA}`} data-testid="switch-to-a">
                a
              </Link>
              <Link to={`/chats/${chatIdB}`} data-testid="switch-to-b">
                b
              </Link>
              <ChatRoute ws={null} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute composer isolation across navigation', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.getState().clearFileDiff();
    useUiStore.setState({ pendingDiffByChat: {} });
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    // The store is module-level and its localStorage is shared by every test
    // in this file, so reset both per test rather than in a global afterEach.
    window.localStorage.clear();
    useComposerDraftStore.getState()._reset();
    useComposerAttachmentStore.getState()._reset();
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('does not leak unsent composer text from one chat into another on navigation', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'unsent message for chat_a' } });
    expect(input).toHaveValue('unsent message for chat_a');

    fireEvent.click(screen.getByTestId('switch-to-b'));

    // Landed on chat_b's composer — must be empty, not carrying chat_a's text.
    const nextInput = screen.getByTestId('composer-input');
    expect(nextInput).toHaveValue('');
  });

  it('restores a chat s own unsent text when you come back to it', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'unsent message for chat_a' },
    });
    fireEvent.click(screen.getByTestId('switch-to-b'));
    expect(screen.getByTestId('composer-input')).toHaveValue('');

    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getByTestId('composer-input')).toHaveValue('unsent message for chat_a');
  });

  it('each chat keeps its own text — neither one is ever shown the other s', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'A text' } });
    fireEvent.click(screen.getByTestId('switch-to-b'));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'B text' } });

    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getByTestId('composer-input')).toHaveValue('A text');
    fireEvent.click(screen.getByTestId('switch-to-b'));
    expect(screen.getByTestId('composer-input')).toHaveValue('B text');
  });

  it('an emptied composer leaves nothing to restore', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'typed' } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '' } });

    fireEvent.click(screen.getByTestId('switch-to-b'));
    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(useComposerDraftStore.getState().drafts).not.toHaveProperty('chat_a');
  });

  // The two halves of this feature pull against each other: remember what was
  // typed (above), but a composer typed into and then emptied has NOTHING to
  // remember. Whitespace is emptied — a draft of spaces is not a draft.
  // Attached files (including a long paste, which becomes a .md attachment)
  // belong to the chat they were attached in, exactly like unsent text.
  it('keeps a chat s attached files when you switch away and back, and never shows them elsewhere', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    const pasted = 'x'.repeat(10000);
    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: { items: [], getData: () => pasted },
    });
    expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('switch-to-b'));
    expect(screen.queryAllByTestId('composer-attachment')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);
  });

  it('whitespace-only text is not a draft — nothing is stored or restored', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '   \n  ' } });
    expect(useComposerDraftStore.getState().drafts).not.toHaveProperty('chat_a');

    fireEvent.click(screen.getByTestId('switch-to-b'));
    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getByTestId('composer-input')).toHaveValue('');
  });

  it('typing, deleting and retyping ends with the LAST text, not the first', () => {
    seedChats(['chat_a', 'chat_b']);
    renderChatSwitcher('chat_a', 'chat_b');

    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'first thought' } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: 'second thought' } });

    fireEvent.click(screen.getByTestId('switch-to-b'));
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getByTestId('composer-input')).toHaveValue('second thought');
  });

  // A draft the browser cannot persist must SAY so (portfolio CLAUDE.md — no
  // fallbacks): the words are still on screen, but they are about to be lost.
  it('surfaces an error when the draft cannot be persisted', () => {
    seedChats(['chat_a', 'chat_b']);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      renderChatSwitcher('chat_a', 'chat_b');
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'unsaveable' } });
    } finally {
      spy.mockRestore();
    }
    expect(useUiStore.getState().errors.some((t) => /unsent message/i.test(t.message))).toBe(true);
  });

  it('a successful send clears that chat s entry — returning shows an empty composer', () => {
    seedChats(['chat_a', 'chat_b']);
    // ChatRoute needs a live socket to accept a send; a stub is enough here
    // (the send path is proved in ChatRoute.test.tsx).
    setActiveWs({
      send: () => {},
      requestReplay: () => {},
    } as unknown as Parameters<typeof setActiveWs>[0]);
    render(
      <MemoryRouter initialEntries={['/chats/chat_a']}>
        <Routes>
          <Route
            path="/chats/:chatId"
            element={
              <>
                <Link to="/chats/chat_a" data-testid="switch-to-a">
                  a
                </Link>
                <Link to="/chats/chat_b" data-testid="switch-to-b">
                  b
                </Link>
                <ChatRoute ws={{ send: () => {}, requestReplay: () => {} } as never} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'a message that gets sent' } });
    expect(useComposerDraftStore.getState().get('chat_a')).toBe('a message that gets sent');

    fireEvent.submit(screen.getByTestId('composer'));

    expect(useComposerDraftStore.getState().get('chat_a')).toBe('');
    fireEvent.click(screen.getByTestId('switch-to-b'));
    fireEvent.click(screen.getByTestId('switch-to-a'));
    expect(screen.getByTestId('composer-input')).toHaveValue('');
  });
});
