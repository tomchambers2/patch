// Group 7 integration: server + host wired via InProcessDaemonLink that
// calls the Host's actions directly. Exercises spawn → message → pin →
// archive → resume → replay.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { OUT_OF_BAND_SEQ, type WireEvent, type ChatErrorCode } from '@patch/wire';
import { Daemon, FolderNotFoundError, ChatNotFoundError } from '../../daemon/src/chatRunner.js';
import { createMetaStore } from '../../daemon/src/meta.js';
import { createMockSdkBackend } from '../../daemon/src/sdkBackend.js';
import { createHistoryReader } from '../../daemon/src/history.js';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import type { DaemonLink } from '../src/daemon-link.js';

const silent = pino({ level: 'silent' });

/**
 * A DaemonLink that wires the *real* Host class in-process. Server-bound
 * frames are dispatched to Host actions; daemon-emitted events fan out
 * via `onEvent`.
 */
class WiredDaemonLink implements DaemonLink {
  // Presence names the machine it describes; a stand-in link is still a
  // host, so it answers with one.
  daemonId(): string | null {
    return 'd1';
  }
  private readonly handlers = new Set<(e: WireEvent) => void>();
  private readonly statusHandlers = new Set<(s: 'online' | 'offline') => void>();
  private readonly hostStatusHandlers = new Set<
    (daemonId: string, s: 'online' | 'offline') => void
  >();
  daemon!: Daemon;

  // emit from host → server
  emit = (event: WireEvent): void => {
    for (const h of this.handlers) h(event);
  };

  send(_surfaceId: string, event: WireEvent): void {
    void this.handle(event);
  }

  private async handle(event: WireEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'chat.spawn_request':
          await this.daemon.spawnChat({
            folder: event.folder,
            ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
            ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
            ...(event.localId !== undefined ? { localId: event.localId } : {}),
          });
          return;
        case 'chat.input':
          await this.daemon.sendInput({
            chatId: event.chatId,
            message: event.message,
            localId: event.localId,
          });
          return;
        case 'chat.stop_request':
          await this.daemon.stopChat(event.chatId);
          return;
        case 'chat.resume_request':
          await this.daemon.resumeChat(event.chatId);
          return;
        case 'chat.pin_request':
          await this.daemon.setPinned(event.chatId, event.pinned);
          return;
        case 'chat.archive_request':
          await this.daemon.setArchived(event.chatId, event.archived);
          return;
        case 'chat.replay': {
          const surfaceId = event.forSurfaceId;
          this.daemon.replayChat(event.chatId, event.fromSeq, (ev) => {
            const tagged = surfaceId
              ? ({ ...(ev as object), forSurfaceId: surfaceId } as WireEvent)
              : ev;
            this.emit(tagged);
          });
          return;
        }
        default:
        // ignored
      }
    } catch (err) {
      // Mirror the REAL host control path (packages/daemon/src/index.ts):
      // classify the error code and allocate the seq through the host's
      // `allocErrorSeq` so an out-of-band spawn-time error carries the same
      // OUT_OF_BAND_SEQ (-1) the production path emits. This is what proves the
      // wire `chat.error.seq` schema admits the sentinel (regression: it used
      // to require nonnegative, so the server dropped the frame on decode).
      const code: ChatErrorCode =
        err instanceof FolderNotFoundError
          ? 'folder_not_found'
          : err instanceof ChatNotFoundError
            ? 'chat_not_found'
            : 'sdk_error';
      const chatId =
        'chatId' in event && typeof (event as { chatId?: unknown }).chatId === 'string'
          ? (event as { chatId: string }).chatId
          : 'unknown';
      const seq = this.daemon.allocErrorSeq(chatId);
      this.emit({
        type: 'chat.error',
        chatId,
        error: { code, message: (err as Error).message },
        seq,
      });
    }
  }

  onEvent(h: (e: WireEvent) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  // The multi-machine surface of DaemonLink (spec/03 § Host events): a stand-in
  // link still answers per machine, because the hub greets and routes by
  // `daemonId` rather than by "the host".
  onlineDaemonIds(): string[] {
    return ['d1'];
  }
  isOnline(daemonId: string): boolean {
    return daemonId === 'd1';
  }
  sendTo(_daemonId: string, surfaceId: string, event: WireEvent): void {
    this.send(surfaceId, event);
  }
  onHostStatus(h: (daemonId: string, s: 'online' | 'offline') => void): () => void {
    this.hostStatusHandlers.add(h);
    return () => this.hostStatusHandlers.delete(h);
  }
  lastConnectedAt(): number | null {
    return Date.now();
  }
  injectDaemonEvent(event: WireEvent): void {
    this.emit(event);
  }
  forget(): boolean {
    return false;
  }

  onStatus(h: (s: 'online' | 'offline') => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }
  status(): 'online' | 'offline' {
    return 'online';
  }
  async close(): Promise<void> {}
}

