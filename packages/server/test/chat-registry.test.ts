// Group 8 fix (DX-M1): ChatRegistry must gate `chat.state` on a prior
// `chat.spawned` for the same chatId. Without the gate, a host-side
// rejected pin/archive could synthesise a phantom row in `GET /api/chats`.
//
// Also: pinned-by-pinnedAt sort order (group 8 task 4).

import { describe, it, expect } from 'vitest';
import { ChatRegistry, type ChatSummary } from '../src/chat-registry.js';

function silentLogger() {
  return { warn: () => undefined };
}

describe('ChatRegistry phantom-row gating', () => {
  it('chat.state for an unspawned chat is a no-op', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'ghost',
      activity: 'idle',
      lastUpdated: 1,
      pinned: true,
      status: 'archived',
      folder: '/x',
    });
    expect(reg.get('ghost')).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('an ARCHIVED special thread (Speakers) still appears in the default/active list', () => {
    // Special threads are the sidebar's Channels surfaces — they must stay
    // visible even after auto-archiving, so the rows never go dead.
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'thread_speakers', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'thread_speakers',
      activity: 'idle',
      lastUpdated: 1,
      status: 'archived',
      folder: '/x',
    });
    // Default (active-only) list: a normal archived chat would be excluded, but
    // the special thread is included.
    expect(reg.list().some((c) => c.chatId === 'thread_speakers')).toBe(true);
    // Archived-only view does NOT list it — it lives in Channels, not the archive.
    expect(reg.list({ archivedOnly: true }).some((c) => c.chatId === 'thread_speakers')).toBe(
      false,
    );
  });

  it('mirrors pendingWake from chat.state, and lets it clear (patch/todo.md — wake bar)', () => {
    // spec/02 § Self-wake: the pending wake rides on chat.state so a surface can
    // render the countdown bar on REST cold-start too. It CAN clear (the wake
    // fires or is cancelled), so `null` is meaningful — but an OMITTED field
    // (a back-compat payload) must not wipe a known wake.
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'wakey', folder: '/x' });
    expect(reg.get('wakey')?.pendingWake).toBeNull();

    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'wakey',
      activity: 'idle',
      lastUpdated: 1,
      folder: '/x',
      pendingWake: { message: 'check the bus', fireAt: 1_700_000_000_000 },
    });
    expect(reg.get('wakey')?.pendingWake).toEqual({
      message: 'check the bus',
      fireAt: 1_700_000_000_000,
    });

    // Omitted field ⇒ unchanged.
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'wakey',
      activity: 'running',
      lastUpdated: 2,
      folder: '/x',
    });
    expect(reg.get('wakey')?.pendingWake?.message).toBe('check the bus');

    // Explicit null ⇒ cleared (fired or cancelled).
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'wakey',
      activity: 'idle',
      lastUpdated: 3,
      folder: '/x',
      pendingWake: null,
    });
    expect(reg.get('wakey')?.pendingWake).toBeNull();
  });

  it('chat.state after chat.spawned is registered', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'real', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'real',
      activity: 'idle',
      lastUpdated: 1,
      pinned: true,
      status: 'active',
      folder: '/x',
    });
    expect(reg.get('real')?.pinned).toBe(true);
  });

  it('chat.error with folder_not_found removes the chatId', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'doomed', folder: '/x' });
    reg.observe({
      type: 'chat.error',
      chatId: 'doomed',
      error: { code: 'folder_not_found', message: 'no such folder' },
      seq: 0,
    });
    expect(reg.get('doomed')).toBeUndefined();
    // And subsequent stray chat.state must not bring it back.
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'doomed',
      activity: 'idle',
      lastUpdated: 1,
    });
    expect(reg.get('doomed')).toBeUndefined();
  });

  it('chat.error with sdk_error keeps the row (chat exists but in errored state)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'live', folder: '/x' });
    reg.observe({
      type: 'chat.error',
      chatId: 'live',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 0,
    });
    expect(reg.get('live')).toBeDefined();
  });
});

