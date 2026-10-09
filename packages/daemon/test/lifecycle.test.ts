// Group 7: chat lifecycle (spawn, pin, archive, resume, replay, sweep).
//
// Tests the host's public action interface end-to-end with the mock SDK.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatNotFoundError, Daemon, FolderNotFoundError } from '../src/chatRunner.js';
import * as chatRunnerModule from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createHistoryReader, encodeFolder } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup(opts: { now?: () => number; claudeProjectsRoot?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-life-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-life-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const claudeRoot = opts.claudeProjectsRoot ?? mkdtempSync(join(tmpdir(), 'patch-life-claude-'));
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: opts.now ?? (() => 1_700_000_000_000),
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
  });
  return { daemon, sdk, events, home, folder, metaStore, claudeRoot };
}

describe('Host lifecycle (group 7)', () => {
  it('spawnChat allocates ULID-shaped id when no chatId is supplied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-life-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-life-folder-')));
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'x',
      emit: () => {},
      logger: silent,
    });
    const chatId = await daemon.spawnChat({ folder });
    // ULID is 26 chars, Crockford base32 (no I, L, O, U)
    expect(chatId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('spawnChat honours server-allocated chatId', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, chatId: '01HABCDABCDABCDABCDABCDABC' });
    expect(chatId).toBe('01HABCDABCDABCDABCDABCDABC');
    const state = daemon.chatState.get(chatId);
    expect(state?.folder).toBe(folder);
  });

  it('spawnChat throws FolderNotFoundError for missing folders', async () => {
    const { daemon } = setup();
    await expect(daemon.spawnChat({ folder: '/no/such/place-xyz' })).rejects.toThrow(
      FolderNotFoundError,
    );
  });

  it('spawnChat persists pinned/status defaults in meta.json', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const meta = metaStore.read(chatId);
    expect(meta?.pinned).toBe(false);
    expect(meta?.status).toBe('active');
    expect(meta?.archivedAt).toBe(null);
  });

  it('spawnChat is idempotent on localId', async () => {
    const { daemon, folder } = setup();
    const a = await daemon.spawnChat({ folder, localId: 'spawn-1' });
    const b = await daemon.spawnChat({ folder, localId: 'spawn-1' });
    expect(a).toBe(b);
  });

  it('setPinned persists + emits chat.state with pinned=true and pinnedAt set', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.setPinned(chatId, true);
    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv).toBeDefined();
    expect(stateEv && 'pinned' in stateEv && stateEv.pinned).toBe(true);
    // group 8 task 4: chat.state must carry pinnedAt for sidebar ordering.
    expect(stateEv && 'pinnedAt' in stateEv && stateEv.pinnedAt).toBe(1_700_000_000_000);
    expect(metaStore.read(chatId)?.pinned).toBe(true);
    expect(metaStore.read(chatId)?.pinnedAt).toBe(1_700_000_000_000);
  });

  it('setArchived persists + emits chat.state with status=archived', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.setArchived(chatId, true);
    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'status' in stateEv && stateEv.status).toBe('archived');
    expect(metaStore.read(chatId)?.status).toBe('archived');
  });

  it('setPinned/setArchived on unknown chat → ChatNotFoundError', async () => {
    const { daemon } = setup();
    await expect(daemon.setPinned('nope', true)).rejects.toThrow(ChatNotFoundError);
    await expect(daemon.setArchived('nope', true)).rejects.toThrow(ChatNotFoundError);
  });

  // E5: soft-delete moves a chat to status=deleted (out of active + archived
  // lists); restore returns it to active. Recoverable — nothing hard-deleted.
  it('setDeleted persists status=deleted, hides from active/archived, and restores', async () => {
    const { daemon, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.setDeleted(chatId, true);
    const delEv = events.find((e) => e.type === 'chat.state');
    expect(delEv && 'status' in delEv && delEv.status).toBe('deleted');
    expect(metaStore.read(chatId)?.status).toBe('deleted');
    // Excluded from the active list and the archived-only list...
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(false);
    expect(daemon.listWithFilter({ archived: 'include' }).some((c) => c.chatId === chatId)).toBe(
      false,
    );
    expect(daemon.listWithFilter({ archived: 'only' }).some((c) => c.chatId === chatId)).toBe(
      false,
    );
    // ...but present in the deleted-only list.
    expect(daemon.listWithFilter({ deleted: 'only' }).some((c) => c.chatId === chatId)).toBe(true);
    // Restore brings it back to active.
    events.length = 0;
    await daemon.setDeleted(chatId, false);
    const restoreEv = events.find((e) => e.type === 'chat.state');
    expect(restoreEv && 'status' in restoreEv && restoreEv.status).toBe('active');
    expect(metaStore.read(chatId)?.status).toBe('active');
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(true);
  });

  it('setDeleted is idempotent (re-emits state) and rejects an unknown chat', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setDeleted(chatId, true);
    events.length = 0;
    await daemon.setDeleted(chatId, true); // already deleted → re-emit, no change
    expect(events.filter((e) => e.type === 'chat.state').length).toBe(1);
    await expect(daemon.setDeleted('nope', true)).rejects.toThrow(ChatNotFoundError);
  });

  // E3: auto-archive has been removed entirely. Chats never leave the active
  // list on their own — they stay until manually archived (spec/04 + spec/14).
  it('E3: auto-archive machinery is gone (no sweep constant, no runArchiveSweep, chats never self-archive)', async () => {
    let now = 1_700_000_000_000;
    const { daemon, folder } = setup({ now: () => now });
    const c1 = await daemon.spawnChat({ folder });
    // The removed public/module surface is gone.
    expect(
      (chatRunnerModule as unknown as Record<string, unknown>).AUTO_ARCHIVE_INACTIVITY_MS,
    ).toBeUndefined();
    expect(
      (chatRunnerModule as unknown as Record<string, unknown>).AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
    ).toBeUndefined();
    expect((daemon as unknown as Record<string, unknown>).runArchiveSweep).toBeUndefined();
    // No amount of idle time archives an idle chat.
    now += 24 * 60 * 60 * 1000;
    expect(daemon.chatState.get(c1)?.status).toBe('active');
  });

  // Todoist 6hXRrVfCVgCrvC86: any send un-archives, from any sender — a
  // background job/agent messaging into a hidden chat is exactly the case
  // that should bring it back into view. This replaced the earlier one-way
  // stickiness where only an explicit setArchived(false) could un-archive.
  it('sendInput un-archives a chat — a message brings it back to the home screen', async () => {
    const { daemon, sdk, folder, events, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setArchived(chatId, true);
    events.length = 0;
    sdk.enqueue([{ type: 'assistant', content: 'reply' }]);
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1' });
    // The turn still ran — the reply was produced.
    const assistant = events.find(
      (e) => e.type === 'chat.message' && (e as { role?: string }).role === 'assistant',
    );
    expect(assistant).toBeDefined();
    // ...and the chat came back to active, in memory and on disk.
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(metaStore.read(chatId)?.status).toBe('active');
    // ...so it reappears in the active (home-screen) list.
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(true);
    expect(daemon.listWithFilter({ archived: 'only' }).some((c) => c.chatId === chatId)).toBe(
      false,
    );
    // A chat.state was emitted flipping it to active.
    const activeStateEvs = events.filter(
      (e) => e.type === 'chat.state' && 'status' in e && e.status === 'active',
    );
    expect(activeStateEvs.length).toBeGreaterThan(0);
  });

  // A machine turn — a job tick, another agent's `patch_send_to` — un-archives
  // exactly like a user's own message. Scope was the open question on the
  // Todoist task; Tom confirmed it should cover every sender, not just his own
  // typed messages.
  it('a machine-origin sendInput un-archives a chat too', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setArchived(chatId, true);
    sdk.enqueue([{ type: 'assistant', content: 'reply' }]);
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1', origin: 'machine' });
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(true);
  });

  it('resumeChat hydrates from disk if not in memory', async () => {
    const { daemon, folder, metaStore } = setup();
    metaStore.write({
      chatId: 'persisted-1',
      folder,
      name: null,
      claudeSessionId: 'sess-X',
      nextSeq: 5,
      pinned: false,
      pinnedAt: null,
      status: 'active',
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    });
    // Host hasn't hydrated; resume should pull from disk.
    const state = await daemon.resumeChat('persisted-1');
    expect(state.chatId).toBe('persisted-1');
    expect(state.claudeSessionId).toBe('sess-X');
    expect(state.activity).toBe('idle');
  });

  // todo: "Archive should remove it from the home screen." Opening/resuming an
  // archived chat must NOT silently un-archive it — that would put it back on
  // the home screen just for being opened. It stays archived (still openable and
  // sendable) until an explicit unarchive.
  it('resumeChat keeps an archived chat archived — opening does not pop it back', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setArchived(chatId, true);
    const state = await daemon.resumeChat(chatId);
    expect(state.status).toBe('archived');
    expect(metaStore.read(chatId)?.status).toBe('archived');
    expect(daemon.listWithFilter().some((c) => c.chatId === chatId)).toBe(false);
  });

  it('resume after restart: sendInput passes claudeSessionId to SDK', async () => {
    const { daemon, folder, metaStore, sdk } = setup();
    metaStore.write({
      chatId: 'rehy-1',
      folder,
      name: null,
      claudeSessionId: 'sess-resume',
      nextSeq: 0,
      pinned: false,
      pinnedAt: null,
      status: 'active',
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();
    sdk.enqueue([{ type: 'assistant', content: 'continued' }]);
    await daemon.sendInput({ chatId: 'rehy-1', message: 'continue', localId: 'L1' });
    const last = sdk.lastOptions();
    expect(last?.resumeSessionId).toBe('sess-resume');
  });

  it('SDK session-invalid → status=errored, claudeSessionId cleared, chat.error code=claude_session_invalid', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-life-'));
    const folderLocal = realpathSync(mkdtempSync(join(tmpdir(), 'patch-life-folder-')));
    mkdirSync(folderLocal, { recursive: true });
    const metaStoreLocal = createMetaStore(home);
    const events: WireEvent[] = [];
    let throwSessionInvalid = false;
    const customSdk = {
      async *run(_opts: import('../src/sdkBackend.js').SdkRunOptions) {
        if (throwSessionInvalid) {
          throw new Error('session not found: sess-stale');
        }
        yield { type: 'result' as const, sessionId: 'sess-stale' };
        yield { type: 'assistant' as const, content: 'ok', sessionId: 'sess-stale' };
      },
    };
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: metaStoreLocal,
      sdkBackend: customSdk,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
    });

    const chatId = await daemon.spawnChat({ folder: folderLocal, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    expect(metaStoreLocal.read(chatId)?.claudeSessionId).toBe('sess-stale');

    events.length = 0;
    throwSessionInvalid = true;
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });

    const errEv = events.find((e) => e.type === 'chat.error');
    expect(errEv).toBeDefined();
    expect(errEv && 'error' in errEv && errEv.error).toMatchObject({
      code: 'claude_session_invalid',
    });
    // Session id was cleared so the next turn starts fresh.
    expect(metaStoreLocal.read(chatId)?.claudeSessionId).toBeUndefined();
    // Chat status flipped to errored per spec/04 line 46.
    expect(daemon.chatState.get(chatId)?.status).toBe('errored');
  });

  it('SDK "No conversation found with session ID" → classified as claude_session_invalid (lost transcript), session cleared, recoverable', async () => {
    // The real Claude Agent SDK / CLI rejects a resume to a session whose
    // transcript was removed with "No conversation found with session ID:
    // <uuid>". This MUST be treated as a lost session (clear claudeSessionId
    // so the next turn starts fresh), not a permanent generic sdk_error that
    // re-attempts the dead resume forever (the live manager-thread bug).
    const home = mkdtempSync(join(tmpdir(), 'patch-life-noconv-'));
    const folderLocal = realpathSync(mkdtempSync(join(tmpdir(), 'patch-life-noconv-folder-')));
    mkdirSync(folderLocal, { recursive: true });
    const metaStoreLocal = createMetaStore(home);
    const events: WireEvent[] = [];
    let throwLost = false;
    const customSdk = {
      async *run(_opts: import('../src/sdkBackend.js').SdkRunOptions) {
        if (throwLost) {
          throw new Error(
            'Claude Code returned an error result: No conversation found with session ID: d78511b4-8260-4251-8b5e-8c26d28c3ec5',
          );
        }
        yield { type: 'result' as const, sessionId: 'sess-lost' };
        yield { type: 'assistant' as const, content: 'ok', sessionId: 'sess-lost' };
      },
    };
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: metaStoreLocal,
      sdkBackend: customSdk,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
    });

    // A chat HYDRATED FROM DISK (resume-only, F1 guard) with a prior session —
    // this is the manager-thread shape that deadlocked: its session id points
    // at a transcript Claude has lost.
    const chatId = 'hydrated-lost-chat';
    metaStoreLocal.write({
      chatId,
      folder: folderLocal,
      name: null,
      claudeSessionId: 'sess-lost-on-disk',
      nextSeq: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();
    expect(metaStoreLocal.read(chatId)?.claudeSessionId).toBe('sess-lost-on-disk');

    events.length = 0;
    throwLost = true;
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });

    const errEv = events.find((e) => e.type === 'chat.error');
    expect(errEv && 'error' in errEv && errEv.error).toMatchObject({
      code: 'claude_session_invalid',
    });
    // Session id cleared → the next input starts a fresh session (recoverable).
    expect(metaStoreLocal.read(chatId)?.claudeSessionId).toBeUndefined();

    // RECOVERY: the lost-session chat must NOT deadlock. Even though it was
    // (effectively) a resume-only chat, after the session is cleared the next
    // turn must start a fresh session and succeed — not fail with
    // `claude_session_missing` forever.
    events.length = 0;
    throwLost = false;
    await daemon.sendInput({ chatId, message: 'recover', localId: 'L2' });
    expect(events.some((e) => e.type === 'chat.error')).toBe(false);
    const assistant = events.find(
      (e) => e.type === 'chat.message' && (e as { role?: string }).role === 'assistant',
    );
    expect(assistant).toBeDefined();
    expect(metaStoreLocal.read(chatId)?.claudeSessionId).toBe('sess-lost');
  });

  it('replayChat reads JSONL and emits events with seq > fromSeq via per-surface emitter', async () => {
    const { daemon, folder, claudeRoot, sdk } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // Fake a session id without running a query.
    const state = daemon.chatState.get(chatId);
    if (!state) throw new Error('state missing');
    state.claudeSessionId = 'sess-history';
    // Write a JSONL file at the expected location.
    const projDir = join(claudeRoot, encodeFolder(folder));
    mkdirSync(projDir, { recursive: true });
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }),
    ].join('\n');
    writeFileSync(join(projDir, 'sess-history.jsonl'), jsonl);
    void sdk; // avoid unused warning
    const captured: WireEvent[] = [];
    daemon.replayChat(chatId, 0, (e) => captured.push(e));
    expect(captured.length).toBeGreaterThan(0);
    // spec/03 § Host events — the replay leads with the chat's identity frame,
    // which names the MACHINE the chat is pinned to. A surface replaying a chat
    // it never saw spawned would otherwise have to infer that from whichever
    // link it happens to be talking to. It carries no `seq` (spec/03 § Goals),
    // so it does not disturb the sequenced stream that follows.
    expect(captured[0]).toMatchObject({ type: 'chat.spawned', chatId, daemonId: 'd1' });
    expect(captured[0]).not.toHaveProperty('seq');
    // spec/04 § Branching — a replay also publishes the chat's track graph, so
    // the transcript itself is everything BUT those two events.
    expect(captured.filter((e) => e.type === 'chat.branches')).toHaveLength(1);
    // A replay also tops up with the chat's CURRENT chat.state (patch/todo.md
    // — "Patch showing stop after message has returned"), so a reconnecting
    // surface converges on the real activity even if it missed the live
    // running -> idle edge while disconnected.
    expect(captured.filter((e) => e.type === 'chat.state')).toHaveLength(1);
    expect(
      captured
        .filter(
          (e) => e.type !== 'chat.branches' && e.type !== 'chat.spawned' && e.type !== 'chat.state',
        )
        .every((e) => e.type === 'chat.message'),
    ).toBe(true);
  });
});
