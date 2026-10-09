// TC3 integration — host-side notification + broadcast-sidecar layer
// against a RUNNING host control service.
//
// This is NOT app.inject. It boots the real `buildControl` Fastify app and has
// it LISTEN on a real Unix domain socket (the same `app.listen({ path })` the
// production host uses), then drives it with the real `udsRequest` client —
// the exact HTTP-over-UDS transport the patch-tools-server MCP child uses to
// reach the host. The speakers cascade (`resolveSpeakers`), the broadcast
// sidecar file IO, the `onBroadcast` self-loop suppression, and the
// `<system-reminder>` injection on reply are all wired exactly as index.ts
// wires them, exercised end-to-end with real fs writes under a temp daemon-cwd.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { udsRequest } from '../src/mcp.js';
import {
  ensureSpecialThreads,
  appendBroadcast,
  isBroadcastSelfLoop,
  threadForChannel,
  readPendingBroadcasts,
  flushBroadcasts,
  buildBroadcastSystemReminder,
  broadcastSidecarPath,
  SPECIAL_THREAD_IDS,
  BROADCAST_SIDECAR_THREADS,
  type SpecialThreadId,
} from '../src/specialThreads.js';

// The socket is gated as a whole (spec/02 § Control IPC); the MCP child
// presents the host's local key as a Bearer on every call.
const LOCAL_KEY = 'test-local-key';

const silent = pino({ level: 'silent' });

interface MockDevice {
  deviceId: string;
  online: boolean;
  muted: boolean;
  lastUsedAt: number;
}

interface DaemonStack {
  app: FastifyInstance;
  socketPath: string;
  cwd: string;
  daemon: Daemon;
  upstream: WireEvent[];
  sentFrames: { deviceId: string; frame: Record<string, unknown> }[];
  pushFallbacks: { chatId: string; message: string }[];
  spawnChat: (folder: string) => Promise<string>;
  capturedPrompts: string[];
  close: () => Promise<void>;
}

let tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

// Boot a real host control server on a real UDS socket, wired exactly like
// index.ts: real speakers cascade against `devices`, real sidecar IO under
// `cwd`, real onBroadcast self-loop suppression, real preprocessInput injection.
async function startDaemon(devices: MockDevice[] = []): Promise<DaemonStack> {
  const home = mkTmp('tc3d-home-');
  const cwd = mkTmp('tc3d-cwd-');
  const sockDir = mkTmp('tc3d-sock-');
  const socketPath = join(sockDir, 'daemon.sock');

  const upstream: WireEvent[] = [];
  const sentFrames: { deviceId: string; frame: Record<string, unknown> }[] = [];
  const pushFallbacks: { chatId: string; message: string }[] = [];
  const capturedPrompts: string[] = [];

  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: {
      run: async function* (opts: { prompt: string }) {
        capturedPrompts.push(opts.prompt);
        yield { type: 'assistant', content: 'ok', sessionId: 'S1' };
      },
    },
    oauthAccessToken: 'x',
    emit: (e) => upstream.push(e),
    logger: silent,
    now: () => Date.now(),
    // Mirror index.ts broadcast-sidecar injection on reply for special threads.
    preprocessInput: (req: { chatId: string; message: string; voicePrefix?: string }) => {
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(req.chatId)) return undefined;
      const threadId = req.chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return undefined;
      const entries = readPendingBroadcasts(cwd, threadId);
      const block = buildBroadcastSystemReminder(entries, Date.now());
      if (!block) return undefined;
      return block + (req.voicePrefix ? `${req.voicePrefix}${req.message}` : req.message);
    },
    onTurnCommitted: (chatId: string) => {
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(chatId)) return;
      const threadId = chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return;
      flushBroadcasts(cwd, threadId);
    },
  });
  daemon.hydrate?.();
  ensureSpecialThreads({
    patchHome: cwd,
    metaStore,
    chatState: daemon.chatState,
    now: () => Date.now(),
    logger: silent,
    permissionModeDefault: 'auto',
  });

  const byId = (id: string) => devices.find((d) => d.deviceId === id);
  const jobs = new MemoryJobsStore({ now: () => Date.now() });

  const app = await buildControl({
    localKey: LOCAL_KEY,
    daemon,
    jobs,
    emitWire: (e) => upstream.push(e),
    // Real speakers cascade deps — stateful mock presence registry.
    speakers: {
      presence: {
        enumerate: () => devices.map((d) => ({ ...d })),
        isOnline: (id) => byId(id)?.online ?? false,
        isMuted: (id) => byId(id)?.muted ?? false,
        send: (id, frame) => {
          const d = byId(id);
          if (!d || !d.online) return false;
          sentFrames.push({ deviceId: id, frame });
          return true;
        },
      },
      pushFallback: ({ chatId, message }) => {
        pushFallbacks.push({ chatId, message });
      },
    },
    // Real broadcast-sidecar wiring (index.ts onBroadcast).
    onBroadcast: ({ channel, message, sourceChatId }) => {
      const threadId = threadForChannel(channel);
      if (!threadId) return;
      if (isBroadcastSelfLoop(channel, sourceChatId)) return;
      const sourceState = daemon.chatState.get(sourceChatId);
      const sourceChatName = sourceState?.name ?? sourceChatId;
      appendBroadcast(cwd, threadId, { ts: Date.now(), sourceChatName, message });
    },
  });

  await app.listen({ path: socketPath });

  return {
    app,
    socketPath,
    cwd,
    daemon,
    upstream,
    sentFrames,
    pushFallbacks,
    capturedPrompts,
    spawnChat: (folder: string) => daemon.spawnChat({ folder }),
    close: async () => {
      await app.close();
    },
  };
}

