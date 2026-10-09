// Cross-chat tools (group 9 task A): UDS endpoint behaviour for every
// patch_* tool. Uses Fastify's `.inject()` for direct request injection —
// no socket plumbing — and the mock SDK + MemoryJobsStore.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { RateLimiter } from '../src/rate-limit.js';

// The control socket is gated as a whole (spec/02 § Control IPC): every
// route but /healthz needs the host's local key.
const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-tools-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-tools-folder-'));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'x',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
  const upstream: WireEvent[] = [];
  return { daemon, sdk, jobs, folder, home, events, upstream };
}

describe('UDS internal endpoints — patch_peek', () => {
  it('returns full chat_state on hit', async () => {
    const { daemon, sdk, folder, jobs } = setup();
    sdk.enqueue([{ type: 'assistant', content: 'hello world', sessionId: 'S' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}`,
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // spec/06: { chat_state, events, truncated }
      expect(body.chat_state.chatId).toBe(chatId);
      expect(body.chat_state.activity).toBe('idle');
      expect(body.chat_state.lastMessages).toHaveLength(1);
      expect(body.chat_state.lastMessage).toBe('hello world');
      expect(body.chat_state.status).toBe('active');
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.truncated).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown chatId', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/nope',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_send_to', () => {
  it('queues input + emits patch.send_to wire event when callerChatId given', async () => {
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
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'go', callerChatId: 'manager' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, queued: true });
      expect(upstream.find((e) => e.type === 'patch.send_to')).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('rejects bad input via zod 400', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId: '', message: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    } finally {
      await app.close();
    }
  });

  it('returns 404 when target chat is missing', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId: 'no-such', message: 'hi', callerChatId: 'm' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  it('two send_to with same localId only deliver once (group 10 BLOCKER B2)', async () => {
    const { daemon, jobs, folder, sdk } = setup();
    sdk.enqueue([{ type: 'assistant', content: 'ack', sessionId: 'S1' }]);
    const chatId = await daemon.spawnChat({ folder });
    await new Promise((r) => setTimeout(r, 20));
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'go', localId: 'fixed-id' },
      });
      expect(r1.statusCode).toBe(200);
      // Wait for the run to actually finish so seenLocalIds is populated.
      await new Promise((r) => setTimeout(r, 30));
      const r2 = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'go', localId: 'fixed-id' },
      });
      expect(r2.statusCode).toBe(200);
      // Host's sendInput dedupes silently — one delivered, no error.
    } finally {
      await app.close();
    }
  });

  it('rate-limits the 61st call from the same caller', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    let t = 0;
    const limiter = new RateLimiter({ windowMs: 60_000, max: 60, now: () => t });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      for (let i = 0; i < 60; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/internal/send-to',
          headers: AUTH,
          payload: { chatId, message: `m${i}`, callerChatId: 'caller-1' },
        });
        expect(res.statusCode).toBe(200);
      }
      const over = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'overflow', callerChatId: 'caller-1' },
      });
      expect(over.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_spawn', () => {
  it('spawns + returns chatId; folder_not_found yields 404', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'caller' },
      });
      expect(ok.statusCode).toBe(200);
      expect(typeof ok.json().chatId).toBe('string');

      const bad = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder: '/no/such-99', callerChatId: 'caller' },
      });
      expect(bad.statusCode).toBe(404);
      expect(bad.json().error).toBe('folder_not_found');
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_history', () => {
  it('returns empty events for chat with no claudeSessionId', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}`,
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
    } finally {
      await app.close();
    }
  });

  it('rejects chatId not found with 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/missing',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('clamps limit > 200 to the hard cap (200) instead of rejecting', async () => {
    // spec/06 patch_history: the 200 ceiling is a CLAMP, not a 400 — a caller
    // asking for limit:5000 gets at most the newest 200 events (mirrors the
    // job-runs cap). C2-6.
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}?limit=5000`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: unknown[] };
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeLessThanOrEqual(200);
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_list_chats', () => {
  it('default omits archived; archived=only returns archived', async () => {
    const { daemon, jobs, folder } = setup();
    const a = await daemon.spawnChat({ folder });
    const b = await daemon.spawnChat({ folder });
    await daemon.setArchived(b, true);
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const def = await app.inject({
        method: 'GET',
        url: '/internal/chats',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(def.json().chats.map((c: { chatId: string }) => c.chatId)).toEqual([a]);

      const only = await app.inject({
        method: 'GET',
        url: '/internal/chats?archived=only',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(only.json().chats.map((c: { chatId: string }) => c.chatId)).toEqual([b]);

      const inc = await app.inject({
        method: 'GET',
        url: '/internal/chats?archived=include',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(inc.json().chats).toHaveLength(2);

      const bad = await app.inject({
        method: 'GET',
        url: '/internal/chats?archived=true',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_list_devices', () => {
  it('returns registered devices with presence when listDevices is wired', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      listDevices: () => [
        { deviceId: 'kitchen', name: 'Kitchen', online: true, muted: false, lastUsedAt: 42 },
        { deviceId: 'bedroom', name: 'Bedroom', online: false, muted: true, lastUsedAt: 0 },
      ],
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/devices',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        devices: { deviceId: string; online: boolean; muted: boolean }[];
      };
      expect(body.devices).toHaveLength(2);
      expect(body.devices[0]).toMatchObject({ deviceId: 'kitchen', online: true, muted: false });
      expect(body.devices[1]).toMatchObject({ deviceId: 'bedroom', online: false, muted: true });
    } finally {
      await app.close();
    }
  });

  it('503s when listDevices is not configured (NO FALLBACK)', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/devices',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('devices not configured');
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_stop', () => {
  it('stops a known chat; 404 on unknown', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: `/internal/stop/${chatId}`,
        headers: AUTH,
        payload: { callerChatId: 'caller' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });

      const miss = await app.inject({
        method: 'POST',
        url: '/internal/stop/no-such',
        headers: AUTH,
        payload: { callerChatId: 'caller' },
      });
      expect(miss.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('UDS internal endpoints — patch_job_*', () => {
  let app: Awaited<ReturnType<typeof buildControl>>;
  let jobs: MemoryJobsStore;

  beforeEach(async () => {
    const s = setup();
    jobs = s.jobs;
    app = await buildControl({ localKey: LOCAL_KEY, daemon: s.daemon, jobs });
  });

  it('list/create/update/delete round-trip', async () => {
    const list0 = await app.inject({
      method: 'GET',
      url: '/internal/jobs',
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
    });
    expect(list0.json()).toEqual({ jobs: [] });

    const created = await app.inject({
      method: 'POST',
      url: '/internal/jobs',
      headers: AUTH,
      payload: {
        trigger: { type: 'cron', expression: '0 9 * * 1-5' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/work/bus', skill: 'bus-watch' },
        name: 'morning bus',
      },
    });
    expect(created.statusCode).toBe(200);
    const { jobId } = created.json();

    const updated = await app.inject({
      method: 'PATCH',
      url: `/internal/jobs/${jobId}`,
      headers: AUTH,
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().job.enabled).toBe(false);

    const enabled = await app.inject({
      method: 'POST',
      url: `/internal/jobs/${jobId}/enable`,
      headers: AUTH,
    });
    expect(enabled.json().job.enabled).toBe(true);

    const disabled = await app.inject({
      method: 'POST',
      url: `/internal/jobs/${jobId}/disable`,
      headers: AUTH,
    });
    expect(disabled.json().job.enabled).toBe(false);

    const del = await app.inject({
      method: 'DELETE',
      url: `/internal/jobs/${jobId}`,
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
    });
    expect(del.statusCode).toBe(200);

    const del2 = await app.inject({
      method: 'DELETE',
      url: `/internal/jobs/${jobId}`,
      headers: { authorization: `Bearer ${LOCAL_KEY}` },
    });
    expect(del2.statusCode).toBe(404);

    await app.close();
  });

  it('rejects bad job payload via zod 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs',
      headers: AUTH,
      payload: { trigger: { type: 'unknown' }, action: { type: 'nope' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
