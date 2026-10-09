// G1-15 attach-path regression, end-to-end against the REAL server + REAL
// Host, driven by the REAL TUI transport (`PatchWsClient` from @patch/cli).
//
// Reproduces the reviewer's defect: attaching to a PRE-EXISTING chat (the
// `patch attach <id>` path) must render the existing wire stream. Previously
// the attach path never tracked the chat or issued a `chat.replay`, so the
// event pane stayed empty. `PatchWsClient.attachChat()` — called by ChatView
// on mount — now tracks the chat and requests a replay; this test proves the
// replayed assistant message actually arrives at the attaching surface.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { LogRecord, type WireEvent } from '@patch/wire';
import { Daemon } from '../../daemon/src/chatRunner.js';
import { createMetaStore } from '../../daemon/src/meta.js';
import { createMockSdkBackend } from '../../daemon/src/sdkBackend.js';
import { createHistoryReader, encodeFolder } from '../../daemon/src/history.js';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import type { DaemonLink } from '../src/daemon-link.js';
// The REAL TUI transport — the exact code ChatView mounts behind.
import { PatchWsClient } from '../../cli/src/transport/ws.js';

const silent = pino({ level: 'silent' });

class WiredDaemonLink implements DaemonLink {
  // Presence names the machine it describes; a stand-in link is still a
  // host, so it answers with one.
  daemonId(): string | null {
    return 'd1';
  }
  private readonly handlers = new Set<(e: WireEvent) => void>();
  daemon!: Daemon;
  emit = (event: WireEvent): void => {
    for (const h of this.handlers) h(event);
  };
  send(_surfaceId: string, event: WireEvent): void {
    void this.handle(event);
  }
  private async handle(event: WireEvent): Promise<void> {
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
  }
  onEvent(h: (e: WireEvent) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  onStatus(): () => void {
    return () => undefined;
  }
  // The multi-machine surface of DaemonLink (spec/03 § Host events): the hub
  // greets and routes per machine, so a stand-in link answers per machine too.
  onlineDaemonIds(): string[] {
    return ['d1'];
  }
  isOnline(daemonId: string): boolean {
    return daemonId === 'd1';
  }
  sendTo(_daemonId: string, surfaceId: string, event: WireEvent): void {
    this.send(surfaceId, event);
  }
  onHostStatus(): () => void {
    return () => undefined;
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
  status(): 'online' | 'offline' {
    return 'online';
  }
  async close(): Promise<void> {}
}

describe('G1-15: attach path renders the existing wire stream (real PatchWsClient)', () => {
  let dataDir: string;
  let patchHome: string;
  let folder: string;
  let claudeRoot: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-attach-data-'));
    patchHome = mkdtempSync(join(tmpdir(), 'patch-attach-home-'));
    folder = mkdtempSync(join(tmpdir(), 'patch-attach-folder-'));
    claudeRoot = mkdtempSync(join(tmpdir(), 'patch-attach-claude-'));
    mkdirSync(folder, { recursive: true });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(patchHome, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  });

  it('attachChat replays a pre-existing chat to a fresh surface', async () => {
    // Bootstrap account + two surfaces (the driver and the attacher).
    const user = generateUserKeypair(() => new Uint8Array(32).fill(70));
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    // The machine this fixture spawns on has to be registered — a host-addressed
    // ingress refuses an unknown id (spec/04 § Spawn).
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-a',
      surfaceKind: 'terminal',
      label: 'driver',
      issuedAt: 1,
    });
    registry.upsertSurface({
      surfaceId: 'srf-b',
      surfaceKind: 'terminal',
      label: 'attacher',
      issuedAt: 2,
    });
    const jwtDriver = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-a',
      surfaceKind: 'terminal',
      label: 'driver',
    });
    const jwtAttacher = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-b',
      surfaceKind: 'terminal',
      label: 'attacher',
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
    const addr = built.app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${addr.port}/ws`;

    // Driver surface (WireTestClient is fine here — it's just producing output).
    const driver = new WireTestClient({ url, auth: jwtDriver, clientType: 'surface-cli' });
    await driver.connect();
    await driver.waitFor('daemon.online');

    const spawnRes = await built.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { authorization: `Bearer ${jwtDriver}` },
      payload: { daemonId: 'd1', folder },
    });
    expect(spawnRes.statusCode).toBe(202);
    const chatId = (spawnRes.json() as { chatId: string }).chatId;
    await driver.waitFor('chat.spawned', (e) => e.chatId === chatId);

    driver.send({ type: 'chat.focus_change', chatId });
    await new Promise((r) => setTimeout(r, 30));
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-attach' },
      { type: 'assistant', content: 'history line from the agent', sessionId: 'sess-attach' },
    ]);
    driver.sendInput({ chatId, message: 'hi', localId: 'LA' });
    await driver.waitFor('chat.message', (e) => e.chatId === chatId);
    await driver.close();

    // Persist a JSONL so replay has the assistant line to serve.
    const projDir = join(claudeRoot, encodeFolder(folder));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'sess-attach.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'history line from the agent' }] },
        }),
      ].join('\n'),
    );

    // ── ATTACH PATH ──────────────────────────────────────────────────────
    // The fresh surface uses the REAL PatchWsClient and ONLY calls attachChat
    // (exactly what ChatView does on mount). No sendInput, no manual replay.
    const attacher = new PatchWsClient({
      url,
      bearer: jwtAttacher,
      clientType: 'surface-cli',
      noAutoReconnect: true,
    });
    const rendered: string[] = [];
    attacher.on('chat.message', (e) => {
      if (e.chatId === chatId) rendered.push(e.content);
    });
    await attacher.connect();
    // This is the one call ChatView makes on mount for the attach path.
    attacher.attachChat(chatId);

    // Wait for the replayed history to arrive.
    const deadline = Date.now() + 2000;
    while (!rendered.includes('history line from the agent') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await attacher.close();
    await built.app.close();
    daemon.shutdown();

    // Without the fix the pane stays empty; with it the replayed line arrives.
    expect(rendered).toContain('history line from the agent');
  });

  it("keeps the chat's own history log across a real turn and a host restart (spec/04 § History)", async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(71));
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ daemonId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.upsertSurface({
      surfaceId: 'srf-h',
      surfaceKind: 'terminal',
      label: 'h',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-h',
      surfaceKind: 'terminal',
      label: 'h',
    });
    const link = new WiredDaemonLink();
    const startDaemon = (): Daemon => {
      const d = new Daemon({
        daemonId: 'd1',
        metaStore: createMetaStore(patchHome),
        sdkBackend: createMockSdkBackend({ claudeProjectsRoot: claudeRoot }),
        oauthAccessToken: 'fake',
        emit: (e) => link.emit(e),
        logger: silent,
        historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
      });
      link.daemon = d;
      return d;
    };
    let daemon = startDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address() as AddressInfo;
    const client = new WireTestClient({
      url: `ws://127.0.0.1:${addr.port}/ws`,
      auth: jwt,
      clientType: 'surface-cli',
    });
    await client.connect();
    await client.waitFor('daemon.online');
    const spawnRes = await built.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { daemonId: 'd1', folder },
    });
    const chatId = (spawnRes.json() as { chatId: string }).chatId;
    await client.waitFor('chat.spawned', (e) => e.chatId === chatId);
    client.send({ type: 'chat.focus_change', chatId });

    const logPath = join(patchHome, 'chats', chatId, 'events.jsonl');
    const readLog = (): LogRecord[] =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => LogRecord.parse(JSON.parse(l)));
    const settled = async (n: number): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          if (readLog().filter((r) => r.rec.k === 'turn.end').length >= n) return;
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`turn ${n} never ended in the history log`);
    };

    client.sendInput({ chatId, message: '[[tool]] first turn', localId: 'H1' });
    await settled(1);
    const before = readLog();
    expect(before[0]!.rec).toEqual({ k: 'log.start', legacyUpTo: 0 });
    expect(before.map((r) => r.rec.k)).toEqual([
      'log.start',
      'turn.start',
      'event',
      'event',
      'event',
      'event',
      'event',
      // The mock reports its session id on the turn's `result`.
      'session',
      'turn.end',
    ]);
    const firstEvents = before.flatMap((r) => (r.rec.k === 'event' ? [r.rec.event] : []));
    expect(firstEvents.map((e) => e.type)).toEqual([
      'chat.message',
      'chat.message',
      'chat.tool_call',
      'chat.tool_result',
      'chat.message',
    ]);
    expect(firstEvents[0]).toMatchObject({
      role: 'user',
      content: '[[tool]] first turn',
      localId: 'H1',
    });
    expect(before.at(-1)!.rec).toMatchObject({ k: 'turn.end', outcome: 'completed' });

    // Restart the host under the same server.
    daemon.shutdown();
    daemon = startDaemon();
    daemon.hydrate();
    // A surface redelivering the first turn's input is recognised across the restart.
    client.sendInput({ chatId, message: '[[tool]] first turn', localId: 'H1' });
    client.sendInput({ chatId, message: 'second turn', localId: 'H2' });
    await settled(2);
    const after = readLog();
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);

    // The plain reply streams, so its seq is reserved before it finalises.
    expect(added.map((r) => r.rec.k)).toEqual([
      'turn.start',
      'event',
      'seq.reserve',
      'event',
      'turn.end',
    ]);
    const seqs = after.flatMap((r) => (r.rec.k === 'event' ? [r.seq] : []));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const addedSeqs = added.flatMap((r) => (r.rec.k === 'event' ? [r.seq] : []));
    expect(Math.min(...addedSeqs)).toBeGreaterThan(Math.max(...firstEvents.map((e) => e.seq)));

    // The replay the surface gets comes straight from the log.
    client.send({ type: 'chat.replay', chatId, fromSeq: -1 });
    await client.waitFor('chat.branches', (e) => e.chatId === chatId);

    await client.close();
    await built.app.close();
    daemon.shutdown();
  });
});