beforeEach(() => {
  tmpRoots = [];
});
afterEach(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const recent = (msAgo: number) => Date.now() - msAgo;

describe('TC3 [test-runner] speakers cascade over a real UDS host', () => {
  it('B6a explicit deviceId rings exactly that device with conversational:false ring frame', async () => {
    const s = await startDaemon([
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(60_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(1_000) },
    ]);
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: {
          channel: 'speakers',
          message: 'wash done',
          callerChatId: chatId,
          deviceId: 'kitchen',
        },
      });
      expect(s.sentFrames).toHaveLength(1);
      expect(s.sentFrames[0]?.deviceId).toBe('kitchen');
      expect(s.sentFrames[0]?.frame).toMatchObject({
        type: 'ring',
        conversational: false,
        message: 'wash done',
      });
      expect(s.pushFallbacks).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('B6b muted explicit target falls through to most-recently-active; muted always skipped', async () => {
    const s = await startDaemon([
      { deviceId: 'kitchen', online: true, muted: true, lastUsedAt: recent(1_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(2_000) },
    ]);
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'speakers', message: 'm', callerChatId: chatId, deviceId: 'kitchen' },
      });
      expect(s.sentFrames.map((f) => f.deviceId)).toEqual(['bedroom']);
    } finally {
      await s.close();
    }
  });

  it('B6c no deviceId → most-recently-active online+unmuted device', async () => {
    const s = await startDaemon([
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(120_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(3_000) },
      { deviceId: 'office', online: true, muted: false, lastUsedAt: recent(240_000) },
    ]);
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'speakers', message: 'm', callerChatId: chatId },
      });
      expect(s.sentFrames.map((f) => f.deviceId)).toEqual(['bedroom']);
    } finally {
      await s.close();
    }
  });

  it('B6d nothing recently active → all online+unmuted at low volume', async () => {
    const s = await startDaemon([
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(10 * 60_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(20 * 60_000) },
      { deviceId: 'office', online: true, muted: true, lastUsedAt: recent(11 * 60_000) },
    ]);
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'speakers', message: 'm', callerChatId: chatId },
      });
      expect(s.sentFrames.map((f) => f.deviceId).sort()).toEqual(['bedroom', 'kitchen']);
      for (const f of s.sentFrames) {
        expect(f.frame).toMatchObject({ conversational: false, lowVolume: true });
      }
    } finally {
      await s.close();
    }
  });

  it('B6e all devices offline/muted → push fallback fires with text (not dropped)', async () => {
    const s = await startDaemon([
      { deviceId: 'kitchen', online: false, muted: false, lastUsedAt: recent(1_000) },
      { deviceId: 'bedroom', online: true, muted: true, lastUsedAt: recent(2_000) },
    ]);
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'speakers', message: 'fire alarm', callerChatId: chatId },
      });
      expect(s.sentFrames).toHaveLength(0);
      expect(s.pushFallbacks).toEqual([{ chatId, message: 'fire alarm' }]);
    } finally {
      await s.close();
    }
  });
});

