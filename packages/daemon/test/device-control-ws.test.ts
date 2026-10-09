// Voice-device control-plane WSS integration (F2, spec/16). Drives the real
// `/device/control` endpoint mounted on the audio HTTP listener with real WS
// sockets and a real device EdDSA-JWT, covering:
//   - upgrade auth (good token online; bad/missing/unregistered → 401)
//   - hello → presence online; close → offline
//   - mute_changed → presence muted; muted device skipped by the cascade
//   - patch_notify(speakers) cascade: explicit deviceId, most-recently-active,
//     fall-through on mute, all-offline → push
//   - ring → ring_accepted → session_start with a VALID daemon-minted voiceToken
//   - wake_detected → conversational session_start to the Speakers thread
//   - concurrency: phone call active → device ring queued, runs on call end
//
// NO AUDIO is produced or played — we assert on control frames + the token's
// claims only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { encodeDeviceControl } from '@patch/wire/device-control';
import { encodeAudio } from '@patch/wire/audio';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { PresenceRegistry } from '../src/devices/presence.js';
import { DeviceControlServer, mountDeviceControlUpgrade } from '../src/devices/control-ws.js';
import { resolveSpeakers, type SpeakerCascadeDeps } from '../src/devices/speakers-cascade.js';
import { verifyVoiceToken } from '../src/audio/token-verifier.js';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

interface Harness {
  port: number;
  audio: AudioServerHandle;
  control: DeviceControlServer;
  registry: DeviceRegistry;
  presence: PresenceRegistry;
  accountPublicKey: string;
  userPrivateKey: string;
  phoneActive: { value: boolean };
  cascade: SpeakerCascadeDeps;
  pushes: { chatId: string; message: string }[];
  close: () => Promise<void>;
}