describe('ChatRegistry pinnedAt-aware ordering', () => {
  it('pinned chats sort by pinnedAt desc (most-recent-pinned first)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'older-pin', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'older-pin',
      activity: 'idle',
      lastUpdated: 1000,
      pinned: true,
      pinnedAt: 100,
      status: 'active',
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'newer-pin', folder: '/b' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'newer-pin',
      activity: 'idle',
      lastUpdated: 500,
      pinned: true,
      pinnedAt: 200,
      status: 'active',
    });
    const ordered = reg.list().map((c) => c.chatId);
    expect(ordered).toEqual(['newer-pin', 'older-pin']);
  });

  it('non-pinned with newer activity sorts AFTER pinned chats', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'pinned-old-active',
      folder: '/a',
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'pinned-old-active',
      activity: 'idle',
      lastUpdated: 100,
      pinned: true,
      pinnedAt: 50,
      status: 'active',
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'fresh-unpinned', folder: '/b' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'fresh-unpinned',
      activity: 'idle',
      lastUpdated: 9999,
      pinned: false,
      status: 'active',
    });
    const ordered = reg.list().map((c) => c.chatId);
    expect(ordered).toEqual(['pinned-old-active', 'fresh-unpinned']);
  });
});

describe('ChatRegistry soft-delete (E5)', () => {
  function spawnActive(reg: ChatRegistry, chatId: string): void {
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      activity: 'idle',
      lastUpdated: 1,
      pinned: false,
      status: 'active',
    });
  }

  it('setDeleted flips status to deleted → out of active/archived, into deleted-only; restore reverses it', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    spawnActive(reg, 'c1');
    reg.setDeleted('c1', true);
    expect(reg.list().some((c) => c.chatId === 'c1')).toBe(false);
    expect(reg.list({ includeArchived: true }).some((c) => c.chatId === 'c1')).toBe(false);
    expect(reg.list({ archivedOnly: true }).some((c) => c.chatId === 'c1')).toBe(false);
    expect(reg.list({ deletedOnly: true }).map((c) => c.chatId)).toEqual(['c1']);
    reg.setDeleted('c1', false);
    expect(reg.list().some((c) => c.chatId === 'c1')).toBe(true);
    expect(reg.list({ deletedOnly: true }).length).toBe(0);
  });

  it('setDeleted on an unknown chat is a no-op', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    expect(() => reg.setDeleted('nope', true)).not.toThrow();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('a soft-deleted chat also drops out via the host chat.state echo', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    spawnActive(reg, 'c2');
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c2',
      activity: 'idle',
      lastUpdated: 5,
      status: 'deleted',
    });
    expect(reg.list().some((c) => c.chatId === 'c2')).toBe(false);
    expect(reg.list({ deletedOnly: true }).map((c) => c.chatId)).toEqual(['c2']);
  });

  it('reserved special threads never appear in the deleted-only view', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'thread_manager', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'thread_manager',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
    });
    expect(reg.list({ deletedOnly: true }).some((c) => c.chatId === 'thread_manager')).toBe(false);
  });
});

describe('ChatRegistry seed', () => {
  it('seed() admits chats so subsequent chat.state events are accepted', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.seed([
      {
        chatId: 'seeded',
        name: null,
        folder: '/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 0,
      },
    ]);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'seeded',
      activity: 'running',
      lastUpdated: 5,
    });
    expect(reg.get('seeded')?.activity).toBe('running');
  });
});