describe('TC3 [test-runner] notify wire emission + sidecar over real UDS', () => {
  it('B5a speakers notify emits a notify wire event AND appends to the speakers sidecar', async () => {
    const s = await startDaemon();
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'speakers', message: 'bus delayed', callerChatId: chatId },
      });
      const notify = s.upstream.find((e) => e.type === 'notify');
      expect(notify).toMatchObject({ type: 'notify', channel: 'speakers', message: 'bus delayed' });
      const entries = readPendingBroadcasts(s.cwd, 'thread_speakers');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toBe('bus delayed');
    } finally {
      await s.close();
    }
  });

  it('B10a push/desktop notify do NOT write any broadcast sidecar', async () => {
    const s = await startDaemon();
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'push', message: 'p', callerChatId: chatId },
      });
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'desktop', message: 'd', callerChatId: chatId },
      });
      expect(readPendingBroadcasts(s.cwd, 'thread_speakers')).toHaveLength(0);
      expect(readPendingBroadcasts(s.cwd, 'thread_speakers')).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('B13 unknown caller chat → 404', async () => {
    const s = await startDaemon();
    try {
      await expect(
        udsRequest(s.socketPath, {
          localKey: LOCAL_KEY,
          method: 'POST',
          path: '/internal/notify',
          body: { channel: 'push', message: 'x', callerChatId: 'does-not-exist' },
        }),
      ).rejects.toThrow(/404/);
    } finally {
      await s.close();
    }
  });

  it('B14 self-loop suppressed: thread_speakers firing speakers does NOT append to its own sidecar', async () => {
    const s = await startDaemon();
    try {
      // thread_speakers already exists from ensureSpecialThreads.
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/notify',
        body: { channel: 'speakers', message: 'self', callerChatId: 'thread_speakers' },
      });
      // wire event still emitted (delivery happens) but no sidecar self-append.
      expect(s.upstream.some((e) => e.type === 'notify')).toBe(true);
      expect(readPendingBroadcasts(s.cwd, 'thread_speakers')).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

describe('TC3 [test-runner] patch_call over real UDS', () => {
  it('B7a patch_call emits a patch.call wire event for the caller chat', async () => {
    const s = await startDaemon();
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    try {
      await udsRequest(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'POST',
        path: '/internal/call',
        body: { callerChatId: chatId, message: 'need a decision' },
      });
      const call = s.upstream.find((e) => e.type === 'patch.call');
      expect(call).toMatchObject({ type: 'patch.call', chatId, message: 'need a decision' });
    } finally {
      await s.close();
    }
  });
});

