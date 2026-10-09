// Group 11 — host side: special-thread bootstrap, broadcast sidecar,
// patch_notify + patch_call UDS endpoints, system-reminder injection.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import {
  ensureSpecialThreads,
  appendBroadcast,
  readPendingBroadcasts,
  flushBroadcasts,
  buildBroadcastSystemReminder,
  specialThreadFolder,
  broadcastSidecarPath,
  threadForChannel,
  isBroadcastSelfLoop,
} from '../src/specialThreads.js';

// The control socket is gated as a whole (spec/02 § Control IPC): every
// route but /healthz needs the host's local key.
const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-notif-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'patch-notif-cwd-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-notif-folder-'));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  const events: WireEvent[] = [];
  const upstream: WireEvent[] = [];
  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'x',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
  return { home, cwd, folder, sdk, events, upstream, metaStore, daemon, jobs };
}

describe('special threads — bootstrap', () => {
  it('creates folders + empty CLAUDE.md + chat_state entries on first run', () => {
    const { cwd, metaStore, daemon } = setup();
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    for (const id of ['thread_manager', 'thread_speakers']) {
      const folder = specialThreadFolder(cwd, id as 'thread_manager');
      expect(existsSync(folder)).toBe(true);
      const claude = join(folder, 'CLAUDE.md');
      expect(existsSync(claude)).toBe(true);
      expect(readFileSync(claude, 'utf8')).toBe('');
      expect(daemon.chatState.has(id)).toBe(true);
    }
    // Manager is pinned by default.
    expect(daemon.chatState.get('thread_manager')?.pinned).toBe(true);
  });

  it('is idempotent — re-running does not overwrite a user-edited CLAUDE.md', () => {
    const { cwd, metaStore, daemon } = setup();
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    const claude = join(specialThreadFolder(cwd, 'thread_manager'), 'CLAUDE.md');
    writeFileSync(claude, '# user content', 'utf8');
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    expect(readFileSync(claude, 'utf8')).toBe('# user content');
  });
});

describe('broadcast sidecar', () => {
  it('append → read → flush round trip', () => {
    const { cwd, metaStore, daemon } = setup();
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 1_700_000_000_000,
      sourceChatName: 'bus-watch',
      message: 'bus arriving in 8 min',
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 1_700_000_001_000,
      sourceChatName: 'washing-machine',
      message: 'washing machine done',
    });
    const entries = readPendingBroadcasts(cwd, 'thread_speakers');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.sourceChatName).toBe('bus-watch');
    flushBroadcasts(cwd, 'thread_speakers');
    expect(readPendingBroadcasts(cwd, 'thread_speakers')).toHaveLength(0);
  });

  it('builds a <system-reminder> block with relative timestamps', () => {
    const now = 1_700_000_300_000;
    const block = buildBroadcastSystemReminder(
      [
        { ts: 1_700_000_000_000, sourceChatName: 'bus-watch', message: 'bus arriving in 8 min' },
        { ts: 1_700_000_240_000, sourceChatName: 'washer', message: 'washing done' },
      ],
      now,
    );
    expect(block).toContain('<system-reminder>');
    expect(block).toContain('bus-watch');
    expect(block).toContain('5 min ago');
    expect(block).toContain('1 min ago');
  });

  it('returns null when no broadcasts pending', () => {
    expect(buildBroadcastSystemReminder([], Date.now())).toBeNull();
  });

  it('caps the sidecar at 10k chars, truncating oldest first (spec/09 ## Cap)', () => {
    const { cwd, metaStore, daemon } = setup();
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    // ~1k chars each; 15 entries ≈ 15k > 10k cap.
    const big = 'x'.repeat(1000);
    for (let i = 0; i < 15; i++) {
      appendBroadcast(cwd, 'thread_speakers', {
        ts: 1_700_000_000_000 + i,
        sourceChatName: `chat-${i}`,
        message: `${i}-${big}`,
      });
    }
    const entries = readPendingBroadcasts(cwd, 'thread_speakers');
    // Oldest dropped first: the surviving set must fit under the cap and the
    // newest entry must always be retained.
    const totalChars = entries.reduce(
      (s, e) => s + e.message.length + e.sourceChatName.length + 32,
      0,
    );
    expect(totalChars).toBeLessThanOrEqual(10_000);
    expect(entries.length).toBeLessThan(15);
    // Newest survives, oldest dropped.
    expect(entries[entries.length - 1]?.sourceChatName).toBe('chat-14');
    expect(entries.find((e) => e.sourceChatName === 'chat-0')).toBeUndefined();
  });
});