async function startHarness(opts: { maxConcurrentSessions?: number } = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'patch-f2-'));
  const { publicKey, privateKey } = generateUserKeypair();
  const registry = DeviceRegistry.load(home);
  const presence = new PresenceRegistry();
  const phoneActive = { value: false };

  const control = new DeviceControlServer({
    registry,
    presence,
    accountPublicKey: publicKey,
    accountId: publicKey,
    internalToken: SECRET,
    voiceDeviceChatId: 'thread_speakers',
    isPhoneCallActive: () => phoneActive.value,
    maxConcurrentSessions: opts.maxConcurrentSessions ?? 3,
    logger,
  });
  const wss = new WebSocketServer({ noServer: true });
  const pushes: { chatId: string; message: string }[] = [];
  const cascade: SpeakerCascadeDeps = {
    presence: {
      enumerate: () => presence.enumerate(registry.list()),
      isOnline: (id) => presence.isOnline(id),
      isMuted: (id) => presence.isMuted(id),
      // Route through the control plane, exactly like production (index.ts).
      send: (id, frame) => control.ring(id, frame as never),
    },
    pushFallback: (input) => pushes.push(input),
  };

  const audio = await startAudioServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    internalToken: SECRET,
    whisper: createWhisper({ backend: 'mock', logger }),
    kokoro: createKokoro({ backend: 'mock', logger }),
    chatExists: () => true,
    onSessionClosed: ({ wasPhoneCall }) => {
      if (wasPhoneCall) control.onPhoneCallEnded();
    },
    deviceControlUpgrade: mountDeviceControlUpgrade({ server: control, wss, logger }),
  });
  const port = audio.address().port;

  return {
    port,
    audio,
    control,
    registry,
    presence,
    accountPublicKey: publicKey,
    userPrivateKey: privateKey,
    phoneActive,
    cascade,
    pushes,
    async close() {
      control.closeAll();
      presence.closeAll();
      await audio.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function mintDeviceJwt(h: Harness, deviceId: string, name: string): Promise<string> {
  h.registry.register({
    deviceId,
    name,
    accountId: h.accountPublicKey,
    publicKey: h.accountPublicKey,
    registeredAt: Date.now(),
  });
  return mintSurfaceCredential({
    userPrivateKey: h.userPrivateKey,
    surfaceId: deviceId,
    surfaceKind: 'voice-device',
    label: name,
  });
}

/** Open a control WSS, send hello, return the socket + a frame inbox. */
async function connectDevice(
  h: Harness,
  deviceId: string,
  jwt: string,
  opts: { muted?: boolean } = {},
): Promise<{ ws: WebSocket; inbox: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/device/control`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  const inbox: Record<string, unknown>[] = [];
  ws.on('message', (data: Buffer) => {
    inbox.push(JSON.parse(data.toString('utf8')));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    encodeDeviceControl({
      type: 'hello',
      deviceId,
      fwVersion: 'mock-0.1.0',
      muted: opts.muted ?? false,
    } as never),
  );
  return { ws, inbox };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('device control WSS (F2)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('rejects an upgrade with no bearer token (401)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/device/control`);
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(String(err.message)).toMatch(/401/);
  });

  it('rejects an unregistered device even with a validly-signed JWT (401)', async () => {
    // Mint a voice-device JWT but DON'T register the device.
    const jwt = await mintSurfaceCredential({
      userPrivateKey: h.userPrivateKey,
      surfaceId: 'ghost',
      surfaceKind: 'voice-device',
      label: 'ghost',
    });
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/device/control`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(String(err.message)).toMatch(/401/);
  });

  it('hello brings the device online; close marks it offline', async () => {
    const jwt = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const { ws } = await connectDevice(h, 'kitchen', jwt);
    await tick();
    let list = h.presence.enumerate(h.registry.list());
    expect(list.find((d) => d.deviceId === 'kitchen')?.online).toBe(true);

    ws.close();
    await tick();
    list = h.presence.enumerate(h.registry.list());
    expect(list.find((d) => d.deviceId === 'kitchen')?.online).toBe(false);
  });

  it('mute_changed flips presence; a muted device is skipped by the cascade', async () => {
    const jwt = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const { ws, inbox } = await connectDevice(h, 'kitchen', jwt);
    await tick();
    ws.send(encodeDeviceControl({ type: 'mute_changed', muted: true } as never));
    await tick();
    expect(h.presence.isMuted('kitchen')).toBe(true);

    // Cascade with only a muted device online → falls through to push.
    const out = resolveSpeakers({ chatId: 'c1', message: 'bus in 5', now: Date.now() }, h.cascade);
    expect(out.kind).toBe('push');
    expect(h.pushes).toHaveLength(1);
    // No ring frame was sent to the muted device.
    expect(inbox.find((f) => f.type === 'ring')).toBeUndefined();
  });

  it('explicit deviceId rings exactly that device with a one-way ring frame', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const b = await mintDeviceJwt(h, 'bedroom', 'bedroom');
    const dk = await connectDevice(h, 'kitchen', k);
    const db = await connectDevice(h, 'bedroom', b);
    await tick();

    const out = resolveSpeakers(
      { chatId: 'c1', message: 'dinner ready', deviceId: 'kitchen', now: Date.now() },
      h.cascade,
    );
    await tick();
    expect(out).toEqual({ kind: 'device', deviceId: 'kitchen' });
    const ring = dk.inbox.find((f) => f.type === 'ring');
    expect(ring).toMatchObject({
      type: 'ring',
      chatId: 'c1',
      message: 'dinner ready',
      conversational: false,
    });
    expect(db.inbox.find((f) => f.type === 'ring')).toBeUndefined();
  });

  it('without deviceId rings the most-recently-active device', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const b = await mintDeviceJwt(h, 'bedroom', 'bedroom');
    await connectDevice(h, 'kitchen', k);
    const db = await connectDevice(h, 'bedroom', b);
    await tick();
    // bedroom is most recently active.
    h.presence.touch('kitchen', Date.now() - 120_000);
    h.presence.touch('bedroom', Date.now());

    const out = resolveSpeakers({ chatId: 'c1', message: 'hi', now: Date.now() }, h.cascade);
    await tick();
    expect(out).toEqual({ kind: 'device', deviceId: 'bedroom' });
    expect(db.inbox.find((f) => f.type === 'ring')).toBeDefined();
  });

  it('nothing recently active but devices reachable → step-3 low-volume announcement to all', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const b = await mintDeviceJwt(h, 'bedroom', 'bedroom');
    const dk = await connectDevice(h, 'kitchen', k);
    const db = await connectDevice(h, 'bedroom', b);
    await tick();
    // Both online+unmuted, but neither is within the recency window — no
    // single "most recently active" candidate, so the cascade broadcasts.
    const longAgo = Date.now() - 60 * 60 * 1000;
    h.presence.touch('kitchen', longAgo);
    h.presence.touch('bedroom', longAgo);

    const out = resolveSpeakers(
      { chatId: 'c1', message: 'general update', now: Date.now() },
      h.cascade,
    );
    await tick();
    expect(out.kind).toBe('all');
    if (out.kind === 'all') {
      expect(out.deviceIds.sort()).toEqual(['bedroom', 'kitchen']);
    }
    const kitchenRing = dk.inbox.find((f) => f.type === 'ring');
    const bedroomRing = db.inbox.find((f) => f.type === 'ring');
    expect(kitchenRing).toMatchObject({ lowVolume: true });
    expect(bedroomRing).toMatchObject({ lowVolume: true });
  });

  it('all devices offline → cascade falls through to push (message not dropped)', async () => {
    const out = resolveSpeakers(
      { chatId: 'c1', message: 'nobody home', now: Date.now() },
      h.cascade,
    );
    expect(out.kind).toBe('push');
    expect(h.pushes).toEqual([{ chatId: 'c1', message: 'nobody home' }]);
  });

  it('ring → ring_accepted → session_start carries a VALID daemon-minted voiceToken', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    // Notification ring (conversational:false).
    resolveSpeakers(
      { chatId: 'job-42', message: 'build done', deviceId: 'kitchen', now: Date.now() },
      h.cascade,
    );
    await tick();
    dk.ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();

    const start = dk.inbox.find((f) => f.type === 'session_start') as
      | {
          sessionId: string;
          voiceToken: string;
          accountId: string;
          chatId: string;
          conversational: boolean;
        }
      | undefined;
    expect(start).toBeDefined();
    expect(start!.chatId).toBe('job-42');
    expect(start!.conversational).toBe(false);
    // accountId is pushed to the device so it can declare a matching identity
    // on audio.session_start without decoding the opaque token.
    expect(start!.accountId).toBe(h.accountPublicKey);
    // The token must verify against the shared HMAC and bind to (device, chat, session).
    const claims = verifyVoiceToken({ secret: SECRET, token: start!.voiceToken });
    expect(claims.surfaceId).toBe('kitchen');
    expect(claims.chatId).toBe('job-42');
    expect(claims.sessionId).toBe(start!.sessionId);
    expect(claims.accountId).toBe(h.accountPublicKey);
    expect(h.control.activeSessionCount()).toBe(1);
  });

  it('wake_detected opens a conversational session to the Speakers thread', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    const start = dk.inbox.find((f) => f.type === 'session_start') as
      | { chatId: string; conversational: boolean; voiceToken: string }
      | undefined;
    expect(start).toBeDefined();
    expect(start!.chatId).toBe('thread_speakers');
    expect(start!.conversational).toBe(true);
    expect(start!.voiceToken.length).toBeGreaterThan(10);
  });

  it('F1: reconnect (fresh hello) releases a leaked session slot so the next wake is admitted', async () => {
    // Regression for the live F1 slot-leak: a device wakes (its arbiter slot
    // goes active), then reboots/reconnects WITHOUT sending session_end (the old
    // audio socket just drops). The fresh control socket helloes before the old
    // socket's close fires, so onClose's identity guard suppresses the stale
    // close and the slot is never released — every later wake is rejected
    // `device-already-active` forever. A fresh hello must clear that leaked slot.
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const d1 = await connectDevice(h, 'kitchen', k);
    await tick();
    d1.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    expect(d1.inbox.find((f) => f.type === 'session_start')).toBeDefined();
    // Device is now arbiter-active. Reconnect on a FRESH socket WITHOUT a
    // session_end (simulates a reboot / Wi-Fi blip).
    const d2 = await connectDevice(h, 'kitchen', k);
    await tick();
    // Without the fix the old conn's close is suppressed (d2 already registered)
    // and the slot leaks. The fresh hello must have released it. A new wake on
    // the reconnected socket must open a session, not be rejected.
    d2.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    const start2 = d2.inbox.find((f) => f.type === 'session_start');
    expect(start2).toBeDefined();
    d1.ws.close();
    d2.ws.close();
  });

  it('F2-12: device opens the audio WSS with the DAEMON-supplied token + surfaceKind device (no server mint)', async () => {
    // The device never calls the server's /api/voice/token endpoint. The host
    // mints the per-session token and pushes it in the session_start control
    // frame; the device presents exactly that token (surfaceKind 'device') when
    // it opens the audio WSS. This test takes the token the host delivered and
    // round-trips it through the real audio server on the SAME listener.
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    const start = dk.inbox.find((f) => f.type === 'session_start') as
      | { sessionId: string; voiceToken: string; chatId: string }
      | undefined;
    expect(start).toBeDefined();

    // Open the audio WSS for the daemon-issued sessionId and present the
    // daemon-supplied token, identifying as a 'device' surface.
    const audioWs = new WebSocket(`ws://127.0.0.1:${h.port}/audio/${start!.sessionId}`);
    const audioInbox: Record<string, unknown>[] = [];
    audioWs.on('message', (d: Buffer) => audioInbox.push(JSON.parse(d.toString('utf8'))));
    await new Promise<void>((resolve, reject) => {
      audioWs.once('open', () => resolve());
      audioWs.once('error', reject);
    });
    audioWs.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: start!.sessionId,
        accountId: h.accountPublicKey,
        surfaceId: 'kitchen',
        surfaceKind: 'device',
        chatId: start!.chatId,
        role: 'voice-device-conv',
        token: start!.voiceToken,
        surfaceHasAec: false,
        deviceId: 'kitchen',
      } as never),
    );
    await tick();
    // Accepted: no audio.error frame, and the audio server now reports one live
    // session (proving the daemon-supplied token authed a 'device' session).
    expect(audioInbox.find((f) => f.type === 'audio.error')).toBeUndefined();
    expect(h.audio.activeCount()).toBe(1);
    audioWs.close();
    await tick();
  });

  it('phone call active → device ring is queued, then runs when the call ends', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    h.phoneActive.value = true;

    // A ring lands while the phone call is active. The ring frame is still
    // delivered (the cascade chose the device) but the WAKE that the device
    // would send is what gets queued. Model the device accepting then waking:
    resolveSpeakers(
      { chatId: 'urgent', message: 'decision needed', deviceId: 'kitchen', now: Date.now() },
      h.cascade,
    );
    await tick();
    dk.ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();
    // Phone call holds the slot → no session_start yet.
    expect(dk.inbox.find((f) => f.type === 'session_start')).toBeUndefined();
    expect(h.control.queueDepth()).toBe(1);

    // Phone call ends → queued event drains → session_start now arrives.
    h.phoneActive.value = false;
    h.control.onPhoneCallEnded();
    await tick();
    expect(dk.inbox.find((f) => f.type === 'session_start')).toBeDefined();
    expect(h.control.activeSessionCount()).toBe(1);
  });

  it('F2-d1: wake_detected BEFORE hello is rejected — no session, never online', async () => {
    const jwt = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    // Open the control socket but DO NOT send hello; send wake_detected raw.
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/device/control`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const inbox: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer) => inbox.push(JSON.parse(data.toString('utf8'))));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();

    // No session_start was minted for the un-helloed device.
    expect(inbox.find((f) => f.type === 'session_start')).toBeUndefined();
    // It got an explicit rejection, not silence.
    expect(inbox.find((f) => f.type === 'error')).toBeDefined();
    // No slot was taken, and the device never appears online.
    expect(h.control.activeSessionCount()).toBe(0);
    const list = h.presence.enumerate(h.registry.list());
    expect(list.find((d) => d.deviceId === 'kitchen')?.online).toBe(false);
    ws.close();
    await tick();
  });

  it('F2-d2: a queued device that disconnects is NOT minted a session on drain', async () => {
    // Force the cap to 1 so the second device genuinely queues (the drain
    // re-validation is what is under test).
    const h1 = await startHarness({ maxConcurrentSessions: 1 });
    try {
      const k = await mintDeviceJwt(h1, 'kitchen', 'kitchen');
      const b = await mintDeviceJwt(h1, 'bedroom', 'bedroom');
      const dk = await connectDevice(h1, 'kitchen', k);
      const db = await connectDevice(h1, 'bedroom', b);
      await tick();

      // kitchen wakes (admitted), bedroom wakes (queued behind kitchen at cap 1).
      dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
      await tick();
      db.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
      await tick();
      expect(dk.inbox.find((f) => f.type === 'session_start')).toBeDefined();
      expect(db.inbox.find((f) => f.type === 'session_start')).toBeUndefined();
      expect(h1.control.queueDepth()).toBe(1);

      // bedroom's socket drops WHILE queued.
      db.ws.close();
      await tick();

      // kitchen ends its session → drain. bedroom is gone → no session_start,
      // and no slot is leaked (active count returns to 0, queue can run again).
      dk.ws.send(encodeDeviceControl({ type: 'session_end', reason: 'agent-finished' } as never));
      await tick();
      expect(db.inbox.find((f) => f.type === 'session_start')).toBeUndefined();
      expect(h1.control.activeSessionCount()).toBe(0);

      // Prove the slot is genuinely free: a fresh wake on kitchen is admitted.
      dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
      await tick();
      const starts = dk.inbox.filter((f) => f.type === 'session_start');
      expect(starts.length).toBe(2);
    } finally {
      await h1.close();
    }
  });

  it('F2-d3: a conversational ring (call) reaches a physical device and opens a conversational session', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();

    // The call path runs the cascade with conversational:true.
    resolveSpeakers(
      {
        chatId: 'thread_speakers',
        message: 'picking up?',
        deviceId: 'kitchen',
        now: Date.now(),
        conversational: true,
      },
      h.cascade,
    );
    await tick();
    const ring = dk.inbox.find((f) => f.type === 'ring');
    expect(ring).toMatchObject({ type: 'ring', conversational: true });

    // On accept the session_start is conversational (stays open for a reply).
    dk.ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();
    const start = dk.inbox.find((f) => f.type === 'session_start') as
      | { conversational: boolean; voiceToken: string }
      | undefined;
    expect(start).toBeDefined();
    expect(start!.conversational).toBe(true);
    expect(start!.voiceToken.length).toBeGreaterThan(10);
  });

  it('a revoked device is rejected at upgrade even with a validly-signed JWT (401)', async () => {
    const jwt = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    h.registry.revoke('kitchen');
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/device/control`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(String(err.message)).toMatch(/401/);
  });

  it('presence.send() reaches a connected device through its live bound socket', async () => {
    const jwt = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const { inbox } = await connectDevice(h, 'kitchen', jwt);
    await tick();
    const delivered = h.presence.send('kitchen', { type: 'led', state: 'idle' });
    await tick();
    expect(delivered).toBe(true);
    expect(inbox.find((f) => f.type === 'led')).toEqual({ type: 'led', state: 'idle' });
  });

  it('a second wake_detected for an already-active device is rejected, not duplicated', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    const starts = dk.inbox.filter((f) => f.type === 'session_start');
    expect(starts).toHaveLength(1); // the duplicate was rejected, not queued or re-started
    expect(h.control.activeSessionCount()).toBe(1);
  });

  it('ring_accepted BEFORE hello is rejected — no session, no presence', async () => {
    const jwt = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/device/control`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const inbox: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer) => inbox.push(JSON.parse(data.toString('utf8'))));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();
    expect(inbox.find((f) => f.type === 'session_start')).toBeUndefined();
    expect(inbox.find((f) => f.type === 'error')).toBeDefined();
    expect(h.control.activeSessionCount()).toBe(0);
    ws.close();
    await tick();
  });

  it('ring_accepted with no pending ring after hello logs and no-ops', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    // No ring was ever sent to this device — accept has nothing to act on.
    dk.ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();
    expect(dk.inbox.find((f) => f.type === 'session_start')).toBeUndefined();
    expect(h.control.activeSessionCount()).toBe(0);
  });

  it('ring_dismissed clears the pending ring; a later ring_accepted has nothing to accept', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    resolveSpeakers(
      { chatId: 'c1', message: 'dismiss me', deviceId: 'kitchen', now: Date.now() },
      h.cascade,
    );
    await tick();
    expect(dk.inbox.find((f) => f.type === 'ring')).toBeDefined();
    dk.ws.send(encodeDeviceControl({ type: 'ring_dismissed' } as never));
    await tick();
    // The pending ring was cleared, so accepting afterwards is a no-op.
    dk.ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();
    expect(dk.inbox.find((f) => f.type === 'session_start')).toBeUndefined();
  });

  it('session_end on the active device drains a queued-but-still-connected device (released is defined)', async () => {
    const h1 = await startHarness({ maxConcurrentSessions: 1 });
    try {
      const k = await mintDeviceJwt(h1, 'kitchen', 'kitchen');
      const b = await mintDeviceJwt(h1, 'bedroom', 'bedroom');
      const dk = await connectDevice(h1, 'kitchen', k);
      const db = await connectDevice(h1, 'bedroom', b);
      await tick();

      dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
      await tick();
      db.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never)); // queues behind kitchen
      await tick();
      expect(h1.control.queueDepth()).toBe(1);

      // bedroom stays connected this time (unlike F2-d2) — the drain must
      // admit it and send its session_start.
      dk.ws.send(encodeDeviceControl({ type: 'session_end', reason: 'agent-finished' } as never));
      await tick();
      expect(db.inbox.find((f) => f.type === 'session_start')).toBeDefined();
      expect(h1.control.activeSessionCount()).toBe(1);
      expect(h1.control.queueDepth()).toBe(0);
    } finally {
      await h1.close();
    }
  });

  it('ring() returns false for a device with no live connection', async () => {
    expect(h.control.ring('nope', { type: 'ring', chatId: 'c1', conversational: false })).toBe(
      false,
    );
  });

  it('ring() with no message omits it from the pending ring (still opens on accept)', async () => {
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const dk = await connectDevice(h, 'kitchen', k);
    await tick();
    const delivered = h.control.ring('kitchen', {
      type: 'ring',
      chatId: 'c1',
      conversational: true,
    });
    expect(delivered).toBe(true);
    await tick();
    expect(dk.inbox.find((f) => f.type === 'ring')).toEqual({
      type: 'ring',
      chatId: 'c1',
      conversational: true,
    });
    dk.ws.send(encodeDeviceControl({ type: 'ring_accepted' } as never));
    await tick();
    expect(dk.inbox.find((f) => f.type === 'session_start')).toBeDefined();
  });

  it('F2-d4: two devices hold sessions concurrently up to the cap', async () => {
    // Default harness cap is 3 (local-whisper dev value).
    const k = await mintDeviceJwt(h, 'kitchen', 'kitchen');
    const b = await mintDeviceJwt(h, 'bedroom', 'bedroom');
    const dk = await connectDevice(h, 'kitchen', k);
    const db = await connectDevice(h, 'bedroom', b);
    await tick();

    dk.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();
    db.ws.send(encodeDeviceControl({ type: 'wake_detected' } as never));
    await tick();

    // Both devices get their OWN session_start — neither is queued.
    expect(dk.inbox.find((f) => f.type === 'session_start')).toBeDefined();
    expect(db.inbox.find((f) => f.type === 'session_start')).toBeDefined();
    expect(h.control.activeSessionCount()).toBe(2);
    expect(h.control.queueDepth()).toBe(0);
  });
});

/**
 * Unit-level tests for `DeviceControlServer` against a minimal fake socket
 * (an EventEmitter-shaped stand-in for `ws`'s `WebSocket`). A few branches —
 * an unexpected binary frame, a malformed control frame, an internal handler
 * throw, and a socket whose close() itself throws during teardown — are hard
 * or impossible to provoke through a real `ws` connection (the real library's
 * close() never throws, and every real inbound frame we can construct is
 * either valid JSON or gets rejected before reaching the frame handler
 * anyway from JS-land). Driving `handleConnection` directly with a fake
 * socket lets us hit them deterministically without weakening the source.
 */
describe('DeviceControlServer (fake socket, hard-to-reach branches)', () => {
  class FakeWs {
    private readonly handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    readonly sent: unknown[] = [];
    closeCalls = 0;
    closeShouldThrow = false;

    on(event: string, cb: (...args: unknown[]) => void): void {
      (this.handlers[event] ??= []).push(cb);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers[event] ?? []) cb(...args);
    }
    send(data: unknown): void {
      this.sent.push(data);
    }
    close(): void {
      this.closeCalls += 1;
      if (this.closeShouldThrow) throw new Error('close boom');
    }
  }

  function makeServer(overrides: { registryGet?: (id: string) => unknown } = {}) {
    const registry = {
      get: overrides.registryGet ?? (() => undefined),
    } as unknown as DeviceRegistry;
    const presence = {
      attach: () => {},
      setMuted: () => {},
      touch: () => {},
      detach: () => {},
    } as unknown as PresenceRegistry;
    const control = new DeviceControlServer({
      registry,
      presence,
      accountPublicKey: 'pub',
      accountId: 'acct',
      internalToken: SECRET,
      voiceDeviceChatId: 'thread_speakers',
      isPhoneCallActive: () => false,
      maxConcurrentSessions: 3,
      logger,
    });
    return control;
  }

  function helloBuffer(deviceId: string): Buffer {
    return Buffer.from(
      encodeDeviceControl({
        type: 'hello',
        deviceId,
        fwVersion: '1.0.0',
        muted: false,
      } as never),
      'utf8',
    );
  }

  it('ignores an unexpected binary frame (JSON-only control plane)', () => {
    const control = makeServer();
    const ws = new FakeWs();
    control.handleConnection(ws as unknown as WebSocket, 'kitchen');
    expect(() => ws.emit('message', Buffer.from([1, 2, 3]), true)).not.toThrow();
    // Nothing was sent back — a binary frame is silently dropped, not errored.
    expect(ws.sent).toHaveLength(0);
  });

  it('replies with a malformed-frame error when the JSON does not decode', () => {
    const control = makeServer();
    const ws = new FakeWs();
    control.handleConnection(ws as unknown as WebSocket, 'kitchen');
    ws.emit('message', Buffer.from('not valid json{{{', 'utf8'), false);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      type: 'error',
      message: 'malformed control frame',
    });
  });

  it('catches an internal error thrown while handling a well-formed frame', () => {
    const control = makeServer({
      registryGet: () => {
        throw new Error('registry boom');
      },
    });
    const ws = new FakeWs();
    control.handleConnection(ws as unknown as WebSocket, 'kitchen');
    // `hello` is well-formed and decodes fine, but the handler's
    // `registry.get()` call throws — this must be caught and logged, not
    // crash the connection.
    expect(() => ws.emit('message', helloBuffer('kitchen'), false)).not.toThrow();
  });

  it('rejects a hello whose deviceId does not match the authenticated socket, and closes it', () => {
    const control = makeServer();
    const ws = new FakeWs();
    control.handleConnection(ws as unknown as WebSocket, 'kitchen');
    ws.emit('message', helloBuffer('impostor'), false);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      type: 'error',
      message: 'hello deviceId mismatch',
    });
    expect(ws.closeCalls).toBe(1);
  });

  it('logs a socket-level error event without throwing', () => {
    const control = makeServer();
    const ws = new FakeWs();
    control.handleConnection(ws as unknown as WebSocket, 'kitchen');
    expect(() => ws.emit('error', new Error('socket boom'))).not.toThrow();
  });

  it('closeAll() swallows a socket whose close() throws during teardown', () => {
    const control = makeServer();
    const ws = new FakeWs();
    ws.closeShouldThrow = true;
    control.handleConnection(ws as unknown as WebSocket, 'kitchen');
    ws.emit('message', helloBuffer('kitchen'), false);
    expect(() => control.closeAll()).not.toThrow();
    expect(ws.closeCalls).toBe(1);
  });
});