describe('ChatRegistry lastUserActivity mirroring (spec/14 § Sidebar ordering)', () => {
  it('mirrors lastUserActivity from chat.state', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 500,
      lastUserActivity: 100,
      folder: '/x',
    });
    expect(reg.get('c1')?.lastUserActivity).toBe(100);

    // An agent reply bumps lastUpdated without the user sending anything —
    // lastUserActivity rides along unchanged on the host's own frame.
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 9999,
      lastUserActivity: 100,
      folder: '/x',
    });
    expect(reg.get('c1')?.lastUpdated).toBe(9999);
    expect(reg.get('c1')?.lastUserActivity).toBe(100);
  });

  it('falls back to lastUpdated when a host predating the field omits it', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'old-daemon', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'old-daemon',
      activity: 'idle',
      lastUpdated: 42,
      folder: '/x',
    });
    expect(reg.get('old-daemon')?.lastUserActivity).toBe(42);
  });

  it('preserves the last known lastUserActivity across a chat.state that omits the field', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c2',
      activity: 'idle',
      lastUpdated: 100,
      lastUserActivity: 100,
      folder: '/x',
    });
    // A later frame from a host that forgot to carry the field (or an
    // in-between upgrade) must not blank it back to lastUpdated.
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c2',
      activity: 'idle',
      lastUpdated: 777,
      folder: '/x',
    });
    expect(reg.get('c2')?.lastUpdated).toBe(777);
    expect(reg.get('c2')?.lastUserActivity).toBe(100);
  });
});

describe('ChatRegistry chat.stopped handling', () => {
  it('chat.stopped for an unspawned chat is a no-op (warns, does not throw)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.stopped', chatId: 'ghost', reason: 'user_stop' });
    expect(reg.get('ghost')).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('chat.stopped for a spawned chat is a no-op (host follows with chat.state)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'live', folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'live',
      activity: 'running',
      lastUpdated: 1,
      status: 'active',
    });
    reg.observe({ type: 'chat.stopped', chatId: 'live', reason: 'user_stop' });
    // No-op: the row is unchanged (host separately emits chat.state).
    expect(reg.get('live')?.activity).toBe('running');
  });
});

describe('ChatRegistry inFlightChatIds', () => {
  it('returns only chats with activity running or awaiting-permission', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'idle-one', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'idle-one',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'running-one', folder: '/b' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'running-one',
      activity: 'running',
      lastUpdated: 1,
      status: 'active',
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'awaiting-one', folder: '/c' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'awaiting-one',
      activity: 'awaiting-permission',
      lastUpdated: 1,
      status: 'active',
    });
    expect(reg.inFlightChatIds().sort()).toEqual(['awaiting-one', 'running-one']);
  });
});

describe('ChatRegistry markErrored', () => {
  it('returns null for an unknown chatId', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    expect(reg.markErrored('missing', { code: 'sdk_error', message: 'boom' }, 100)).toBeNull();
  });

  it('resolves a known chat to errored and returns the chat.state event, including folder when present', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'live', folder: '/proj' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'live',
      activity: 'running',
      lastUpdated: 1,
      status: 'active',
      pinned: true,
      pinnedAt: 5,
      name: 'My chat',
      preview: 'hello',
      folder: '/proj',
    });
    const ev = reg.markErrored('live', { code: 'sdk_error', message: 'boom' }, 200);
    expect(ev).not.toBeNull();
    expect(ev?.activity).toBe('errored');
    expect(ev?.folder).toBe('/proj');
    expect(ev?.lastError).toEqual({ code: 'sdk_error', message: 'boom', at: 200 });
    expect(ev?.pinned).toBe(true);
    // The registry mirror itself flips to errored too.
    expect(reg.get('live')?.activity).toBe('errored');
  });

  it('omits `folder` from the emitted event when the mirrored folder is empty', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'nofolder', folder: '/x' });
    // A chat.state with an explicitly empty folder clears the mirrored value
    // (folder: event.folder ?? existing?.folder ?? '').
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'nofolder',
      activity: 'idle',
      lastUpdated: 1,
      status: 'active',
      folder: '',
    });
    const ev = reg.markErrored('nofolder', { code: 'sdk_error', message: 'x' }, 10);
    expect(ev).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(ev ?? {}, 'folder')).toBe(false);
  });
});

describe('ChatRegistry remove', () => {
  it('removes the chat and forgets the spawn marker (a later chat.state is ignored)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'goner', folder: '/x' });
    expect(reg.get('goner')).toBeDefined();
    reg.remove('goner');
    expect(reg.get('goner')).toBeUndefined();
    // spawnedSet was also cleared — a stray chat.state can't resurrect it.
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'goner',
      activity: 'idle',
      lastUpdated: 1,
    });
    expect(reg.get('goner')).toBeUndefined();
  });
});

