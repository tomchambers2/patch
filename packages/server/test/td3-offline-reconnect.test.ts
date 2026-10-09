// TD3 — Offline behaviour and reconnect, executed against a LIVE mock-backend
// stack (group D3 self-cert + the encoded TD3 e2e tests, D3-1 … D3-8).
//
// This is NOT a set of isolated unit tests. It stands up the real server
// (`buildAll`, listening on a real port, real `InboundDaemonLink` accepting a
// real host socket via the WS hello gate) and a real `Daemon` whose real
// `createServerLink` DIALS INTO that server over a real WebSocket — exactly the
// production topology from packages/daemon/src/index.ts — driven by
// `WireTestClient` surfaces. SDK_BACKEND is mock so no Claude install / OAuth
// is needed.
//
// Spec: 12-error-and-offline.md (all scenarios), 03-wire-protocol.md
// ## Idempotency, 04-chats-and-folders.md ## Resume, 02-daemon.md
// ## Host restart behaviour.
//
// Test hooks used (HARNESS affordances, gated, never run in production):
//   - serverLink.severForTest()      — sever host→server link, host alive
//   - serverLink.bufferSizeForTest() — inspect the offline buffer
//   - re-instantiating Host from the same metaStore dir — host "restart"
//   - corrupting meta.json on disk between host instances — bad claudeSessionId

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { Daemon } from '../../daemon/src/chatRunner.js';
import { createMetaStore } from '../../daemon/src/meta.js';
import { createMockSdkBackend, type MockSdkBackend } from '../../daemon/src/sdkBackend.js';
import { createServerLink, type ServerLink } from '../../daemon/src/serverLink.js';

const silent = pino({ level: 'silent' });
const DAEMON_ID = 'td3-daemon';

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: timed out');
}

interface Stack {
  built: BuiltApp;
  wsUrl: string;
  mintSurface: (surfaceId: string) => Promise<string>;
  daemonKey: string;
  patchHome: string;
  dataDir: string;
  sdk: MockSdkBackend;
  daemon: Daemon;
  link: ServerLink;
  newDaemon: () => { daemon: Daemon; sdk: MockSdkBackend };
  stop: () => Promise<void>;
}

/**
 * Build the full live stack: listening server + host serverLink dialing in +
 * real Host (mock SDK). Mirrors index.ts's emit→link.send wiring and the
 * onFrame replay/chat.input routing.
 */