describe('threadForChannel', () => {
  it('maps speakers to its thread, push/desktop to null', () => {
    expect(threadForChannel('speakers')).toBe('thread_speakers');
    expect(threadForChannel('push')).toBeNull();
    expect(threadForChannel('desktop')).toBeNull();
  });
});

describe('isBroadcastSelfLoop (group 12 DX-1)', () => {
  it('flags same-channel broadcasts from the mediating thread', () => {
    expect(isBroadcastSelfLoop('speakers', 'thread_speakers')).toBe(true);
  });
  it('does NOT flag broadcasts from a normal chat to any channel', () => {
    expect(isBroadcastSelfLoop('speakers', 'chat-abc')).toBe(false);
  });
  it('returns false for channels with no mediating thread', () => {
    expect(isBroadcastSelfLoop('push', 'thread_speakers')).toBe(false);
    expect(isBroadcastSelfLoop('desktop', 'thread_speakers')).toBe(false);
  });
});

describe('UDS /internal/notify', () => {
  it('emits a notify wire event when caller chat exists', async () => {
    const { daemon, jobs, folder, upstream } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const broadcasts: { channel: string; message: string; sourceChatId: string }[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
      onBroadcast: (entry) => broadcasts.push(entry),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', message: 'bus delayed', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
      const notify = upstream.find((e) => e.type === 'notify');
      expect(notify).toBeDefined();
      expect(notify).toMatchObject({
        type: 'notify',
        chatId,
        channel: 'speakers',
        message: 'bus delayed',
      });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({ channel: 'speakers', sourceChatId: chatId });
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown caller', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'x', callerChatId: 'nope' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // spec/09 § `### push` — deepLink is carried through the UDS body onto the
  // emitted wire event so the server can act on it and the chat transcript
  // can render the same link (03-wire-protocol.md's `notify` event shape).
  it('passes deepLink through onto the emitted notify wire event', async () => {
    const { daemon, jobs, folder, upstream } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: {
          channel: 'push',
          message: 'Route ready',
          deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
          callerChatId: chatId,
        },
      });
      expect(res.statusCode).toBe(200);
      const notify = upstream.find((e) => e.type === 'notify');
      expect(notify).toMatchObject({
        type: 'notify',
        chatId,
        channel: 'push',
        message: 'Route ready',
        deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
      });
    } finally {
      await app.close();
    }
  });

  it('omits deepLink from the emitted wire event when not given', async () => {
    const { daemon, jobs, folder, upstream } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'x', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
      const notify = upstream.find((e) => e.type === 'notify') as Record<string, unknown>;
      expect('deepLink' in notify).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('UDS /internal/call', () => {
  it('emits a patch.call wire event for the caller chat by default', async () => {
    const { daemon, jobs, folder, upstream } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId, message: 'urgent' },
      });
      expect(res.statusCode).toBe(200);
      const call = upstream.find((e) => e.type === 'patch.call');
      expect(call).toMatchObject({ type: 'patch.call', chatId, message: 'urgent' });
    } finally {
      await app.close();
    }
  });

  it('uses the explicit chatId when provided', async () => {
    const { daemon, jobs, folder, upstream } = setup();
    const callerId = await daemon.spawnChat({ folder });
    const targetId = await daemon.spawnChat({ folder });
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: callerId, chatId: targetId },
      });
      expect(res.statusCode).toBe(200);
      const call = upstream.find((e) => e.type === 'patch.call');
      expect(call).toMatchObject({ type: 'patch.call', chatId: targetId });
    } finally {
      await app.close();
    }
  });
});