describe('ChatRegistry list() sort-comparator edge cases', () => {
  function seedChat(
    reg: ChatRegistry,
    chatId: string,
    opts: { pinned: boolean; pinnedAt: number | null; lastUpdated: number },
  ): void {
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      activity: 'idle',
      status: 'active',
      pinned: opts.pinned,
      pinnedAt: opts.pinnedAt,
      lastUpdated: opts.lastUpdated,
    });
  }

  it('two unpinned chats sort by lastUpdated desc', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'older', { pinned: false, pinnedAt: null, lastUpdated: 100 });
    seedChat(reg, 'newer', { pinned: false, pinnedAt: null, lastUpdated: 200 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['newer', 'older']);
  });

  // Array.prototype.sort's comparator argument order (which item lands in
  // `a` vs `b`) is engine-internal — exercise BOTH insertion orders so both
  // arms of `a.pinned !== b.pinned ? a.pinned ? -1 : 1` get hit regardless.
  it('pinned sorts before unpinned (insertion order: pinned, unpinned)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'p', { pinned: true, pinnedAt: 1, lastUpdated: 1 });
    seedChat(reg, 'u', { pinned: false, pinnedAt: null, lastUpdated: 2 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['p', 'u']);
  });

  it('pinned sorts before unpinned (insertion order: unpinned, pinned)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'u', { pinned: false, pinnedAt: null, lastUpdated: 2 });
    seedChat(reg, 'p', { pinned: true, pinnedAt: 1, lastUpdated: 1 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['p', 'u']);
  });

  it('two pinned chats both with pinnedAt=null fall back to lastUpdated desc', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'pinned-older', { pinned: true, pinnedAt: null, lastUpdated: 100 });
    seedChat(reg, 'pinned-newer', { pinned: true, pinnedAt: null, lastUpdated: 200 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['pinned-newer', 'pinned-older']);
  });

  // Same engine-ordering concern for the ap===null / bp===null legs.
  it('null-pinnedAt sorts after real pinnedAt (insertion order: null, real)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'null-pin', { pinned: true, pinnedAt: null, lastUpdated: 999 });
    seedChat(reg, 'real-pin', { pinned: true, pinnedAt: 50, lastUpdated: 1 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['real-pin', 'null-pin']);
  });

  it('null-pinnedAt sorts after real pinnedAt (insertion order: real, null)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'real-pin', { pinned: true, pinnedAt: 50, lastUpdated: 1 });
    seedChat(reg, 'null-pin', { pinned: true, pinnedAt: null, lastUpdated: 999 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['real-pin', 'null-pin']);
  });

  it('two pinned chats with equal pinnedAt fall back to lastUpdated desc', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedChat(reg, 'equal-older', { pinned: true, pinnedAt: 50, lastUpdated: 100 });
    seedChat(reg, 'equal-newer', { pinned: true, pinnedAt: 50, lastUpdated: 200 });
    expect(reg.list().map((c) => c.chatId)).toEqual(['equal-newer', 'equal-older']);
  });
});

describe('ChatRegistry list() filter options on ordinary (non-special) chats', () => {
  function seedPlain(
    reg: ChatRegistry,
    chatId: string,
    status: 'active' | 'archived' | 'errored',
  ): void {
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/x' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      activity: 'idle',
      status,
      lastUpdated: 1,
    });
  }

  it('archivedOnly=true returns only archived ordinary chats', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedPlain(reg, 'active-1', 'active');
    seedPlain(reg, 'archived-1', 'archived');
    expect(reg.list({ archivedOnly: true }).map((c) => c.chatId)).toEqual(['archived-1']);
  });

  it('includeArchived=true returns both active and archived ordinary chats', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedPlain(reg, 'active-1', 'active');
    seedPlain(reg, 'archived-1', 'archived');
    const ids = reg
      .list({ includeArchived: true })
      .map((c) => c.chatId)
      .sort();
    expect(ids).toEqual(['active-1', 'archived-1']);
  });

  it('default list() excludes archived ordinary chats', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    seedPlain(reg, 'active-1', 'active');
    seedPlain(reg, 'archived-1', 'archived');
    expect(reg.list().map((c) => c.chatId)).toEqual(['active-1']);
  });
});