async function startStack(): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), 'td3-data-'));
  const patchHome = mkdtempSync(join(tmpdir(), 'td3-home-'));
  const chatFolder = mkdtempSync(join(tmpdir(), 'td3-folder-'));

  // Shared account keypair: surface cred + daemonKey must be signed by it.
  const kp = generateUserKeypair();
  const registry = Registry.load(dataDir);
  registry.bootstrapAccount({ keypair: kp });
  registry.setDaemonKey({ daemonId: DAEMON_ID, publicKey: kp.publicKey, issuedAt: Date.now() });

  const mintSurface = (surfaceId: string): Promise<string> =>
    mintSurfaceCredential({
      userPrivateKey: kp.privateKey,
      surfaceId,
      surfaceKind: 'web',
      label: 'td3',
    });
  const daemonKey = await mintDaemonKey({
    userPrivateKey: kp.privateKey,
    daemonId: DAEMON_ID,
    label: 'td3',
  });

  const built = await buildAll({
    registry,
    logger: false,
    // Injected mock notify backend so credential validation passes without env.
    pushBackend: { send: async () => ({ ok: true as const }) } as never,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;

  const metaStore = createMetaStore(patchHome);

  // Factory: a Host instance wired to a fresh ServerLink that dials the live
  // server. Returns the live-link `emit` and the host. The first invocation
  // is the "running" host; `newDaemon()` rebuilds from the SAME metaStore
  // dir to simulate a process restart.
  function buildDaemonInstance(): {
    daemon: Daemon;
    sdk: MockSdkBackend;
    link: ServerLink;
  } {
    const sdk = createMockSdkBackend();
    let link!: ServerLink;
    const emit = (event: WireEvent): void => {
      link.send(event);
    };
    const daemon = new Daemon({
      daemonId: DAEMON_ID,
      metaStore,
      sdkBackend: sdk,
      oauthAccessToken: 'mock-token',
      emit,
      logger: silent,
    });
    daemon.hydrate();
    link = createServerLink({
      url: wsUrl,
      daemonKey,
      clientVersion: '0.0.0-test',
      logger: silent,
      enableTestHooks: true,
      backoffSchedule: [20, 20, 20],
      onAuthed: (sender) => {
        // Mirror index.ts: re-seed the server registry with known chats so
        // chat.state passes the server's spawned-gate after (re)connect.
        for (const state of daemon.list()) {
          sender({
            type: 'chat.spawned',
            daemonId: DAEMON_ID,
            chatId: state.chatId,
            folder: state.folder,
          });
          sender({
            type: 'chat.state',
            permissionMode: 'bypassPermissions',
            chatId: state.chatId,
            activity: state.activity,
            lastUpdated: state.lastUpdated,
            status: state.status,
            name: state.name,
            folder: state.folder,
          });
        }
      },
      onFrame: (event, sender) => {
        void handleServerEvent(event, daemon, sender);
      },
    });
    return { daemon, sdk, link };
  }

  let current = buildDaemonInstance();
  current.link.start();
  await waitFor(() => current.link.isOnline());
  await waitFor(() => built.daemonLink.status() === 'online');

  return {
    built,
    wsUrl,
    mintSurface,
    daemonKey,
    patchHome,
    dataDir,
    sdk: current.sdk,
    daemon: current.daemon,
    link: current.link,
    newDaemon() {
      current.daemon.shutdown();
      const next = buildDaemonInstance();
      current = next;
      next.link.start();
      // expose new handles
      (this as Stack).daemon = next.daemon;
      (this as Stack).sdk = next.sdk;
      (this as Stack).link = next.link;
      return { daemon: next.daemon, sdk: next.sdk };
    },
    async stop() {
      current.daemon.shutdown();
      await current.link.close();
      await built.app.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(patchHome, { recursive: true, force: true });
      rmSync(chatFolder, { recursive: true, force: true });
    },
  };
}

/** Mirror of index.ts handleServerEvent for the subset TD3 drives. */
async function handleServerEvent(
  event: WireEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): Promise<void> {
  switch (event.type) {
    case 'chat.spawn_request':
      await daemon.spawnChat({
        folder: event.folder,
        ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
        ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
        ...(event.localId !== undefined ? { localId: event.localId } : {}),
      });
      return;
    case 'chat.input':
      await daemon.sendInput({
        chatId: event.chatId,
        message: event.message,
        localId: event.localId,
      });
      return;
    case 'chat.replay': {
      const surfaceId = event.forSurfaceId;
      daemon.replayChat(event.chatId, event.fromSeq, (ev) => {
        sender(surfaceId ? ({ ...(ev as object), forSurfaceId: surfaceId } as WireEvent) : ev);
      });
      return;
    }
    default:
      return;
  }
}

/** Spawn a chat folder + chat via a surface, return the allocated chatId. */
async function spawnChat(surface: WireTestClient, folder: string): Promise<string> {
  const spawned = surface.waitFor('chat.spawned');
  surface.send({ type: 'chat.spawn_request', daemonId: DAEMON_ID, folder });
  const ev = await spawned;
  return ev.chatId;
}

describe('TD3 — offline/reconnect (live mock-backend stack)', () => {
  let stack: Stack;
  let folder: string;
  const clients: WireTestClient[] = [];

  beforeEach(async () => {
    stack = await startStack();
    folder = mkdtempSync(join(tmpdir(), 'td3-chat-'));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
    await stack.stop();
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * Send a user input and wait for the chat to return to `idle` — the mock SDK
   * runs the query asynchronously, and the host rejects a concurrent input on
   * a still-running chat (NO concurrent turns). Surfaces in production send
   * sequentially; this mirrors that.
   */
  async function sendAndSettle(
    surface: WireTestClient,
    chatId: string,
    message: string,
    localId: string,
  ): Promise<void> {
    const idle = surface.waitFor(
      'chat.state',
      (e) => e.chatId === chatId && e.activity === 'idle',
      4000,
    );
    surface.sendInput({ chatId, message, localId });
    await idle;
  }

  let surfaceCounter = 0;
  async function connectSurface(): Promise<WireTestClient> {
    const cred = await stack.mintSurface(`td3-surface-${++surfaceCounter}`);
    const c = new WireTestClient({
      url: stack.wsUrl,
      clientType: 'surface-cli',
      auth: cred,
    });
    clients.push(c);
    const authed = c.waitFor('auth.ok');
    await c.connect();
    await authed;
    return c;
  }

  // ── D3-1 ──────────────────────────────────────────────────────────────────
  it('D3-1: surface reconnect replays exactly the missed events (no gaps, no dupes)', async () => {
    const surface = await connectSurface();
    const chatId = await spawnChat(surface, folder);
    // Focus so detail-level events (chat.message) fan out to this surface.
    surface.send({ type: 'chat.focus_change', chatId });

    // Drive enough events that seq climbs past 5. Each input → state(running),
    // message(assistant), state(idle).
    const seqs: number[] = [];
    surface.on('chat.message', (e) => {
      if (e.chatId === chatId) seqs.push(e.seq);
    });
    surface.on('chat.state', (e) => {
      if (e.chatId === chatId && typeof e.seq === 'number') seqs.push(e.seq);
    });

    // First turn: six assistant messages, so seq climbs well past 0. The exact
    // number the chat lands on is NOT a contract — the user's own
    // `chat.message` takes a seq too (spec/03 § Session events: `chat.message`
    // carries a `role`), so pinning an absolute value here just encodes how
    // many frames a turn happens to produce today. spec/12 guarantees only that
    // per-chat `seq` is monotonic, which is all this test needs.
    const lastContent = 's5';
    const seen = new Set<string>();
    surface.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') seen.add(e.content);
    });
    stack.sdk.enqueue([
      { type: 'assistant', content: 's0' },
      { type: 'assistant', content: 's1' },
      { type: 'assistant', content: 's2' },
      { type: 'assistant', content: 's3' },
      { type: 'assistant', content: 's4' },
      { type: 'assistant', content: 's5' },
      { type: 'result', sessionId: 'sess-d1' },
    ]);
    await sendAndSettle(surface, chatId, 'one', 'm-1');
    await waitFor(() => seen.has(lastContent));
    const beforeDrop = surface.lastSeq(chatId)!;
    expect(beforeDrop).toBeGreaterThanOrEqual(5);

    // Sever the SURFACE socket without touching the host.
    await surface.close();

    // Produce 3 more events while the surface is gone. A second surface drives
    // the chat so the host keeps emitting.
    const driver = await connectSurface();
    driver.send({ type: 'chat.focus_change', chatId });
    stack.sdk.enqueue([
      { type: 'assistant', content: 's6' },
      { type: 'assistant', content: 's7' },
      { type: 'assistant', content: 's8' },
      { type: 'result', sessionId: 'sess-d1' },
    ]);
    await sendAndSettle(driver, chatId, 'two', 'm-2');
    await waitFor(() => driver.lastSeq(chatId)! >= beforeDrop + 3);
    const afterProduced = driver.lastSeq(chatId)!; // 8
    expect(afterProduced).toBeGreaterThan(beforeDrop);

    // Reconnect the original surface and replay from beforeDrop.
    const surface2 = await connectSurface();
    surface2.send({ type: 'chat.focus_change', chatId });
    const replayed: number[] = [];
    surface2.on('chat.message', (e) => {
      if (e.chatId === chatId) replayed.push(e.seq);
    });
    surface2.on('chat.state', (e) => {
      if (e.chatId === chatId && typeof e.seq === 'number') replayed.push(e.seq);
    });
    surface2.send({ type: 'chat.replay', chatId, fromSeq: beforeDrop });
    await waitFor(() => replayed.some((s) => s >= afterProduced));

    // Every replayed event is strictly > beforeDrop (no <= redelivered),
    // strictly increasing, no duplicates.
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((s) => s > beforeDrop)).toBe(true);
    const sorted = [...replayed].sort((a, b) => a - b);
    expect(replayed).toEqual(sorted);
    expect(new Set(replayed).size).toBe(replayed.length);
  });

  // ── D3-2 ──────────────────────────────────────────────────────────────────
  it('D3-2: chat.input localId dedup — a duplicate send is silently dropped', async () => {
    const surface = await connectSurface();
    const chatId = await spawnChat(surface, folder);
    surface.send({ type: 'chat.focus_change', chatId });

    // The mock backend emits an assistant echo per real query. The duplicate
    // localId must NOT trigger a query, so assistantCount stays at 1 across the
    // dup and only climbs again for a fresh localId.
    let assistantCount = 0;
    surface.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') assistantCount++;
    });

    await sendAndSettle(surface, chatId, 'hello', 'dup-1');
    await waitFor(() => assistantCount === 1);
    // Duplicate localId — must be dropped (no second assistant echo, no run).
    surface.sendInput({ chatId, message: 'hello', localId: 'dup-1' });
    // Give any erroneous duplicate a chance to surface.
    await new Promise((r) => setTimeout(r, 150));
    expect(assistantCount).toBe(1); // dup suppressed — still just the one turn
    // A fresh localId — must run, proving the chat is still live and only the
    // dup was suppressed.
    await sendAndSettle(surface, chatId, 'again', 'fresh-2');
    await waitFor(() => assistantCount === 2);
    expect(assistantCount).toBe(2); // exactly two real turns; the dup was dropped
  });

  // ── D3-3 ──────────────────────────────────────────────────────────────────
  it('D3-3: per-chat seq is strictly monotonic with no gaps', async () => {
    const surface = await connectSurface();
    const chatId = await spawnChat(surface, folder);
    surface.send({ type: 'chat.focus_change', chatId });

    const allSeqs: number[] = [];
    const record = (e: { chatId: string; seq?: number }): void => {
      if (e.chatId === chatId && typeof e.seq === 'number' && e.seq >= 0) allSeqs.push(e.seq);
    };
    surface.on('chat.message', record);
    surface.on('chat.tool_call', record);
    surface.on('chat.state', (e) => record(e as never));

    // One turn that emits ~10 seq-carrying events.
    stack.sdk.enqueue([
      ...Array.from({ length: 10 }, (_, i) => ({
        type: 'assistant' as const,
        content: `e${i}`,
      })),
      { type: 'result', sessionId: 'sess-d3' },
    ]);
    await sendAndSettle(surface, chatId, 'a', 'a');
    await waitFor(() => surface.lastSeq(chatId)! >= 9);
    await new Promise((r) => setTimeout(r, 100));

    // De-dup the multi-handler captures, sort, then assert 0,1,2,... no gaps.
    const unique = [...new Set(allSeqs)].sort((a, b) => a - b);
    expect(unique[0]).toBe(0);
    for (let i = 0; i < unique.length; i++) {
      expect(unique[i]).toBe(i); // strictly +1, no gaps, no repeats
    }
  });

  // ── D3-4 ──────────────────────────────────────────────────────────────────
  it('D3-4: host→server link drop buffers outbound events and flushes in order on reconnect', async () => {
    const surface = await connectSurface();
    const chatId = await spawnChat(surface, folder);
    surface.send({ type: 'chat.focus_change', chatId });

    const offline = surface.waitFor('daemon.offline');
    const online = surface.waitFor('daemon.online');

    // Sever the host→server link (host stays alive).
    expect(stack.link.severForTest()).toBe(true);
    await offline;
    await waitFor(() => !stack.link.isOnline());

    // Produce events while the link is down — these buffer in the host.
    stack.sdk.enqueue([
      { type: 'assistant', content: 'buffered-1' },
      { type: 'result', sessionId: 'sess-d4' },
    ]);
    await stack.daemon.sendInput({ chatId, message: 'while-down', localId: 'd4-1' });
    expect(stack.link.bufferSizeForTest()).toBeGreaterThan(0);

    const got: WireEvent[] = [];
    surface.on('chat.message', (e) => {
      if (e.chatId === chatId) got.push(e);
    });

    // Link recovers via backoff; buffered events flush in order.
    await online;
    await waitFor(() => stack.link.isOnline());
    await waitFor(() => got.some((e) => e.type === 'chat.message' && e.content === 'buffered-1'));

    const contents = got
      .filter((e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message')
      .map((e) => e.content);
    expect(contents).toContain('buffered-1');
    // Order preserved: seqs increasing as flushed.
    const flushedSeqs = got
      .filter((e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message')
      .map((e) => e.seq);
    const sortedSeqs = [...flushedSeqs].sort((a, b) => a - b);
    expect(flushedSeqs).toEqual(sortedSeqs);
  });

  // ── D3-5 ──────────────────────────────────────────────────────────────────
  it('D3-5: outbound buffer bounded at 10k events/chat — oldest dropped with a warning', async () => {
    // Build an isolated host with a small cap so the test is fast, plus a
    // warn-capturing logger so we can assert the drop log fires. The 10k value
    // is the production default (DEFAULT_BUFFER_PER_CHAT); here we prove the
    // bounding+drop behaviour with a low cap. (The 10k default is exercised by
    // packages/server/test/daemon-link.test.ts and eventBuffer.test.ts.)
    const warnings: unknown[] = [];
    const capturing = pino(
      { level: 'warn' },
      { write: (s: string) => warnings.push(JSON.parse(s)) },
    );
    const cap = 100;
    const link = createServerLink({
      url: stack.wsUrl,
      daemonKey: stack.daemonKey,
      clientVersion: '0.0.0-test',
      logger: capturing,
      enableTestHooks: true,
      bufferMaxPerChat: cap,
      backoffSchedule: [50],
    });
    // Never start() → permanently offline → every send buffers.
    for (let i = 0; i < cap + 250; i++) {
      link.send({
        type: 'chat.message',
        chatId: 'cap-chat',
        role: 'assistant',
        content: `m${i}`,
        seq: i,
      });
    }
    // Buffer never exceeds the cap.
    expect(link.bufferSizeForTest()).toBe(cap);
    // A drop warning fired.
    const dropWarn = warnings.find(
      (w) =>
        typeof w === 'object' &&
        w !== null &&
        String((w as { msg?: string }).msg).includes('dropped oldest'),
    );
    expect(dropWarn).toBeDefined();
    await link.close();
  });

  // ── D3-6 ──────────────────────────────────────────────────────────────────
  it('D3-6: host process death → restart resumes the chat via resume:claudeSessionId', async () => {
    const surface = await connectSurface();
    const chatId = await spawnChat(surface, folder);
    surface.send({ type: 'chat.focus_change', chatId });

    // First turn establishes a claudeSessionId on disk.
    stack.sdk.enqueue([
      { type: 'assistant', content: 'first' },
      { type: 'result', sessionId: 'claude-sess-d6' },
    ]);
    surface.sendInput({ chatId, message: 'first', localId: 'd6-1' });
    await waitFor(() => {
      const m = JSON.parse(
        readFileSync(join(stack.patchHome, 'chats', chatId, 'meta.json'), 'utf8'),
      ) as { claudeSessionId?: string };
      return m.claudeSessionId === 'claude-sess-d6';
    });

    // Kill the host (close its link + shutdown) and observe daemon.offline.
    const offline = surface.waitFor('daemon.offline');
    const online = surface.waitFor('daemon.online');
    stack.link.severForTest();
    // Actually tear the old instance fully down and start a NEW host process
    // re-hydrating from the same metaStore — the real restart.
    const restarted = stack.newDaemon();
    await offline.catch(() => undefined);
    await waitFor(() => restarted.daemon.list().some((c) => c.chatId === chatId));
    await online;
    await waitFor(() => stack.link.isOnline());

    // Restart marks chats idle.
    const restoredState = restarted.daemon.list().find((c) => c.chatId === chatId)!;
    expect(restoredState.activity).toBe('idle');

    // Next message triggers a fresh query() with resume:<claudeSessionId>.
    restarted.sdk.enqueue([
      { type: 'assistant', content: 'resumed' },
      { type: 'result', sessionId: 'claude-sess-d6' },
    ]);
    surface.sendInput({ chatId, message: 'second', localId: 'd6-2' });
    await waitFor(() => restarted.sdk.lastOptions() !== undefined);
    expect(restarted.sdk.lastOptions()?.resumeSessionId).toBe('claude-sess-d6');
  });

  // ── D3-7 ──────────────────────────────────────────────────────────────────
  // This asserted the opposite until b1513919: a chat whose session id had gone
  // was refused and left errored, so that a lost session could not pass for a
  // fresh start. That reasoning was wrong about where the context lives. The
  // transcript is Patch's own, in ~/.patch/chats/<id>, and a turn killed
  // mid-flight is held in `pendingTurns`; the session id is only a pointer into
  // the PROVIDER's context cache. So there is nothing lost to protect, and
  // refusing left an unattended chat — a job, a cron fire — stuck until a human
  // re-sent it by hand, which is no recovery at all.
  //
  // That commit changed the host and updated the host's own test, but not
  // this server-level twin, so this went on asserting the removed behaviour and
  // blocked every deploy for everyone. Now it holds the new contract: no
  // session, start one, run the turn.
  //
  // The fresh session is MINTED, not absent. The host rebuilds the lost
  // context from Patch's own log into a brand-new session id, exactly as a
  // provider switch does, rather than handing the model a contextless session
  // that can only see this one prompt. So the resume argument is a new id
  // carrying a reseed — never the id that went missing. The host's own twin
  // asserts the same pair (packages/daemon/test/restart-resume.test.ts).
  it('D3-7: a chat whose claudeSessionId has gone starts a fresh session and runs the turn', async () => {
    const surface = await connectSurface();
    const chatId = await spawnChat(surface, folder);
    surface.send({ type: 'chat.focus_change', chatId });

    // Establish a session + a committed turn (nextSeq > 0) so the chat has
    // genuinely had a session it could lose.
    stack.sdk.enqueue([
      { type: 'assistant', content: 'turn1' },
      { type: 'result', sessionId: 'sess-to-corrupt' },
    ]);
    surface.sendInput({ chatId, message: 'turn1', localId: 'd7-1' });
    const metaPath = join(stack.patchHome, 'chats', chatId, 'meta.json');
    await waitFor(() => {
      const m = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        claudeSessionId?: string;
        nextSeq: number;
      };
      return m.claudeSessionId === 'sess-to-corrupt' && m.nextSeq > 0;
    });

    // Sever, corrupt the claudeSessionId on disk, then restart the host.
    stack.link.severForTest();
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta['claudeSessionId']; // missing session id
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const online = surface.waitFor('daemon.online');
    const restarted = stack.newDaemon();
    await online;
    await waitFor(() => restarted.daemon.list().some((c) => c.chatId === chatId));

    // The next message RUNS. It runs on a session the host mints for it — not
    // on the one that went missing, and not on nothing — with the chat's own
    // prior track reseeded into it. That is the whole change: a fresh session,
    // not a refusal.
    restarted.sdk.enqueue([
      { type: 'assistant', content: 'ran on a fresh session' },
      { type: 'result', sessionId: 'sess-fresh' },
    ]);
    surface.sendInput({ chatId, message: 'after-corrupt', localId: 'd7-2' });
    await waitFor(() => restarted.sdk.lastOptions() !== undefined);
    const runOpts = restarted.sdk.lastOptions()!;
    expect(runOpts.resumeSessionId).toBeTruthy();
    expect(runOpts.resumeSessionId).not.toBe('sess-to-corrupt');
    // And it is not contextless: the earlier turn is handed to the new session.
    const reseeded = (runOpts.claudeSessionStore?.reseed?.events ?? [])
      .filter((t) => t.event.type === 'chat.message')
      .map((t) => (t.event as { content?: unknown }).content);
    expect(reseeded).toContain('turn1');

    // No error reaches the surface, and the host is still alive and idle.
    // `chat.error` never arriving is the assertion; a wait that times out would
    // be the failure, so this settles on state instead.
    await waitFor(() => {
      const st = restarted.daemon.list().find((c) => c.chatId === chatId);
      return st !== undefined && st.activity === 'idle';
    });
    const st = restarted.daemon.list().find((c) => c.chatId === chatId)!;
    expect(st.activity).toBe('idle');
    // And the chat is back on a real session, so the NEXT turn resumes properly.
    const after = JSON.parse(readFileSync(metaPath, 'utf8')) as { claudeSessionId?: string };
    expect(after.claudeSessionId).toBe('sess-fresh');
  });

  // ── D3-8 ──────────────────────────────────────────────────────────────────
  it('D3-8: daemon.offline/online lifecycle events reach connected surfaces', async () => {
    const surface = await connectSurface();
    const offline = surface.waitFor('daemon.offline');
    const online = surface.waitFor('daemon.online');

    expect(stack.link.severForTest()).toBe(true);
    const off = await offline;
    expect(off.type).toBe('daemon.offline');

    const on = await online;
    expect(on.type).toBe('daemon.online');
    await waitFor(() => stack.built.daemonLink.status() === 'online');
  });
});