describe('TC3 [test-runner] broadcast sidecar injection + flush over real host turns', () => {
  it('B15 sidecar injected as <system-reminder> on next speakers reply, then flushed', async () => {
    const s = await startDaemon();
    // A real notify from a normal chat lands in the speakers sidecar.
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    await udsRequest(s.socketPath, {
      localKey: LOCAL_KEY,
      method: 'POST',
      path: '/internal/notify',
      body: { channel: 'speakers', message: 'washing machine done', callerChatId: chatId },
    });
    try {
      expect(readPendingBroadcasts(s.cwd, 'thread_speakers')).toHaveLength(1);
      // User replies in the speakers thread — preprocessInput injects the block.
      await s.daemon.sendInput({
        chatId: 'thread_speakers',
        message: 'snooze 10 min',
        localId: 'r1',
      });
      const prompt = s.capturedPrompts[s.capturedPrompts.length - 1] ?? '';
      expect(prompt).toContain('<system-reminder>');
      expect(prompt).toContain('washing machine done');
      expect(prompt).toContain('snooze 10 min');
      // Flushed after the agent committed a response.
      expect(readPendingBroadcasts(s.cwd, 'thread_speakers')).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('B16 sidecar NOT flushed when the agent invocation fails (broadcasts persist)', async () => {
    // Build a stack whose SDK throws, mirroring index.ts wiring.
    const home = mkTmp('tc3d-home-');
    const cwd = mkTmp('tc3d-cwd-');
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: {
        run: async function* () {
          throw new Error('simulated SDK failure');
          yield { type: 'assistant', content: 'x', sessionId: 'S' };
        },
      },
      oauthAccessToken: 'x',
      emit: () => {},
      logger: silent,
      now: () => Date.now(),
      preprocessInput: (req: { chatId: string; message: string }) => {
        if (req.chatId !== 'thread_speakers') return undefined;
        const entries = readPendingBroadcasts(cwd, 'thread_speakers');
        const block = buildBroadcastSystemReminder(entries, Date.now());
        if (!block) return undefined;
        return block + req.message;
      },
      onTurnCommitted: (chatId: string) => {
        if (chatId === 'thread_speakers') flushBroadcasts(cwd, 'thread_speakers');
      },
    });
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => Date.now(),
      logger: silent,
      permissionModeDefault: 'auto',
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: Date.now(),
      sourceChatName: 'bus-watch',
      message: 'bus delayed',
    });
    await daemon.sendInput({ chatId: 'thread_speakers', message: 'snooze', localId: 'f1' });
    expect(daemon.chatState.get('thread_speakers')?.activity).toBe('errored');
    const pending = readPendingBroadcasts(cwd, 'thread_speakers');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message).toBe('bus delayed');
    // sidecar file still present (not flushed)
    expect(existsSync(broadcastSidecarPath(cwd, 'thread_speakers'))).toBe(true);
  });

  it('B17 sidecar caps at 10k chars, truncating oldest first', async () => {
    const s = await startDaemon();
    const big = 'x'.repeat(1000);
    for (let i = 0; i < 15; i++) {
      appendBroadcast(s.cwd, 'thread_speakers', {
        ts: Date.now() + i,
        sourceChatName: `chat-${i}`,
        message: `${i}-${big}`,
      });
    }
    try {
      const entries = readPendingBroadcasts(s.cwd, 'thread_speakers');
      const total = entries.reduce(
        (acc, e) => acc + e.message.length + e.sourceChatName.length + 32,
        0,
      );
      expect(total).toBeLessThanOrEqual(10_000);
      expect(entries.length).toBeLessThan(15);
      expect(entries[entries.length - 1]?.sourceChatName).toBe('chat-14');
      expect(entries.find((e) => e.sourceChatName === 'chat-0')).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});

describe('TC3 [test-runner] special-thread first turn after a host RESTART (real UDS)', () => {
  // The reviewer hit `claude_session_missing` because a special thread persists
  // in meta.json across a host restart but may receive its very FIRST user
  // turn only after the restart — at which point it is hydrated-from-disk with
  // claudeSessionId=undefined and nextSeq=0. With the F1 fix, a chat that never
  // emitted an event (nextSeq=0) starts fresh instead of being refused.
  it('B18 hydrated-from-disk thread_speakers with nextSeq=0 completes its first turn and routes a reply', async () => {
    const home = mkTmp('tc3d-home-');
    const cwd = mkTmp('tc3d-cwd-');
    const sockDir = mkTmp('tc3d-sock-');
    const socketPath = join(sockDir, 'daemon.sock');
    const metaStore = createMetaStore(home);
    const capturedPrompts: string[] = [];
    const upstream: WireEvent[] = [];

    // Pre-seed meta.json exactly as a prior boot's ensureSpecialThreads would
    // have written it: a special thread that never had a turn.
    metaStore.write({
      chatId: 'thread_speakers',
      // ~/.patch/threads/<name> — resolved from the host user's HOME, which is
      // what `cwd` stands in for here (it is passed as the patch home below).
      folder: join(cwd, 'threads', 'speakers'),
      name: 'speakers',
      nextSeq: 0,
      pinned: false,
      pinnedAt: null,
      status: 'active',
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    });

    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: {
        run: async function* (opts: { prompt: string }) {
          capturedPrompts.push(opts.prompt);
          yield { type: 'assistant', content: 'got it', sessionId: 'sess-tg-1' };
        },
      },
      oauthAccessToken: 'x',
      emit: (e) => upstream.push(e),
      logger: silent,
      now: () => Date.now(),
    });
    // RESTART path: hydrate marks thread_speakers as hydrated-from-disk.
    daemon.hydrate();
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => Date.now(),
      logger: silent,
      permissionModeDefault: 'auto',
    });
    const jobs = new MemoryJobsStore({ now: () => Date.now() });
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    await app.listen({ path: socketPath });

    try {
      // First user turn arrives on a thread that has never run. It must NOT be
      // refused with claude_session_missing.
      await daemon.sendInput({
        chatId: 'thread_speakers',
        message: 'hello from speakers',
        localId: 'first-turn-1',
      });
      await new Promise((r) => setTimeout(r, 20));

      // The SDK was invoked (turn ran) and produced a reply.
      expect(capturedPrompts.at(-1)).toContain('hello from speakers');
      const state = daemon.chatState.get('thread_speakers');
      expect(state?.activity).toBe('idle');
      expect(state?.claudeSessionId).toBe('sess-tg-1');

      // No claude_session_missing error was emitted.
      const err = upstream.find((e) => e.type === 'chat.error');
      expect(err).toBeUndefined();

      // The assistant reply is on the wire (the daemon-enforced direct reply
      // routes it back to the speakers channel downstream of this event).
      const reply = upstream.find((e) => e.type === 'chat.message' && e.role === 'assistant') as
        | { content: string }
        | undefined;
      expect(reply?.content).toBe('got it');

      // patch_peek over the real UDS returns the spec'd shape and now carries
      // the just-emitted wire events for the thread.
      const peek = await udsRequest<{
        chat_state: { chatId: string; activity: string };
        events: unknown[];
        truncated: boolean;
      }>(socketPath, {
        localKey: LOCAL_KEY,
        method: 'GET',
        path: '/internal/peek/thread_speakers',
      });
      expect(peek.chat_state.chatId).toBe('thread_speakers');
      expect(peek.chat_state.activity).toBe('idle');
      expect(Array.isArray(peek.events)).toBe(true);
      expect(peek.events.length).toBeGreaterThan(0);
      expect(peek.truncated).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('B19 patch_peek respects opts.limit and reports truncated when more events exist', async () => {
    const s = await startDaemon();
    const folder = mkTmp('tc3d-folder-');
    const chatId = await s.spawnChat(folder);
    // Drive several turns to accumulate wire events on the chat.
    for (let i = 0; i < 4; i++) {
      await s.daemon.sendInput({ chatId, message: `turn ${i}`, localId: `t-${i}` });
      await new Promise((r) => setTimeout(r, 10));
    }
    try {
      const full = await udsRequest<{ events: unknown[]; truncated: boolean }>(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'GET',
        path: `/internal/peek/${chatId}`,
      });
      expect(full.events.length).toBeGreaterThan(1);

      // Ask for just 1 event — must return 1 and flag truncated.
      const limited = await udsRequest<{ events: unknown[]; truncated: boolean }>(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'GET',
        path: `/internal/peek/${chatId}?limit=1`,
      });
      expect(limited.events).toHaveLength(1);
      expect(limited.truncated).toBe(true);

      // limit is clamped to the 200 hard cap (no error for over-cap).
      const capped = await udsRequest<{ events: unknown[] }>(s.socketPath, {
        localKey: LOCAL_KEY,
        method: 'GET',
        path: `/internal/peek/${chatId}?limit=9999`,
      });
      expect(capped.events.length).toBe(full.events.length);
    } finally {
      await s.close();
    }
  });
});
