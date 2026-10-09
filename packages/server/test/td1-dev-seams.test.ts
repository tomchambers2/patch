// TD1 dev/test seams — the env-gated dev affordances that make the encoded
// special-thread (D1) e2e tests exercisable against the dev stack, where
// there is no physical voice device to stream real audio.
//
// What this asserts:
//   - PATCH_SPEAKERS_MOCK=1 records speakers-channel TTS notifies, and the
//     diag route injects a voice-device transcript that a Speakers reply
//     auto-routes back to as TTS on the originating device.
//       → exercises D1-6 (Speakers reply → TTS to originating device).
//   - HARD PRODUCTION GATE: with NODE_ENV=production the mock backend is NOT
//     built and /internal/diag/* is NOT mounted, regardless of the flag.
//
// The server is built via the SAME buildAll() the dev boot uses, reading the
// SAME env flags the dev boot sets — so this is a faithful proxy for
// the live stack. An InProcessDaemonLink stands in for the host: it captures
// what the server forwards (chat.input) and lets us emit the assistant reply
// the real mock host would produce, triggering the server's reply-routing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChatMessageEvent, ChatInputEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const INTERNAL_TOKEN = 'dev-internal-token-0123456789';

interface Stack {
  app: FastifyInstance;
  link: InProcessDaemonLink;
  dir: string;
}

const ENV_KEYS = ['PATCH_SPEAKERS_MOCK', 'NODE_ENV'] as const;

let savedEnv: Record<string, string | undefined> = {};

function setDevSeamEnv(): void {
  process.env['PATCH_SPEAKERS_MOCK'] = '1';
  process.env['NODE_ENV'] = 'development';
}

async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'td1-seams-'));
  const registry = Registry.load(dir);
  registry.bootstrapAccount();
  const link = new InProcessDaemonLink();
  const app = await buildAll({
    dataDir: dir,
    registry,
    daemonLink: link,
    internalToken: INTERNAL_TOKEN,
    logger: false,
    jobsWatch: false,
    pushBackend: { send: async () => ({ delivered: 0, failed: [], permanentlyRejected: [] }) },
  });
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  return { app: app.app, link, dir };
}

