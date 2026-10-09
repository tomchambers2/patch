// `ensureChat` — the optimistic row a freshly-created chat needs BEFORE the
// host's `chat.spawned` lands (spec/15 § New chat flow).
//
// Why this exists at all: `app/new-chat.tsx` navigates to `/chats/<id>` the
// instant `POST /api/chats` returns 202, which is well before the host has
// spawned anything. Without a row in the store at that moment the chat is not
// a key of `chatStore.chats`, and `api/ws.ts`'s connect handler only replays —
// and therefore only SUBSCRIBES to — chats it finds by iterating
// `Object.keys(chats)`. The server gates `chat.message` / `chat.tool_call` /
// `chat.tool_result` / `chat.permission_request` on that per-connection
// subscription (`DETAIL_LEVEL_EVENT_TYPES` in `packages/server/src/ws-hub.ts`),
// so an unsubscribed chat receives no assistant reply, ever. That is the
// "new chat locked up on mobile" report. Web has never had it because
// `NewChatRoute.tsx` calls its own `ensureChat` before navigating.
//
// These tests pin the store half: the row exists immediately, and the real
// server events reconcile ONTO it rather than duplicating it.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chatStore.ensureChat', () => {
  it('seeds the row synchronously, so the chat is addressable the moment createChat returns', () => {
    useChatStore.getState().ensureChat('c_new', '/home/tom/projects/portfolio');
    const row = useChatStore.getState().chats['c_new'];
    expect(row).toBeDefined();
    expect(row?.folder).toBe('/home/tom/projects/portfolio');
    // The host is genuinely unknown until `chat.spawned` names it — empty is
    // the honest value, and every host-scoped action already checks for it.
    expect(row?.daemonId).toBe('');
    expect(row?.chatId).toBe('c_new');
  });

  it('is a no-op on an existing row — never clobbers state the host has already set', () => {
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c_new',
      daemonId: 'd1',
      activity: 'running',
      permissionMode: 'bypassPermissions',
      lastUpdated: 500,
    });
    // A second call (a re-render, a retried tap) must not reset the row.
    useChatStore.getState().ensureChat('c_new', '/somewhere/else');
    const row = useChatStore.getState().chats['c_new'];
    expect(row?.folder).toBe('/home/tom/work');
    expect(row?.activity).toBe('running');
    expect(row?.permissionMode).toBe('bypassPermissions');
  });

  it('chat.spawned reconciles ONTO the optimistic row — one row, not two', () => {
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    expect(Object.keys(useChatStore.getState().chats)).toEqual(['c_new']);

    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      chatId: 'c_new',
      daemonId: 'd1',
      folder: '/home/tom/work',
    });

    // Still exactly one row, now carrying the host the host named.
    expect(Object.keys(useChatStore.getState().chats)).toEqual(['c_new']);
    const row = useChatStore.getState().chats['c_new'];
    expect(row?.daemonId).toBe('d1');
    expect(row?.folder).toBe('/home/tom/work');
  });

  it('the optimistic row does not swallow the first turn: replay reconciles in place', () => {
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      chatId: 'c_new',
      daemonId: 'd1',
      folder: '/home/tom/work',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c_new',
      seq: 0,
      role: 'user',
      content: 'first turn',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c_new',
      seq: 1,
      role: 'assistant',
      content: 'reply',
    });
    // A second replay of the same transcript (opening the chat asks for one,
    // the socket completing its connect asks again) must not double it.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c_new',
      seq: 0,
      role: 'user',
      content: 'first turn',
    });

    expect(Object.keys(useChatStore.getState().chats)).toEqual(['c_new']);
    const tl = useChatStore.getState().timelines['c_new'] ?? [];
    expect(tl.filter((e) => e.kind === 'message').map((e) => [e.seq, e.content])).toEqual([
      [0, 'first turn'],
      [1, 'reply'],
    ]);
    // (The row's `preview` deliberately tracks the LAST chat.message applied,
    // including a re-replayed older one — pre-existing store behaviour, not
    // something the optimistic row changes.)
  });

  it('a spawn REJECTION still lands in the transcript as a visible error (spec/12 § No fallbacks)', () => {
    // The optimistic row must not become a permanently silent empty screen when the
    // host refuses the spawn. `chat.error` is deliberately NOT in the
    // server's `DETAIL_LEVEL_EVENT_TYPES`, so it reaches the surface whether
    // or not the replay subscription has landed, and the detail screen renders
    // it as the red `turn-error` alert row.
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c_new',
      seq: 0,
      error: { code: 'no_model_catalogue', message: 'that machine has no last-used model' },
    });
    const tl = useChatStore.getState().timelines['c_new'] ?? [];
    const err = tl.find((e) => e.kind === 'error');
    expect(err?.errorCode).toBe('no_model_catalogue');
    expect(err?.content).toBe('that machine has no last-used model');
  });
});