describe('UDS /internal/notify — speakers device-resolution cascade (spec/09 §speakers)', () => {
  // A mock PresenceRegistry-shaped backend exercised end-to-end through the
  // notify handler. Each device records the frames it was sent so assertions
  // can inspect the ring frame (incl. `conversational: false`).
  interface MockDevice {
    deviceId: string;
    online: boolean;
    muted: boolean;
    lastUsedAt: number;
  }
  function mockSpeakers(devices: MockDevice[]) {
    const sent: { deviceId: string; frame: Record<string, unknown> }[] = [];
    const pushes: { chatId: string; message: string }[] = [];
    const byId = (id: string) => devices.find((d) => d.deviceId === id);
    return {
      sent,
      pushes,
      deps: {
        presence: {
          enumerate: () => devices.map((d) => ({ ...d })),
          isOnline: (id: string) => byId(id)?.online ?? false,
          isMuted: (id: string) => byId(id)?.muted ?? false,
          send: (id: string, frame: Record<string, unknown>) => {
            const d = byId(id);
            if (!d || !d.online) return false;
            sent.push({ deviceId: id, frame });
            return true;
          },
        },
        pushFallback: (input: { chatId: string; message: string }) => {
          pushes.push(input);
        },
      },
    };
  }

  // The handler stamps `now` via Date.now(), so anchor recency to real time.
  const recent = (msAgo: number) => Date.now() - msAgo;

  async function fireSpeakers(
    speakers: ReturnType<typeof mockSpeakers>,
    extra: { message?: string; deviceId?: string } = {},
  ) {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, speakers: speakers.deps });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: {
          channel: 'speakers',
          message: extra.message ?? 'washing machine done',
          callerChatId: chatId,
          ...(extra.deviceId !== undefined ? { deviceId: extra.deviceId } : {}),
        },
      });
      expect(res.statusCode).toBe(200);
      return chatId;
    } finally {
      await app.close();
    }
  }

  it('explicit deviceId rings that device', async () => {
    const m = mockSpeakers([
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(60_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(1_000) },
    ]);
    await fireSpeakers(m, { deviceId: 'kitchen' });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.deviceId).toBe('kitchen');
    expect(m.pushes).toHaveLength(0);
  });

  it('ring frame carries conversational: false (one-way speak-and-end)', async () => {
    const m = mockSpeakers([
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(1_000) },
    ]);
    const chatId = await fireSpeakers(m, { deviceId: 'kitchen', message: 'bus in 8 min' });
    expect(m.sent[0]?.frame).toMatchObject({
      type: 'ring',
      chatId,
      message: 'bus in 8 min',
      conversational: false,
    });
  });

  it('explicit deviceId that is MUTED falls through the cascade', async () => {
    const m = mockSpeakers([
      // explicit target is muted → skipped
      { deviceId: 'kitchen', online: true, muted: true, lastUsedAt: recent(1_000) },
      // recently-active fallback
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(2_000) },
    ]);
    await fireSpeakers(m, { deviceId: 'kitchen' });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.deviceId).toBe('bedroom');
    expect(m.pushes).toHaveLength(0);
  });

  it('explicit deviceId that is OFFLINE falls through the cascade', async () => {
    const m = mockSpeakers([
      { deviceId: 'kitchen', online: false, muted: false, lastUsedAt: recent(1_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(2_000) },
    ]);
    await fireSpeakers(m, { deviceId: 'kitchen' });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.deviceId).toBe('bedroom');
  });

  it('no deviceId → most-recently-active online+unmuted device', async () => {
    const m = mockSpeakers([
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(120_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(3_000) }, // most recent
      { deviceId: 'office', online: true, muted: false, lastUsedAt: recent(240_000) },
    ]);
    await fireSpeakers(m);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.deviceId).toBe('bedroom');
    expect(m.pushes).toHaveLength(0);
  });

  it('most-recently-active selection SKIPS a more-recent muted device', async () => {
    const m = mockSpeakers([
      // more recent but muted → must be skipped at every step
      { deviceId: 'kitchen', online: true, muted: true, lastUsedAt: recent(1_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(5_000) },
    ]);
    await fireSpeakers(m);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.deviceId).toBe('bedroom');
  });

  it('nothing recently active → all online+unmuted devices at low volume', async () => {
    const m = mockSpeakers([
      // both online+unmuted but stale (> 5 min) → step 3 general announcement
      { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: recent(10 * 60_000) },
      { deviceId: 'bedroom', online: true, muted: false, lastUsedAt: recent(20 * 60_000) },
      // muted device must be excluded from the announcement
      { deviceId: 'office', online: true, muted: true, lastUsedAt: recent(11 * 60_000) },
    ]);
    await fireSpeakers(m);
    expect(m.sent.map((s) => s.deviceId).sort()).toEqual(['bedroom', 'kitchen']);
    // every announcement frame is low-volume and still conversational: false
    for (const s of m.sent) {
      expect(s.frame).toMatchObject({ type: 'ring', conversational: false, lowVolume: true });
    }
    expect(m.pushes).toHaveLength(0);
  });

  it('all devices offline or muted → push fallback fires with the text', async () => {
    const m = mockSpeakers([
      { deviceId: 'kitchen', online: false, muted: false, lastUsedAt: recent(1_000) },
      { deviceId: 'bedroom', online: true, muted: true, lastUsedAt: recent(2_000) },
    ]);
    const chatId = await fireSpeakers(m, { message: 'fire alarm test' });
    expect(m.sent).toHaveLength(0);
    expect(m.pushes).toHaveLength(1);
    expect(m.pushes[0]).toEqual({ chatId, message: 'fire alarm test' });
  });

  it('no registered devices at all → push fallback', async () => {
    const m = mockSpeakers([]);
    await fireSpeakers(m);
    expect(m.sent).toHaveLength(0);
    expect(m.pushes).toHaveLength(1);
  });
});