describe('ChatRegistry chat.state omitted fields fall back to the existing mirrored value', () => {
  it('folder/status/pinned are preserved when a later chat.state omits them', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/original' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'archived',
      folder: '/original',
      pinned: true,
    });
    // Second update omits folder/status/pinned entirely — must fall back to
    // the existing mirrored values, not clear them.
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 2,
    });
    const c = reg.get('c1');
    expect(c?.folder).toBe('/original');
    expect(c?.status).toBe('archived');
    expect(c?.pinned).toBe(true);
    expect(c?.activity).toBe('running');
  });
});

describe('ChatRegistry chat.state literal-default fallback (defensive against corrupted mirror state)', () => {
  // `folder`/`status`/`pinned` are non-nullable in ChatSummary, so `existing`
  // (once a chat is spawned) always carries a real value — the `?? <literal>`
  // tail of `event.field ?? existing?.field ?? <literal>` only fires if the
  // mirrored row itself is somehow missing the field. Simulate that corrupted
  // state via `seed()` (e.g. an old on-disk mirror predating a field) to
  // prove the fallback literal actually engages rather than crashing.
  it('falls back to the literal default when both the event and the existing row omit the field', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    const corrupted = {
      chatId: 'legacy',
      name: null,
      preview: null,
      folder: undefined,
      activity: 'idle',
      status: undefined,
      pinned: undefined,
      pinnedAt: null,
      lastUpdated: 0,
    } as unknown as ChatSummary;
    reg.seed([corrupted]);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'legacy',
      activity: 'running',
      lastUpdated: 10,
    });
    const c = reg.get('legacy');
    expect(c?.folder).toBe('');
    expect(c?.status).toBe('active');
    expect(c?.pinned).toBe(false);
  });
});

describe('ChatRegistry chat.spawned is idempotent', () => {
  it('a second chat.spawned for an already-known chatId is a no-op', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 5,
      status: 'active',
    });
    // Re-spawning must not reset the row back to its initial idle/zero state.
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/a' });
    const c = reg.get('c1');
    expect(c?.activity).toBe('running');
    expect(c?.lastUpdated).toBe(5);
  });
});

// spec/08 § Action, spec/14 § Sidebar — the Automations group. A chat's
// jobId comes from the injected `jobChatLinks` lookup (server-owned, keyed
// at dispatch time — see `jobs/chat-links.ts`), NOT from the wire event,
// since an old host never sends one.
describe('ChatRegistry job-chat links (Automations group)', () => {
  function fakeLinks(map: Record<string, string>): { get: (chatId: string) => string | null } {
    return { get: (chatId) => map[chatId] ?? null };
  }

  it('chat.spawned tags jobId from the injected jobChatLinks lookup', () => {
    const reg = new ChatRegistry({
      logger: silentLogger(),
      jobChatLinks: fakeLinks({ auto1: 'j_1' }),
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'auto1', folder: '/a' });
    expect(reg.get('auto1')?.jobId).toBe('j_1');
  });

  it('a chat with no link gets jobId: null', () => {
    const reg = new ChatRegistry({ logger: silentLogger(), jobChatLinks: fakeLinks({}) });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'plain', folder: '/a' });
    expect(reg.get('plain')?.jobId).toBeNull();
  });

  it('jobId is preserved across chat.state updates', () => {
    const reg = new ChatRegistry({
      logger: silentLogger(),
      jobChatLinks: fakeLinks({ auto1: 'j_1' }),
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'auto1', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'auto1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'archived',
      folder: '/a',
    });
    expect(reg.get('auto1')?.jobId).toBe('j_1');
  });

  it('list({ automationsOnly: true }) returns only job-spawned chats, active or archived, never deleted', () => {
    const reg = new ChatRegistry({
      logger: silentLogger(),
      jobChatLinks: fakeLinks({ a1: 'j_1', a2: 'j_2', a3: 'j_3' }),
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'a1', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'a1',
      activity: 'idle',
      lastUpdated: 3,
      status: 'archived',
      folder: '/a',
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'a2', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'a2',
      activity: 'idle',
      lastUpdated: 2,
      status: 'active',
      folder: '/a',
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'a3', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'a3',
      activity: 'idle',
      lastUpdated: 1,
      status: 'deleted',
      folder: '/a',
    });
    // A regular (non-job) chat must never appear.
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'plain', folder: '/a' });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'plain',
      activity: 'idle',
      lastUpdated: 4,
      status: 'active',
      folder: '/a',
    });
    const rows = reg.list({ automationsOnly: true });
    expect(rows.map((c) => c.chatId)).toEqual(['a1', 'a2']);
  });

  it('a special thread never appears under automationsOnly', () => {
    const reg = new ChatRegistry({
      logger: silentLogger(),
      jobChatLinks: fakeLinks({ thread_speakers: 'j_1' }),
    });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'thread_speakers', folder: '/x' });
    expect(reg.list({ automationsOnly: true }).some((c) => c.chatId === 'thread_speakers')).toBe(
      false,
    );
  });
});