describe('integration: spawn → message → pin → archive → resume → replay', () => {
  let dataDir: string;
  let patchHome: string;
  let folder: string;
  let claudeRoot: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-int-data-'));
    patchHome = mkdtempSync(join(tmpdir(), 'patch-int-home-'));
    // Canonicalise to the realpath: the host `realpathSync`-es every spawn
    // folder (so the SDK's `~/.claude/projects/<encoded-realpath>` transcript
    // dir and the HistoryReader's encoded-folder lookup stay in lockstep —
    // macOS `/tmp` → `/private/tmp`). The replay-from-JSONL fixture below
    // encodes THIS folder, so it must already be the canonical path the host
    // will store, or `hasSession` looks under the wrong dir and finds nothing.
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-int-folder-')));
    claudeRoot = mkdtempSync(join(tmpdir(), 'patch-int-claude-'));
    mkdirSync(folder, { recursive: true });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(patchHome, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  });

  it('full lifecycle works end-to-end via WS', async () => {
    // 1. Bootstrap account + surface.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(50));
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    // `d1` is the machine every spawn in this file names — it must be REGISTERED,
    // because a host-addressed ingress refuses an unknown id (spec/04 § Spawn).
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-int',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-int',
      surfaceKind: 'web',
      label: 'browser',
    });

    // 2. Build the wired host link.
    const link = new WiredDaemonLink();
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(patchHome),
      sdkBackend: sdk,
      oauthAccessToken: 'fake',
      emit: (e) => link.emit(e),
      logger: silent,
      historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
    });
    link.daemon = daemon;

    // 3. Build server.
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = built.app.server.address() as AddressInfo;
      const url = `ws://127.0.0.1:${addr.port}/ws`;
      const c1 = new WireTestClient({ url, auth: jwt });
      await c1.connect();
      await c1.waitFor('daemon.online');

      // 4. Spawn (no prompt) via REST.
      const spawnRes = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder },
      });
      expect(spawnRes.statusCode).toBe(202);
      const chatId = (spawnRes.json() as { chatId: string }).chatId;
      expect(chatId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      // Wait for chat.spawned to confirm chat is live.
      await c1.waitFor('chat.spawned', (e) => e.chatId === chatId);

      // 5. Subscribe + send input.
      c1.send({ type: 'chat.focus_change', chatId });
      // Give the focus_change a moment to be processed before triggering output.
      await new Promise((r) => setTimeout(r, 30));
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-int' },
        { type: 'assistant', content: 'hello back', sessionId: 'sess-int' },
      ]);
      c1.sendInput({ chatId, message: 'hi', localId: 'L1' });
      // `chat.message` carries a `role` (spec/03 § Session events) and the
      // stream includes the user's own message, so name the role wanted rather
      // than assuming the first message on the chat is the reply.
      const msg = await c1.waitFor(
        'chat.message',
        (e) => e.chatId === chatId && e.role === 'assistant',
      );
      expect(msg.content).toBe('hello back');

      // 6. Pin the chat.
      c1.send({ type: 'chat.pin_request', chatId, pinned: true });
      const pinnedState = await c1.waitFor(
        'chat.state',
        (e) => e.chatId === chatId && e.pinned === true,
      );
      expect(pinnedState.pinned).toBe(true);

      // 7. Archive the chat.
      c1.send({ type: 'chat.archive_request', chatId, archived: true });
      const archivedState = await c1.waitFor(
        'chat.state',
        (e) => e.chatId === chatId && e.status === 'archived',
      );
      expect(archivedState.status).toBe('archived');

      // 8. GET /api/chats?archived=only sees this chat.
      const archivedRes = await built.app.inject({
        method: 'GET',
        url: '/api/chats?archived=only',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const archivedBody = archivedRes.json() as { chats: { chatId: string }[] };
      expect(archivedBody.chats.find((c) => c.chatId === chatId)).toBeDefined();

      // 9. Disconnect, reconnect a fresh surface, request replay.
      await c1.close();

      registry.upsertSurface({
        surfaceId: 'srf-int-2',
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: 2,
      });
      const jwt2 = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-int-2',
        surfaceKind: 'web',
        label: 'browser',
      });
      const c2 = new WireTestClient({ url, auth: jwt2 });
      await c2.connect();
      await c2.waitFor('daemon.online');
      const replayMessages: string[] = [];
      c2.on('chat.message', (e) => replayMessages.push(e.content));
      c2.replay(chatId, 0);
      await new Promise((r) => setTimeout(r, 100));
      // Replay comes from the chat's own log (spec/04 § History) and shows
      // what was actually said, not a harness transcript.
      expect(replayMessages).toContain('hello back');
      await c2.close();
    } finally {
      await built.app.close();
      daemon.shutdown();
    }
  });

  it('spawn-time folder_not_found surfaces as chat.error over /ws (no silent drop)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(51));
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    // `d1` is the machine every spawn in this file names — it must be REGISTERED,
    // because a host-addressed ingress refuses an unknown id (spec/04 § Spawn).
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-err',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-err',
      surfaceKind: 'web',
      label: 'browser',
    });

    const link = new WiredDaemonLink();
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(patchHome),
      sdkBackend: sdk,
      oauthAccessToken: 'fake',
      emit: (e) => link.emit(e),
      logger: silent,
      historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
    });
    link.daemon = daemon;

    const built = await buildAll({ logger: false, registry, daemonLink: link });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = built.app.server.address() as AddressInfo;
      const url = `ws://127.0.0.1:${addr.port}/ws`;
      const c1 = new WireTestClient({ url, auth: jwt });
      await c1.connect();
      await c1.waitFor('daemon.online');

      // Spawn into a folder that does not exist on the host.
      const errorPromise = c1.waitFor('chat.error', (e) => e.error.code === 'folder_not_found');
      const spawnRes = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder: '/tmp/does-not-exist-xyz-123' },
      });
      // POST resolves to a synchronous 400 from the host's chat.error.
      expect(spawnRes.statusCode).toBe(400);
      const failBody = spawnRes.json() as { error: string; chatId?: string };
      expect(failBody.error).toBe('folder_not_found');
      // E1-d6: the failed spawn created no chat, so the body must NOT surface a
      // (misleading) chatId that is absent from GET /api/chats.
      expect(failBody.chatId).toBeUndefined();

      // And the chat.error ALSO fans out over /ws — it must not be silently
      // dropped on decode (the OUT_OF_BAND_SEQ regression). seq is the sentinel.
      const errEvent = await errorPromise;
      expect(errEvent.error.code).toBe('folder_not_found');
      expect(errEvent.seq).toBe(OUT_OF_BAND_SEQ);
      await c1.close();
    } finally {
      await built.app.close();
      daemon.shutdown();
    }
  });

  it('chat.replay resyncs from the in-memory tail under the mock SDK backend (no JSONL)', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(52));
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    // `d1` is the machine every spawn in this file names — it must be REGISTERED,
    // because a host-addressed ingress refuses an unknown id (spec/04 § Spawn).
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-rep',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-rep',
      surfaceKind: 'web',
      label: 'browser',
    });

    const link = new WiredDaemonLink();
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(patchHome),
      sdkBackend: sdk,
      oauthAccessToken: 'fake',
      emit: (e) => link.emit(e),
      logger: silent,
      // claudeRoot stays empty: the mock backend never writes a JSONL.
      historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
    });
    link.daemon = daemon;

    const built = await buildAll({ logger: false, registry, daemonLink: link });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = built.app.server.address() as AddressInfo;
      const url = `ws://127.0.0.1:${addr.port}/ws`;
      const c1 = new WireTestClient({ url, auth: jwt });
      await c1.connect();
      await c1.waitFor('daemon.online');

      // Spawn (no prompt) then focus + send input so the surface is subscribed
      // to detail-level events before the assistant turn streams.
      const spawnRes = await built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { daemonId: 'd1', folder },
      });
      expect(spawnRes.statusCode).toBe(202);
      const chatId = (spawnRes.json() as { chatId: string }).chatId;
      await c1.waitFor('chat.spawned', (e) => e.chatId === chatId);
      c1.send({ type: 'chat.focus_change', chatId });
      await new Promise((r) => setTimeout(r, 30));
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-mock' },
        { type: 'assistant', content: 'tail-msg', sessionId: 'sess-mock' },
      ]);
      c1.sendInput({ chatId, message: 'hi', localId: 'L1' });
      await c1.waitFor('chat.message', (e) => e.chatId === chatId && e.content === 'tail-msg');
      await c1.close();

      // Fresh surface reconnects and replays from scratch (-1 → include seq 0).
      // No JSONL exists on disk — replay must serve from the host's in-memory
      // tail rather than emitting a chat.error (the issue-13 regression).
      registry.upsertSurface({
        surfaceId: 'srf-rep-2',
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: 2,
      });
      const jwt2 = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-rep-2',
        surfaceKind: 'web',
        label: 'browser',
      });
      const c2 = new WireTestClient({ url, auth: jwt2 });
      await c2.connect();
      await c2.waitFor('daemon.online');
      const replayMessages: string[] = [];
      const replayErrors: string[] = [];
      c2.on('chat.message', (e) => replayMessages.push(e.content));
      c2.on('chat.error', (e) => replayErrors.push(e.error.code));
      c2.replayFromLastSeen(chatId);
      await new Promise((r) => setTimeout(r, 100));
      expect(replayErrors).toEqual([]);
      expect(replayMessages).toContain('tail-msg');
      await c2.close();
    } finally {
      await built.app.close();
      daemon.shutdown();
    }
  });
});