describe('TD1 dev/test seams (gated buildAll wiring + /internal/diag/*)', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    setDevSeamEnv();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('D1-6: a kitchen voice-device turn enters the Speakers thread and the reply auto-routes TTS back to kitchen', async () => {
    const stack = await startStack();
    try {
      // Inject a voice-device transcript via the gated diag route (stands in for
      // a physical HA Voice PE unit streaming audio).
      const inject = await stack.app.inject({
        method: 'POST',
        url: '/internal/diag/voice-device/transcript',
        headers: { 'x-patch-internal-token': INTERNAL_TOKEN },
        payload: { deviceId: 'kitchen', transcript: 'turn off the lights' },
      });
      expect(inject.statusCode).toBe(202);
      const forwarded = stack.link.sent.find((s) => s.event.type === 'chat.input')
        ?.event as ChatInputEvent;
      expect(forwarded).toBeDefined();
      expect(forwarded.chatId).toBe('thread_speakers');
      expect(forwarded.source).toEqual({ kind: 'voice-device', deviceId: 'kitchen' });

      // The Speakers agent's direct reply auto-routes as a speakers-channel
      // notify pinned to the originating deviceId — recorded by the seam.
      const reply: ChatMessageEvent = {
        type: 'chat.message',
        chatId: 'thread_speakers',
        role: 'assistant',
        content: 'kitchen lights off',
        seq: 1,
      };
      stack.link.emit(reply);
      await new Promise((r) => setTimeout(r, 20));

      const sent = await stack.app.inject({
        method: 'GET',
        url: '/internal/diag/speakers/sent',
        headers: { 'x-patch-internal-token': INTERNAL_TOKEN },
      });
      expect(sent.statusCode).toBe(200);
      const records = sent.json().sent as { deviceId?: string; message: string }[];
      expect(records).toHaveLength(1);
      expect(records[0]!.deviceId).toBe('kitchen');
      expect(records[0]!.message).toBe('kitchen lights off');
    } finally {
      await stack.app.close();
      rmSync(stack.dir, { recursive: true, force: true });
    }
  });

  it('diag routes reject a missing/wrong internal token', async () => {
    const stack = await startStack();
    try {
      const noTok = await stack.app.inject({ method: 'GET', url: '/internal/diag/speakers/sent' });
      expect(noTok.statusCode).toBe(401);
      const badTok = await stack.app.inject({
        method: 'GET',
        url: '/internal/diag/speakers/sent',
        headers: { 'x-patch-internal-token': 'nope' },
      });
      expect(badTok.statusCode).toBe(401);
    } finally {
      await stack.app.close();
      rmSync(stack.dir, { recursive: true, force: true });
    }
  });

  it('PRODUCTION GATE: NODE_ENV=production disables the mock backend and diag routes even with the flag set', async () => {
    process.env['NODE_ENV'] = 'production';
    // The point under test is that the MOCK + diag seams stay off even
    // though PATCH_SPEAKERS_MOCK is still set.
    const stack = await startStack();
    try {
      // Diag routes are not mounted at all → 404.
      const diag = await stack.app.inject({
        method: 'GET',
        url: '/internal/diag/speakers/sent',
        headers: { 'x-patch-internal-token': INTERNAL_TOKEN },
      });
      expect(diag.statusCode).toBe(404);
    } finally {
      await stack.app.close();
      rmSync(stack.dir, { recursive: true, force: true });
    }
  });

  // ---- G5 voice diag seams (spec/07) ----

  it('G5-9: /internal/diag/permission-request forwards a patch.diag.inject_permission to the host', async () => {
    const stack = await startStack();
    try {
      const res = await stack.app.inject({
        method: 'POST',
        url: '/internal/diag/permission-request',
        headers: { 'x-patch-internal-token': INTERNAL_TOKEN },
        payload: { chatId: 'thread_manager', tool: 'Bash', description: 'Run rm — approve?' },
      });
      expect(res.statusCode).toBe(202);
      const fwd = stack.link.sent.find((s) => s.event.type === 'patch.diag.inject_permission');
      expect(fwd).toBeDefined();
      expect(fwd!.event).toMatchObject({
        type: 'patch.diag.inject_permission',
        chatId: 'thread_manager',
        tool: 'Bash',
        description: 'Run rm — approve?',
      });
    } finally {
      await stack.app.close();
      rmSync(stack.dir, { recursive: true, force: true });
    }
  });

  it('G5-8/9/11: /internal/diag/voice-inject forwards a patch.diag.voice_inject carrying the surfaceId + text', async () => {
    const stack = await startStack();
    try {
      const res = await stack.app.inject({
        method: 'POST',
        url: '/internal/diag/voice-inject',
        headers: { 'x-patch-internal-token': INTERNAL_TOKEN },
        payload: { surfaceId: 'web-dev-1', text: 'route this utterance' },
      });
      expect(res.statusCode).toBe(202);
      const fwd = stack.link.sent.find((s) => s.event.type === 'patch.diag.voice_inject');
      expect(fwd).toBeDefined();
      expect(fwd!.event).toMatchObject({
        type: 'patch.diag.voice_inject',
        surfaceId: 'web-dev-1',
        text: 'route this utterance',
      });
    } finally {
      await stack.app.close();
      rmSync(stack.dir, { recursive: true, force: true });
    }
  });

  it('diag seams require the internal token (401 without it)', async () => {
    const stack = await startStack();
    try {
      for (const url of [
        '/internal/diag/permission-request',
        '/internal/diag/voice-inject',
        '/internal/diag/incoming-call',
      ]) {
        const res = await stack.app.inject({ method: 'POST', url, payload: {} });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await stack.app.close();
      rmSync(stack.dir, { recursive: true, force: true });
    }
  });
});