// patch/todo.md — "show which model is in use on the top bar". The host
// resolves the model at spawn time and puts it on `chat.spawned`; a later
// mid-chat change arrives on `chat.state` (spec/04 § Model). The registry
// carries both through, never re-deriving either.
describe('ChatRegistry model (top bar)', () => {
  it('chat.spawned sets model from the event', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '/a',
      model: 'claude-x',
    });
    expect(reg.get('c1')?.model).toBe('claude-x');
  });

  it('chat.spawned with no model on the event gets model: null (old host / no catalogue)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/a' });
    expect(reg.get('c1')?.model).toBeNull();
  });

  it('model is preserved across a chat.state that carries none (an old host sends no model)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '/a',
      model: 'claude-x',
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
      status: 'archived',
      folder: '/a',
    });
    expect(reg.get('c1')?.model).toBe('claude-x');
  });

  it('a chat.state carrying a model updates it — that is how a mid-chat switch travels', () => {
    // spec/04 § Model. The registry backs the REST reads, so a surface that
    // cold-starts after a switch has to see the model the chat is now on, not
    // the one it spawned with.
    const reg = new ChatRegistry({ logger: silentLogger() });
    reg.observe({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '/a',
      model: 'claude-x',
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'auto',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      folder: '/a',
      model: 'claude-y',
    });
    expect(reg.get('c1')?.model).toBe('claude-y');
  });
});

// spec/02 § Background task completions + spec/14 § Status badges. The host
// counts each chat's still-running background commands and sub-agents; the
// server mirrors the number so a surface that cold-starts over REST knows a
// chat is still working before the next live `chat.state`. Without the mirror a
// reload would draw the finished tick over a running build for as long as the
// build took, since a state frame only arrives when something changes.
describe('ChatRegistry background-task count', () => {
  function spawned(reg: ChatRegistry): void {
    reg.observe({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' });
  }

  it('starts UNKNOWN, which is not zero', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    spawned(reg);
    expect(reg.get('c1')?.backgroundTasks).toBeNull();
  });

  it('takes the count off chat.state', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    spawned(reg);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'auto',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      backgroundTasks: 3,
    });
    expect(reg.get('c1')?.backgroundTasks).toBe(3);
  });

  it('keeps the known count across a frame that carries none (a host predating the field)', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    spawned(reg);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'auto',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      backgroundTasks: 1,
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'auto',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 3,
    });
    expect(reg.get('c1')?.backgroundTasks).toBe(1);
  });

  it('lets an explicit 0 clear it — the last task finishing is a real event', () => {
    const reg = new ChatRegistry({ logger: silentLogger() });
    spawned(reg);
    reg.observe({
      type: 'chat.state',
      permissionMode: 'auto',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      backgroundTasks: 1,
    });
    reg.observe({
      type: 'chat.state',
      permissionMode: 'auto',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 3,
      backgroundTasks: 0,
    });
    expect(reg.get('c1')?.backgroundTasks).toBe(0);
  });
});