describe('preprocessInput injects <system-reminder> on next user reply', () => {
  it('on thread_speakers a pending broadcast is prepended once and then flushed', async () => {
    const { home, cwd, sdk, events } = setup();
    const captured: string[] = [];
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: {
        run: async function* (opts) {
          captured.push(opts.prompt);
          yield { type: 'assistant', content: 'ok', sessionId: 'S' };
        },
      },
      oauthAccessToken: 'x',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_500_000,
      preprocessInput: (req) => {
        if (req.chatId !== 'thread_speakers') return undefined;
        const entries = readPendingBroadcasts(cwd, 'thread_speakers');
        const block = buildBroadcastSystemReminder(entries, 1_700_000_500_000);
        if (!block) return undefined;
        return block + req.message;
      },
      onTurnCommitted: (chatId) => {
        if (chatId === 'thread_speakers') flushBroadcasts(cwd, 'thread_speakers');
      },
    });
    void sdk;
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 1_700_000_400_000,
      sourceChatName: 'bus-watch',
      message: 'bus delayed',
    });
    await daemon.sendInput({
      chatId: 'thread_speakers',
      message: 'snooze 10 min',
      localId: 'l1',
    });
    expect(captured[0]).toContain('<system-reminder>');
    expect(captured[0]).toContain('bus-watch');
    expect(captured[0]).toContain('snooze 10 min');
    // Flushed: a second turn with no new broadcasts gets no reminder block.
    await daemon.sendInput({
      chatId: 'thread_speakers',
      message: 'thanks',
      localId: 'l2',
    });
    expect(captured[1]).toBe('thanks');
    expect(existsSync(broadcastSidecarPath(cwd, 'thread_speakers'))).toBe(true);
    expect(readPendingBroadcasts(cwd, 'thread_speakers')).toHaveLength(0);
  });

  it('does NOT flush the sidecar when the agent invocation FAILS (spec/09 ## Flush)', async () => {
    const { home, cwd, events } = setup();
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      // SDK backend that throws — simulates a network drop / SDK error so the
      // turn never commits a response.
      sdkBackend: {
        run: async function* () {
          throw new Error('simulated SDK failure');
          yield { type: 'assistant', content: 'unreachable', sessionId: 'S' };
        },
      },
      oauthAccessToken: 'x',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_500_000,
      preprocessInput: (req) => {
        if (req.chatId !== 'thread_speakers') return undefined;
        const entries = readPendingBroadcasts(cwd, 'thread_speakers');
        const block = buildBroadcastSystemReminder(entries, 1_700_000_500_000);
        if (!block) return undefined;
        return block + req.message;
      },
      onTurnCommitted: (chatId) => {
        if (chatId === 'thread_speakers') flushBroadcasts(cwd, 'thread_speakers');
      },
    });
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => 1_700_000_000_000,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 1_700_000_400_000,
      sourceChatName: 'bus-watch',
      message: 'bus delayed',
    });
    // The SDK throws; runQuery catches it and marks the chat errored. The
    // broadcast must persist for the next attempt — NOT be flushed.
    await daemon.sendInput({
      chatId: 'thread_speakers',
      message: 'snooze 10 min',
      localId: 'fail-1',
    });
    // Turn errored — verify the chat is in the errored state.
    expect(daemon.chatState.get('thread_speakers')?.activity).toBe('errored');
    // Sidecar still holds the broadcast (NOT flushed on failure).
    const pending = readPendingBroadcasts(cwd, 'thread_speakers');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message).toBe('bus delayed');
  });
});
