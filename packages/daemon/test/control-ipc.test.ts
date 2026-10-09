// C1: local control IPC (spec/02-daemon.md "Control IPC" table).
//
// Loopback UDS HTTP. Spec-named endpoints: GET /list, POST /spawn-chat,
// POST /stop-chat, POST /stop (shut host down). Auth-gated by the local
// key (same host/user/loopback — the key fences the UDS).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, ChatNotFoundError } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore, JobNotFoundError, JobsLinkOfflineError } from '../src/jobs-interface.js';
import type { AsyncJobsInterface, Job } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { RateLimiter } from '../src/rate-limit.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { ChatStateMap } from '../src/chatState.js';

/**
 * A minimal Daemon-shaped test double for exercising control.ts's own
 * catch-block error-mapping branches that the REAL Host never takes (e.g.
 * `stopChat` never throws `ChatNotFoundError` today — it's a documented no-op
 * on an idle/unknown chat — so a non-`ChatNotFoundError` throw or a
 * `ChatNotFoundError` throw from `stopChat` itself can only be driven by a
 * fake. `Daemon` has private fields, so this is a structural cast, not a
 * subclass — it only ever backs ONE narrow control.ts branch per test.
 */
function fakeDaemon(overrides: Record<string, unknown>): Daemon {
  return { chatState: new ChatStateMap(), ...overrides } as unknown as Daemon;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j_fixed',
    name: 'fixture job',
    enabled: true,
    trigger: { type: 'cron', expression: '0 0 * * *' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * A fully-controllable `AsyncJobsInterface` test double: every method either
 * resolves a canned value or rejects with a configured error, so every
 * catch-block branch in control.ts's job routes (JobNotFoundError — both the
 * `instanceof` and the RemoteJobsStore `.name`-only shape — JobsLinkOfflineError,
 * the invalid_input name-check, and a plain rethrow) can be driven directly
 * without standing up the real cross-daemon-link RemoteJobsStore RPC.
 */
function configurableJobsStore(behavior: {
  list?: () => Job[] | Promise<Job[]>;
  create?: () => Job | Promise<Job>;
  patch?: () => Job | Promise<Job>;
  delete?: () => boolean | Promise<boolean>;
  enable?: () => Job | Promise<Job>;
  disable?: () => Job | Promise<Job>;
  runs?: (id: string, limit?: number) => unknown[] | Promise<unknown[]>;
  webhooks?: (id: string, limit?: number) => unknown[] | Promise<unknown[]>;
}): AsyncJobsInterface {
  return {
    list: behavior.list ?? ((): Job[] => []),
    get: (): Job | null => null,
    create: behavior.create ?? ((): Job => makeJob()),
    patch: behavior.patch ?? ((): Job => makeJob()),
    delete: behavior.delete ?? ((): boolean => true),
    enable: behavior.enable ?? ((): Job => makeJob()),
    disable: behavior.disable ?? ((): Job => makeJob()),
    ...(behavior.runs !== undefined ? { runs: behavior.runs } : {}),
    ...(behavior.webhooks !== undefined ? { webhooks: behavior.webhooks } : {}),
  };
}

/** Mimics RemoteJobsStore.handleResponse's error shape: name-only, not instanceof. */
function nameOnlyError(name: string, message = 'x'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

const silent = pino({ level: 'silent' });
const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-ctl-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-folder-')));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
  return { daemon, sdk, jobs, folder, home, events };
}

describe('C1 Control IPC: GET /list', () => {
  it('returns active chats (auth required)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'GET', url: '/list' });
      expect(unauth.statusCode).toBe(401);

      const res = await app.inject({ method: 'GET', url: '/list', headers: AUTH });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { chats: { chatId: string }[] };
      expect(body.chats.map((c) => c.chatId)).toContain(chatId);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /spawn-chat', () => {
  it('spawns a chat in a valid folder', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: { folder },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { chatId: string };
      expect(daemon.chatState.get(body.chatId)?.folder).toBe(folder);
    } finally {
      await app.close();
    }
  });

  it('errors LOUDLY (400 folder_not_found) for a non-existent folder', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: { folder: '/no/such/folder-xyz' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('folder_not_found');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /chats/:id/stop (no body)', () => {
  it('stops a chat with an empty body and no content-type (CLI no-body POST)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      // Mirror the CLI's fixed no-body POST: no body, no content-type header.
      const res = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/stop`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /chats/:id/archive (over UDS)', () => {
  it('archives and unarchives a chat over the local UDS transport', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/archive`,
        payload: { archived: true },
      });
      expect(unauth.statusCode).toBe(401);

      const arch = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/archive`,
        headers: AUTH,
        payload: { archived: true },
      });
      expect(arch.statusCode).toBe(200);
      expect(arch.json().ok).toBe(true);
      expect(daemon.chatState.get(chatId)?.status).toBe('archived');

      const unarch = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/archive`,
        headers: AUTH,
        payload: { archived: false },
      });
      expect(unarch.statusCode).toBe(200);
      expect(daemon.chatState.get(chatId)?.status).toBe('active');
    } finally {
      await app.close();
    }
  });

  it('404s archiving an unknown chat', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/chats/never-heard-of-it/archive',
        headers: AUTH,
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/jobs/:id/disable (no body)', () => {
  it('disables a job with an empty body and no content-type', async () => {
    const { daemon, jobs } = setup();
    const job = jobs.create({
      name: 'j',
      trigger: { type: 'cron', expression: '0 0 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      enabled: true,
    });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/internal/jobs/${job.id}/disable`,

        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.enabled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /stop-chat', () => {
  it('stops a tracked chat', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/stop-chat',
        headers: AUTH,
        payload: { chatId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /clean (patch host clean)', () => {
  it('removes lost chats (session id present, transcript gone) and keeps the rest', async () => {
    const { daemon, jobs, folder } = setup();
    // Lost chat: it captured a Claude session id, but no transcript exists on
    // disk for it (random session id under a temp folder), so it can never
    // resume — `clean` should drop it.
    const lost = await daemon.spawnChat({ folder });
    const lostState = daemon.chatState.get(lost);
    expect(lostState).toBeDefined();
    lostState!.claudeSessionId = 'session-that-has-no-transcript-xyz';

    // Fresh chat: no session id yet — NOT lost, must be kept.
    const fresh = await daemon.spawnChat({ folder });

    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'POST', url: '/clean' });
      expect(unauth.statusCode).toBe(401);

      const res = await app.inject({ method: 'POST', url: '/clean', headers: AUTH });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { removed: string[] };
      expect(body.removed).toEqual([lost]);

      // Effect: lost chat gone from state, fresh chat retained.
      expect(daemon.chatState.has(lost)).toBe(false);
      expect(daemon.chatState.has(fresh)).toBe(true);

      // Idempotent: a second clean removes nothing.
      const again = await app.inject({ method: 'POST', url: '/clean', headers: AUTH });
      expect((again.json() as { removed: string[] }).removed).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: link + resume diagnostics (spec/12 ## Observability)', () => {
  it('GET /internal/diag/link reports live link status + offline-buffer size', async () => {
    const { daemon, jobs } = setup();
    let online = false;
    let bufferSize = 0;
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      serverLink: {
        diagnostics: () => ({ online, bufferSize, bufferMaxPerChat: 10_000 }),
        dropLink: () => true,
      },
    });
    try {
      const up = await app.inject({ method: 'GET', url: '/internal/diag/link', headers: AUTH });
      expect(up.statusCode).toBe(200);
      expect(up.json()).toEqual({ online: false, bufferSize: 0, bufferMaxPerChat: 10_000 });
      // Simulate the link going down with buffered events.
      online = false;
      bufferSize = 3;
      const down = await app.inject({ method: 'GET', url: '/internal/diag/link', headers: AUTH });
      expect(down.json()).toEqual({ online: false, bufferSize: 3, bufferMaxPerChat: 10_000 });
    } finally {
      await app.close();
    }
  });

  it('POST /internal/diag/drop-link drops the upstream socket (host stays alive)', async () => {
    const { daemon, jobs } = setup();
    let dropped = false;
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      serverLink: {
        diagnostics: () => ({ online: true, bufferSize: 0, bufferMaxPerChat: 10_000 }),
        dropLink: () => {
          dropped = true;
          return true;
        },
        floodBuffer: () => 0,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/diag/drop-link',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dropped: true });
      expect(dropped).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /internal/diag/flood-buffer pushes N events for a chat and reports the (capped) buffer size', async () => {
    const { daemon, jobs } = setup();
    // Real ServerLink with a small cap so we observe the bound + drop on the route.
    const warnings: unknown[] = [];
    const { createServerLink } = await import('../src/serverLink.js');
    const { default: pino } = await import('pino');
    const capturing = pino({ level: 'warn' }, {
      write: (s: string) => warnings.push(JSON.parse(s)),
    } as never);
    const link = createServerLink({
      url: 'ws://127.0.0.1:1/ws',
      daemonKey: 'k',
      clientVersion: '0.0.0-test',
      logger: capturing,
      bufferMaxPerChat: 100,
    });
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      serverLink: {
        diagnostics: () => link.diagnostics(),
        dropLink: () => link.dropLink(),
        floodBuffer: (chatId, count) => link.floodBuffer(chatId, count),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/diag/flood-buffer',
        headers: AUTH,
        payload: { chatId: 'cap-chat', count: 400 },
      });
      expect(res.statusCode).toBe(200);
      // Bounded at the cap, not 400.
      expect(res.json()).toEqual({ bufferSize: 100 });
      // Diagnostics readout agrees.
      const diag = await app.inject({ method: 'GET', url: '/internal/diag/link', headers: AUTH });
      expect(diag.json().bufferSize).toBe(100);
      // A drop warning fired.
      const dropWarn = warnings.find((w) =>
        String((w as { msg?: string }).msg).includes('dropped oldest'),
      );
      expect(dropWarn).toBeDefined();
      // Bad body rejected.
      const bad = await app.inject({
        method: 'POST',
        url: '/internal/diag/flood-buffer',
        headers: AUTH,
        payload: { chatId: '', count: 0 },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
      await link.close();
    }
  });

  it('diag link routes 503 when no server link is wired', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/internal/diag/link', headers: AUTH })).statusCode,
      ).toBe(503);
      expect(
        (await app.inject({ method: 'POST', url: '/internal/diag/drop-link', headers: AUTH }))
          .statusCode,
      ).toBe(503);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/internal/diag/flood-buffer',
            headers: AUTH,
            payload: { chatId: 'c', count: 1 },
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('GET /internal/diag/resume/:id surfaces the SDK resume arg of the last query', async () => {
    const { daemon, sdk, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      // No query yet → 404.
      const before = await app.inject({
        method: 'GET',
        url: `/internal/diag/resume/${chatId}`,
        headers: AUTH,
      });
      expect(before.statusCode).toBe(404);

      // First turn: fresh session (resume is null), captures a sessionId.
      sdk.enqueue([
        { type: 'assistant', content: 'first' },
        { type: 'result', sessionId: 'sess-resume-diag' },
      ]);
      await daemon.sendInput({ chatId, message: 'one', localId: 'r-1' });
      const fresh = await app.inject({
        method: 'GET',
        url: `/internal/diag/resume/${chatId}`,
        headers: AUTH,
      });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().resumeSessionId).toBeNull();

      // Second turn resumes the captured session id — observable here.
      sdk.enqueue([
        { type: 'assistant', content: 'second' },
        { type: 'result', sessionId: 'sess-resume-diag' },
      ]);
      await daemon.sendInput({ chatId, message: 'two', localId: 'r-2' });
      const resumed = await app.inject({
        method: 'GET',
        url: `/internal/diag/resume/${chatId}`,
        headers: AUTH,
      });
      expect(resumed.json().resumeSessionId).toBe('sess-resume-diag');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /stop', () => {
  it('invokes the shutdown hook', async () => {
    const { daemon, jobs } = setup();
    let shutdownCalled = false;
    const app = await buildControl({
      daemon,
      jobs,
      localKey: LOCAL_KEY,
      onShutdown: () => {
        shutdownCalled = true;
      },
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/stop', headers: AUTH });
      expect(res.statusCode).toBe(200);
      // onShutdown fires on the next tick (after the reply flushes).
      await new Promise((r) => setImmediate(r));
      expect(shutdownCalled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('503s when no shutdown hook is wired', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({ method: 'POST', url: '/stop', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('jobs runs/webhooks: --limit validation (G1-d2/d3 defense-in-depth)', () => {
  // A malformed/zero/negative limit must be rejected at the host boundary
  // with a clean 400 + actionable message — never forwarded downstream as NaN
  // where it previously surfaced as an unhandled 500. Validated BEFORE the
  // store-capability check so the contract holds for any backing store.
  for (const seg of ['runs', 'webhooks'] as const) {
    for (const bad of ['abc', '0', '-5'] as const) {
      it(`${seg}: rejects --limit=${bad} with 400 invalid_input`, async () => {
        const { daemon, jobs } = setup();
        const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
        try {
          const res = await app.inject({
            method: 'GET',
            url: `/internal/jobs/j_x/${seg}?limit=${bad}`,

            headers: AUTH,
          });
          expect(res.statusCode).toBe(400);
          const body = res.json() as { error: string; message: string };
          expect(body.error).toBe('invalid_input');
          expect(body.message).toBe(`--limit must be a positive integer (got ${bad})`);
        } finally {
          await app.close();
        }
      });
    }
  }
});

// TC3 C3-d2/d3/d4: the host control surface error contract.
describe('TC3 control-surface error envelope + rate-limit guidance (/internal/notify)', () => {
  // C3-d4: every 4xx on the control surface shares one {error, message} shape.
  it('C3-d4 zod validation, malformed JSON, and chat_not_found all use {error, message}', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      // (1) zod validation: missing `message`.
      const zodRes = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', callerChatId: 'thread_x' },
      });
      expect(zodRes.statusCode).toBe(400);
      const zodBody = zodRes.json() as Record<string, unknown>;
      expect(Object.keys(zodBody).sort()).toEqual(['error', 'message']);

      // (2) malformed JSON body — fastify's own error, normalized to the envelope.
      const badJson = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '{bad json',
      });
      expect(badJson.statusCode).toBe(400);
      const badJsonBody = badJson.json() as Record<string, unknown>;
      expect(Object.keys(badJsonBody).sort()).toEqual(['error', 'message']);
      expect(badJsonBody['error']).toBe('invalid_json');

      // (3) chat_not_found — unknown callerChatId.
      const notFound = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', message: 'hi', callerChatId: 'nope' },
      });
      expect(notFound.statusCode).toBe(404);
      const notFoundBody = notFound.json() as Record<string, unknown>;
      expect(Object.keys(notFoundBody).sort()).toEqual(['error', 'message']);
      expect(notFoundBody['error']).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  // C3-d3: a rate-limited notify (429) carries Retry-After + X-RateLimit-* and
  // the {error, message} envelope.
  it('C3-d3 a rate-limited 429 includes Retry-After + window headers + envelope', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // max:1 so the SECOND notify trips the limiter deterministically.
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1_000 });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'desktop', message: 'one', callerChatId: chatId },
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'desktop', message: 'two', callerChatId: chatId },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('60');
      expect(limited.headers['x-ratelimit-limit']).toBe('1');
      expect(limited.headers['x-ratelimit-remaining']).toBe('0');
      const body = limited.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
      expect(body['error']).toBe('rate_limited');
      expect(String(body['message'])).toContain('retry after');
    } finally {
      await app.close();
    }
  });

  // C3-d2: an over-length notify message is rejected up-front with a 4xx
  // (a max length is enforced on NotifyBody.message) rather than silently
  // dropped at delivery time.
  it('C3-d2 rejects an over-length message with a 400 up-front', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', message: 'x'.repeat(5000), callerChatId: chatId },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
      expect(String(body['message'])).toContain('4096');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Error-handler + not-found-handler branch coverage.

describe('control.ts error handler', () => {
  it('maps an unsupported media type to the {error,message} envelope (bad_request, statusCode<500)', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: { ...AUTH, 'content-type': 'application/xml' },
        payload: '<x/>',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
      expect(body['error']).toBe('bad_request');
    } finally {
      await app.close();
    }
  });

  it('maps an empty JSON body to invalid_json (FST_ERR_CTP_EMPTY_JSON_BODY)', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_json');
    } finally {
      await app.close();
    }
  });

  it('maps an uncaught 500 (statusCode undefined) to internal_error', async () => {
    // Force the SAME generated chatId twice so the second spawnChat hits
    // Host's `chatId already exists` throw — a generic Error, not
    // FolderNotFoundError, so /spawn-chat's handler rethrows it uncaught and
    // fastify's default error path assigns statusCode 500.
    const home = mkdtempSync(join(tmpdir(), 'patch-ctl-dup-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-dup-folder-')));
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'always-the-same-id',
    });
    const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: { folder },
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: { folder },
      });
      expect(second.statusCode).toBe(500);
      const body = second.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
      expect(body['error']).toBe('internal_error');
    } finally {
      await app.close();
    }
  });

  it('the same chatId collision on /internal/spawn is mapped to sdk_error (500), not folder_not_found', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-ctl-dup2-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-dup2-folder-')));
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'always-the-same-id-2',
    });
    const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'caller' },
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'caller' },
      });
      expect(second.statusCode).toBe(500);
      expect(second.json().error).toBe('sdk_error');
    } finally {
      await app.close();
    }
  });

  it('404s an unknown route with the {error,message} envelope', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/no/such/route', headers: AUTH });
      expect(res.statusCode).toBe(404);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
      expect(body['error']).toBe('not_found');
      expect(String(body['message'])).toContain('GET /no/such/route');

      // Unauthenticated, the SAME unknown route is a 401, not a 404: the gate
      // runs before routing, so a caller with no key cannot map which routes
      // exist on the socket.
      const unauthed = await app.inject({ method: 'GET', url: '/no/such/route' });
      expect(unauthed.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /chats — richer convenience shape.

describe('C1 Control IPC: GET /chats', () => {
  it('401s unauthenticated, 503s with no host, 200s on success', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'GET', url: '/chats' });
      expect(unauth.statusCode).toBe(401);

      const ok = await app.inject({ method: 'GET', url: '/chats', headers: AUTH });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().chats.map((c: { chatId: string }) => c.chatId)).toContain(chatId);
    } finally {
      await app.close();
    }
  });

  it('503s when no host is wired', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await app.inject({ method: 'GET', url: '/chats', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: GET /chats/folders', () => {
  it('401s unauthenticated; 503s with no host', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'GET', url: '/chats/folders' });
      expect(unauth.statusCode).toBe(401);
    } finally {
      await app.close();
    }
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({
        method: 'GET',
        url: '/chats/folders',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });

  it('recents: most-recent folder first, deduped across chats sharing a folder', async () => {
    const { daemon, jobs, folder } = setup();
    const folder2 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-folder2-')));
    const a = await daemon.spawnChat({ folder });
    const b = await daemon.spawnChat({ folder: folder2 });
    const c = await daemon.spawnChat({ folder }); // same folder as `a` — deduped
    daemon.chatState.get(a)!.lastUpdated = 100;
    daemon.chatState.get(b)!.lastUpdated = 300;
    daemon.chatState.get(c)!.lastUpdated = 200;
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/chats/folders',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { recents: string[]; completions: string[] };
      // folder2 (b, lastUpdated 300) most recent, then folder (c/a, 200) — deduped to one entry.
      expect(body.recents).toEqual([folder2, folder]);
      expect(body.completions).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('omits completions when path is absent or empty', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const noPath = await app.inject({ method: 'GET', url: '/chats/folders', headers: AUTH });
      expect(noPath.json().completions).toEqual([]);
      const emptyPath = await app.inject({
        method: 'GET',
        url: '/chats/folders?path=',
        headers: AUTH,
      });
      expect(emptyPath.json().completions).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('completions: matches subdirectories by leaf prefix (non-trailing-slash path)', async () => {
    const { daemon, jobs } = setup();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-parent-')));
    mkdirSync(join(parent, 'project-alpha'));
    mkdirSync(join(parent, 'project-beta'));
    mkdirSync(join(parent, 'other'));
    writeFileSync(join(parent, 'project-file.txt'), 'not a dir');
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/chats/folders?path=${encodeURIComponent(join(parent, 'project'))}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const completions = (res.json() as { completions: string[] }).completions.sort();
      expect(completions).toEqual(
        [join(parent, 'project-alpha'), join(parent, 'project-beta')].sort(),
      );
    } finally {
      await app.close();
    }
  });

  it('completions: a trailing-slash path scans that dir directly (empty leaf, matches all dirs)', async () => {
    const { daemon, jobs } = setup();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-parent2-')));
    mkdirSync(join(parent, 'one'));
    mkdirSync(join(parent, 'two'));
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/chats/folders?path=${encodeURIComponent(parent + '/')}`,
        headers: AUTH,
      });
      const completions = (res.json() as { completions: string[] }).completions.sort();
      expect(completions).toEqual([join(parent, 'one'), join(parent, 'two')].sort());
    } finally {
      await app.close();
    }
  });

  it('completions: a non-existent parent dir yields an empty list (not an error)', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/chats/folders?path=${encodeURIComponent('/no/such/parent-xyz/lea')}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().completions).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: GET /chats/:id', () => {
  it('401s, 503s with no host, 404s unknown, 200s on hit', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'GET', url: `/chats/${chatId}` });
      expect(unauth.statusCode).toBe(401);

      const missing = await app.inject({ method: 'GET', url: '/chats/nope', headers: AUTH });
      expect(missing.statusCode).toBe(404);

      const ok = await app.inject({ method: 'GET', url: `/chats/${chatId}`, headers: AUTH });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().chatId).toBe(chatId);
    } finally {
      await app.close();
    }
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({ method: 'GET', url: '/chats/x', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });

  it('resolves a unique id prefix (spec/17-cli.md: "<id> accepts the full ULID or a unique prefix")', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/chats/${chatId.slice(0, chatId.length - 1)}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().chatId).toBe(chatId);
    } finally {
      await app.close();
    }
  });

  it('404s a prefix matching more than one chat rather than picking one', async () => {
    const { daemon, jobs, folder } = setup();
    const a = await daemon.spawnChat({ folder });
    const b = await daemon.spawnChat({ folder });
    const sharedPrefixLen = [...a].findIndex((c, i) => c !== b[i]);
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/chats/${a.slice(0, sharedPrefixLen)}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /chats/:id/stop — auth/daemon guards', () => {
  it('401s unauthenticated; 503s with no host', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'POST', url: `/chats/${chatId}/stop` });
      expect(unauth.statusCode).toBe(401);
    } finally {
      await app.close();
    }
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({
        method: 'POST',
        url: '/chats/x/stop',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });
});

describe('C1 Control IPC: POST /chats/:id/archive — guards + default body', () => {
  it('503s with no host', async () => {
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({
        method: 'POST',
        url: '/chats/x/archive',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });

  it('defaults to archived:true when no body is sent at all', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/archive`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(daemon.chatState.get(chatId)?.status).toBe('archived');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: GET /list — 503 with no host', () => {
  it('503s', async () => {
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({ method: 'GET', url: '/list', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });
});

describe('C1 Control IPC: POST /spawn-chat — guards + full option spread', () => {
  it('401s unauthenticated; 503s with no host; 400s a zod violation', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'POST', url: '/spawn-chat', payload: { folder } });
      expect(unauth.statusCode).toBe(401);

      const badZod = await app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: {},
      });
      expect(badZod.statusCode).toBe(400);
      expect(badZod.json().error).toBe('bad_request');
    } finally {
      await app.close();
    }
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: { folder },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });

  it('spawns with every optional field set (name/prompt/model/permissionMode)', async () => {
    const { daemon, jobs, folder, sdk } = setup();
    sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 'S' }]);
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: AUTH,
        payload: {
          folder,
          name: 'named-chat',
          prompt: 'hello there',
          model: 'claude-x',
          permissionMode: 'acceptEdits',
        },
      });
      expect(res.statusCode).toBe(200);
      const chatId = res.json().chatId as string;
      const state = daemon.chatState.get(chatId);
      expect(state?.model).toBe('claude-x');
      expect(state?.permissionMode).toBe('acceptEdits');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /stop-chat — guards + error mapping', () => {
  it('401s unauthenticated; 503s with no host; 400s a zod violation', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const unauth = await app.inject({ method: 'POST', url: '/stop-chat', payload: {} });
      expect(unauth.statusCode).toBe(401);

      const badZod = await app.inject({
        method: 'POST',
        url: '/stop-chat',
        headers: AUTH,
        payload: {},
      });
      expect(badZod.statusCode).toBe(400);
    } finally {
      await app.close();
    }
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({
        method: 'POST',
        url: '/stop-chat',
        headers: AUTH,
        payload: { chatId: 'x' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });

  it('maps a ChatNotFoundError from stopChat to 404 chat_not_found', async () => {
    const daemon = fakeDaemon({
      stopChat: async () => {
        throw new ChatNotFoundError('ghost');
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/stop-chat',
        headers: AUTH,
        payload: { chatId: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  it('rethrows a non-ChatNotFoundError from stopChat uncaught (500)', async () => {
    const daemon = fakeDaemon({
      stopChat: async () => {
        throw new Error('boom');
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/stop-chat',
        headers: AUTH,
        payload: { chatId: 'x' },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /clean — 503 with no host', () => {
  it('503s', async () => {
    const noDaemon = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await noDaemon.inject({ method: 'POST', url: '/clean', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await noDaemon.close();
    }
  });
});

describe('C1 Control IPC: POST /stop — 401 unauthenticated', () => {
  it('401s', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({ method: 'POST', url: '/stop' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /healthz', () => {
  it('reports ok + version + gitSha', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; version: string; gitSha: string };
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');
      expect(typeof body.gitSha).toBe('string');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /internal/* cross-chat tools — full endpoint-by-endpoint branch coverage.
// (These primitives are also exercised in cross-chat-tools.test.ts /
// notifications.test.ts, but coverage for THIS task is measured from this
// file's own run, so every branch is re-driven here too.)

describe('C1 Control IPC: GET /internal/peek/:id', () => {
  it('503s with no host', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/internal/peek/x', headers: AUTH })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('404s unknown chat; rejects a non-positive/NaN limit with 400; clamps >200 to 200', async () => {
    const { daemon, jobs, folder, sdk } = setup();
    sdk.enqueue([{ type: 'assistant', content: 'hello', sessionId: 'S' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const miss = await app.inject({ method: 'GET', url: '/internal/peek/nope', headers: AUTH });
      expect(miss.statusCode).toBe(404);
      expect(miss.json().error).toBe('chat_not_found');

      const badLimit = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}?limit=0`,

        headers: AUTH,
      });
      expect(badLimit.statusCode).toBe(400);
      expect(badLimit.json().error).toBe('invalid_input');

      const nanLimit = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}?limit=abc`,

        headers: AUTH,
      });
      expect(nanLimit.statusCode).toBe(400);

      const clamped = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}?limit=9999`,

        headers: AUTH,
      });
      expect(clamped.statusCode).toBe(200);

      const ok = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}`,
        headers: AUTH,
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json() as { chat_state: { lastMessage?: string } };
      expect(body.chat_state.lastMessage).toBe('hello');
    } finally {
      await app.close();
    }
  });

  it('lastMessage is undefined for a chat with no messages yet', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}`,
        headers: AUTH,
      });
      const body = res.json() as { chat_state: { lastMessage?: string } };
      expect(body.chat_state.lastMessage).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/send-to', () => {
  it('503s with no host; 400s a zod violation', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/send-to', headers: AUTH, payload: {} }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const { daemon, jobs } = setup();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId: '', message: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    } finally {
      await app2.close();
    }
  });

  it('404s an unknown target chat', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId: 'nope', message: 'hi', callerChatId: 'caller' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  it('emits patch.send_to only when BOTH emitWire and callerChatId are present', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      // No callerChatId -> emitWire present but skipped (no caller to attribute).
      const res1 = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'no caller', localId: 'l1' },
      });
      expect(res1.statusCode).toBe(200);
      expect(upstream.find((e) => e.type === 'patch.send_to')).toBeUndefined();

      // With callerChatId -> emits.
      const res2 = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'with caller', callerChatId: 'mgr', localId: 'l2' },
      });
      expect(res2.statusCode).toBe(200);
      expect(upstream.find((e) => e.type === 'patch.send_to')).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('without emitWire wired at all, send-to still succeeds', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'hi', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('accepts an explicit voicePrefix', async () => {
    const { daemon, jobs, folder, sdk } = setup();
    sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'S' }]);
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'hi', voicePrefix: '[voice] ' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rate-limits the 61st call from the same caller (429 envelope)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'one', callerChatId: 'c1' },
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId, message: 'two', callerChatId: 'c1' },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('maps a non-ChatNotFoundError from sendInput to sdk_error (500)', async () => {
    const daemon = fakeDaemon({
      sendInput: async () => {
        throw new Error('sdk exploded');
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId: 'x', message: 'hi' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('sdk_error');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/wake', () => {
  it('503s with no host; 400s a zod violation', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/wake', headers: AUTH, payload: {} }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const { daemon, jobs } = setup();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId: '', message: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('404s an unknown chat', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId: 'nope', message: 'x', in: '10m' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  it('400s: whitespace-only message, both in+at, neither in/at, bad at, bad notAfter', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const whitespace = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: ' ', in: '10m' },
      });
      expect(whitespace.statusCode).toBe(400);
      expect(whitespace.json().error).toBe('invalid_input');

      const both = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'x', in: '10m', at: new Date().toISOString() },
      });
      expect(both.statusCode).toBe(400);

      const neither = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'x' },
      });
      expect(neither.statusCode).toBe(400);

      const badAt = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'x', at: 'not-a-date' },
      });
      expect(badAt.statusCode).toBe(400);

      const badNotAfter = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'x', in: '10m', notAfter: 'not-a-date' },
      });
      expect(badNotAfter.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('schedules with `in`, with `at`, and with `notAfter` (200 + fireAt/fireAtIso)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const withIn = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'ping', in: '10m' },
      });
      expect(withIn.statusCode).toBe(200);
      expect(typeof withIn.json().fireAtIso).toBe('string');

      const withAt = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'ping2', at: new Date(Date.now() + 60_000).toISOString() },
      });
      expect(withAt.statusCode).toBe(200);

      const withNotAfter = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: {
          chatId,
          message: 'ping3',
          in: '5m',
          notAfter: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      expect(withNotAfter.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rate-limits the wake tool per chatId', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'one', in: '1m' },
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'two', in: '1m' },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/wake/cancel', () => {
  it('503s with no host; 400s a zod violation', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/internal/wake/cancel',
            headers: AUTH,
            payload: {},
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const { daemon, jobs } = setup();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/internal/wake/cancel',
        headers: AUTH,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('cancelled:true when a wake existed; cancelled:false otherwise', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId, message: 'ping', in: '10m' },
      });
      const cancelled = await app.inject({
        method: 'POST',
        url: '/internal/wake/cancel',
        headers: AUTH,
        payload: { chatId },
      });
      expect(cancelled.json()).toEqual({ ok: true, cancelled: true });

      const notCancelled = await app.inject({
        method: 'POST',
        url: '/internal/wake/cancel',
        headers: AUTH,
        payload: { chatId },
      });
      expect(notCancelled.json()).toEqual({ ok: true, cancelled: false });
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/spawn — remaining branches', () => {
  it('503s with no host; 400s a zod violation', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/spawn', headers: AUTH, payload: {} }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const { daemon, jobs } = setup();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('emits patch.spawn only when both emitWire and callerChatId are present', async () => {
    const { daemon, jobs, folder } = setup();
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const noCaller = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder },
      });
      expect(noCaller.statusCode).toBe(200);
      expect(upstream.find((e) => e.type === 'patch.spawn')).toBeUndefined();

      const withCaller = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'mgr', prompt: 'go' },
      });
      expect(withCaller.statusCode).toBe(200);
      const ev = upstream.find((e) => e.type === 'patch.spawn');
      expect(ev).toMatchObject({
        type: 'patch.spawn',
        daemonId: 'd1',
        sourceChatId: 'mgr',
        folder,
      });
    } finally {
      await app.close();
    }
  });

  it('rate-limits the spawn tool per callerChatId', async () => {
    const { daemon, jobs, folder } = setup();
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'c1' },
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'c1' },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('folder_not_found maps to 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder: '/no/such/xyz-987', callerChatId: 'c' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('folder_not_found');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: GET /internal/history/:id', () => {
  it('503s with no host; 404s an unknown chat', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/internal/history/x', headers: AUTH })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const { daemon, jobs } = setup();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'GET',
        url: '/internal/history/nope',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app2.close();
    }
  });

  it('400s a bad HistoryQuery (fromSeq/limit not coercible)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}?fromSeq=abc`,

        headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    } finally {
      await app.close();
    }
  });

  it('empty events for a chat with no claudeSessionId yet', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
    } finally {
      await app.close();
    }
  });

  it('includes nextFromSeq when more events remain past the requested limit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-ctl-hist-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-hist-folder-')));
    const metaStore = createMetaStore(home);
    const chatId = 'paged-chat';
    const branchId = `${chatId}-b0`;
    metaStore.write({
      chatId,
      folder,
      name: null,
      claudeSessionId: 'sess-paged',
      nextSeq: 4,
      createdAt: 1,
      updatedAt: 2,
    });
    // Written straight to the log — pagination itself doesn't care how the
    // events got there, only that more than `limit` exist.
    const logDir = join(home, 'chats', chatId);
    mkdirSync(logDir, { recursive: true });
    const records = [1, 2, 3].map((n) => ({
      v: 1,
      seq: n,
      at: 1,
      branchId,
      rec: {
        k: 'event',
        event: { type: 'chat.message', chatId, role: 'assistant', content: `m${n}`, seq: n },
      },
    }));
    writeFileSync(
      join(logDir, 'events.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    daemon.hydrate();
    const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const paged = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}?limit=1`,

        headers: AUTH,
      });
      expect(paged.statusCode).toBe(200);
      const body = paged.json() as { events: unknown[]; nextFromSeq?: number };
      expect(body.events).toHaveLength(1);
      expect(body.nextFromSeq).toBeDefined();

      const full = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}?limit=10`,

        headers: AUTH,
      });
      const fullBody = full.json() as { events: unknown[]; nextFromSeq?: number };
      expect(fullBody.events).toHaveLength(3);
      expect(fullBody.nextFromSeq).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: GET /internal/chats — 503 with no host', () => {
  it('503s', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/internal/chats', headers: AUTH })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('lists active by default; archived=only / include filter correctly; rejects a bad value', async () => {
    const { daemon, jobs, folder } = setup();
    const active = await daemon.spawnChat({ folder });
    const archived = await daemon.spawnChat({ folder });
    await daemon.setArchived(archived, true);
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const def = await app.inject({ method: 'GET', url: '/internal/chats', headers: AUTH });
      expect(def.statusCode).toBe(200);
      expect(def.json().chats.map((c: { chatId: string }) => c.chatId)).toEqual([active]);

      const only = await app.inject({
        method: 'GET',
        url: '/internal/chats?archived=only',
        headers: AUTH,
      });
      expect(only.json().chats.map((c: { chatId: string }) => c.chatId)).toEqual([archived]);

      const include = await app.inject({
        method: 'GET',
        url: '/internal/chats?archived=include',
        headers: AUTH,
      });
      expect(include.json().chats).toHaveLength(2);

      const bad = await app.inject({
        method: 'GET',
        url: '/internal/chats?archived=bogus',
        headers: AUTH,
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: GET /internal/devices', () => {
  it('503s when not configured; 200s when wired', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/internal/devices', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
    const app2 = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      listDevices: () => [
        { deviceId: 'd1', name: 'D1', online: true, muted: false, lastUsedAt: 1 },
      ],
    });
    try {
      const res2 = await app2.inject({ method: 'GET', url: '/internal/devices', headers: AUTH });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().devices).toHaveLength(1);
    } finally {
      await app2.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/stop/:id', () => {
  it('503s with no host; 400s a zod violation', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/stop/x', headers: AUTH })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('404s an unknown chat; 200s a known one; emits patch.stop only with callerChatId', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const miss = await app.inject({ method: 'POST', url: '/internal/stop/nope', headers: AUTH });
      expect(miss.statusCode).toBe(404);
      expect(miss.json().error).toBe('chat_not_found');

      const okNoCaller = await app.inject({
        method: 'POST',
        url: `/internal/stop/${chatId}`,

        headers: AUTH,
      });
      expect(okNoCaller.statusCode).toBe(200);
      expect(upstream.find((e) => e.type === 'patch.stop')).toBeUndefined();

      const okCaller = await app.inject({
        method: 'POST',
        url: `/internal/stop/${chatId}`,

        headers: AUTH,
        payload: { callerChatId: 'mgr' },
      });
      expect(okCaller.statusCode).toBe(200);
      expect(upstream.find((e) => e.type === 'patch.stop')).toMatchObject({
        type: 'patch.stop',
        sourceChatId: 'mgr',
        targetChatId: chatId,
      });
    } finally {
      await app.close();
    }
  });

  it('rate-limits per callerChatId (falls back to "anonymous" when absent)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: `/internal/stop/${chatId}`,
        headers: AUTH,
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: `/internal/stop/${chatId}`,
        headers: AUTH,
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('maps a non-ChatNotFoundError from stopChat to sdk_error (500)', async () => {
    const chatState = new ChatStateMap();
    chatState.set({
      chatId: 'known',
      name: null,
      preview: null,
      folder: '/tmp',
      activity: 'idle',
      lastMessages: [],
      lastUpdated: 1,
      claudeSessionId: undefined,
      model: undefined,
      permissionMode: undefined,
      nextSeq: 0,
      pinned: false,
      pinnedAt: null,
      status: 'active',
      archivedAt: null,
      createdAt: 1,
      lastError: null,
    });
    const daemon = {
      chatState,
      stopChat: async () => {
        throw new Error('boom');
      },
    } as unknown as Daemon;
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'POST', url: '/internal/stop/known', headers: AUTH });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('sdk_error');
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/notify — remaining branches', () => {
  it('503s with no host', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/notify', headers: AUTH, payload: {} }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('rate-limits per callerChatId', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'one', callerChatId: chatId },
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'two', callerChatId: chatId },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('carries priority + deviceId in the emitted notify event when given; omits them otherwise', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'plain', callerChatId: chatId },
      });
      const plain = upstream.find(
        (e) => e.type === 'notify' && 'message' in e && e.message === 'plain',
      );
      expect(plain && 'priority' in plain ? plain.priority : undefined).toBeUndefined();
      expect(plain && 'deviceId' in plain ? plain.deviceId : undefined).toBeUndefined();

      await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: {
          channel: 'push',
          message: 'urgent one',
          callerChatId: chatId,
          priority: 'urgent',
          deviceId: 'kitchen',
        },
      });
      const rich = upstream.find(
        (e) => e.type === 'notify' && 'message' in e && e.message === 'urgent one',
      );
      expect(rich).toMatchObject({ priority: 'urgent', deviceId: 'kitchen' });
    } finally {
      await app.close();
    }
  });

  // spec/06 § `patch_notify`, spec/09 § Notification actions.
  it('carries quickReplies as message actions in the emitted notify event; omits actions otherwise', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'push', message: 'plain', callerChatId: chatId },
      });
      const plain = upstream.find(
        (e) => e.type === 'notify' && 'message' in e && e.message === 'plain',
      );
      expect(plain && 'actions' in plain ? plain.actions : undefined).toBeUndefined();

      await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: {
          channel: 'push',
          message: 'build failed, retry?',
          callerChatId: chatId,
          quickReplies: ['Yes', 'Snooze 10 min'],
        },
      });
      const rich = upstream.find(
        (e) => e.type === 'notify' && 'message' in e && e.message === 'build failed, retry?',
      );
      expect(rich).toMatchObject({
        actions: { kind: 'message', quickReplies: ['Yes', 'Snooze 10 min'] },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects more than 2 quickReplies', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: {
          channel: 'push',
          message: 'x',
          callerChatId: chatId,
          quickReplies: ['a', 'b', 'c'],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('does not call onBroadcast when it is not wired', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', message: 'x', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('calls onBroadcast with the channel/message/sourceChatId when wired', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const broadcasts: { channel: string; message: string; sourceChatId: string }[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
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
      expect(broadcasts).toEqual([
        { channel: 'speakers', message: 'bus delayed', sourceChatId: chatId },
      ]);
    } finally {
      await app.close();
    }
  });

  it('a speakers-channel notify with NO speakers deps wired rings nothing (no throw)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', message: 'ping', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a speakers-channel notify WITH speakers deps wired runs the cascade', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const sent: string[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      speakers: {
        presence: {
          enumerate: () => [
            { deviceId: 'kitchen', online: true, muted: false, lastUsedAt: Date.now() },
          ],
          isOnline: () => true,
          isMuted: () => false,
          send: (id) => {
            sent.push(id);
            return true;
          },
        },
        pushFallback: () => undefined,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: {
          channel: 'speakers',
          message: 'ping',
          callerChatId: chatId,
          deviceId: 'kitchen',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(sent).toEqual(['kitchen']);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/call', () => {
  it('503s with no host; 400s a zod violation', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/call', headers: AUTH, payload: {} }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const { daemon, jobs } = setup();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('404s an unknown target chat', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: 'nope' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rate-limits per callerChatId', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, rateLimiter: limiter });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId },
      });
      expect(ok.statusCode).toBe(200);
      const limited = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('emits a message field only when one was given; runs the speakers cascade conversationally', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const upstream: WireEvent[] = [];
    const sent: { id: string; frame: Record<string, unknown> }[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
      speakers: {
        presence: {
          enumerate: () => [{ deviceId: 'd1', online: true, muted: false, lastUsedAt: Date.now() }],
          isOnline: () => true,
          isMuted: () => false,
          send: (id, frame) => {
            sent.push({ id, frame });
            return true;
          },
        },
        pushFallback: () => undefined,
      },
    });
    try {
      const noMessage = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId },
      });
      expect(noMessage.statusCode).toBe(200);
      const evNoMsg = upstream.find((e) => e.type === 'patch.call');
      expect(evNoMsg && 'message' in evNoMsg ? evNoMsg.message : undefined).toBeUndefined();
      expect(sent[0]?.frame).toMatchObject({ conversational: true });

      upstream.length = 0;
      const withMessage = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId, message: 'pick up' },
      });
      expect(withMessage.statusCode).toBe(200);
      expect(upstream.find((e) => e.type === 'patch.call')).toMatchObject({ message: 'pick up' });
    } finally {
      await app.close();
    }
  });

  it('with no speakers deps wired, still succeeds without ringing anything', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// patch_job_* — every catch-block branch, driven via configurableJobsStore.

describe('C1 Control IPC: GET /internal/jobs (patch_job_list)', () => {
  it('503s when no jobs store is wired', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/internal/jobs', headers: AUTH })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('maps JobsLinkOfflineError to 503 link_offline', async () => {
    const { daemon } = setup();
    const jobs = configurableJobsStore({
      list: () => {
        throw new JobsLinkOfflineError();
      },
    });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/internal/jobs', headers: AUTH });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('link_offline');
    } finally {
      await app.close();
    }
  });

  it('rethrows an unrecognised error uncaught (500)', async () => {
    const { daemon } = setup();
    const jobs = configurableJobsStore({
      list: () => {
        throw new Error('boom');
      },
    });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/internal/jobs', headers: AUTH });
      expect(res.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/jobs (patch_job_create)', () => {
  it('503s when no jobs store is wired; 400s a zod violation', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/internal/jobs', headers: AUTH, payload: {} }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const jobs = new MemoryJobsStore();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/internal/jobs',
        headers: AUTH,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    } finally {
      await app2.close();
    }
  });

  it('maps JobsLinkOfflineError to 503 and the invalid_input name-check to 400', async () => {
    const { daemon } = setup();
    const validPayload = {
      trigger: { type: 'cron' as const, expression: '0 0 * * *' },
      action: { type: 'spawn' as const, daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      name: 'j',
    };
    const offlineJobs = configurableJobsStore({
      create: () => {
        throw new JobsLinkOfflineError();
      },
    });
    const appOffline = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: offlineJobs });
    try {
      const res = await appOffline.inject({
        method: 'POST',
        url: '/internal/jobs',
        headers: AUTH,
        payload: validPayload,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('link_offline');
    } finally {
      await appOffline.close();
    }

    const invalidJobs = configurableJobsStore({
      create: () => {
        throw nameOnlyError('JobInvalidInputError', 'bad cron');
      },
    });
    const appInvalid = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: invalidJobs });
    try {
      const res = await appInvalid.inject({
        method: 'POST',
        url: '/internal/jobs',
        headers: AUTH,
        payload: validPayload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_input');
    } finally {
      await appInvalid.close();
    }

    const explodingJobs = configurableJobsStore({
      create: () => {
        throw new Error('boom');
      },
    });
    const appBoom = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: explodingJobs });
    try {
      const res = await appBoom.inject({
        method: 'POST',
        url: '/internal/jobs',
        headers: AUTH,
        payload: validPayload,
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await appBoom.close();
    }
  });

  it('creates and returns { jobId, job }', async () => {
    const { daemon } = setup();
    const jobs = new MemoryJobsStore({ now: () => 1 });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/jobs',
        headers: AUTH,
        payload: {
          trigger: { type: 'cron', expression: '0 0 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
          name: 'j',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { jobId: string; job: Job };
      expect(body.job.id).toBe(body.jobId);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: PATCH /internal/jobs/:id (patch_job_update)', () => {
  it('503s when no jobs store is wired; 400s a zod violation', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon });
    try {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/internal/jobs/j1',
            headers: AUTH,
            payload: {},
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
    const jobs = new MemoryJobsStore();
    const app2 = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app2.inject({
        method: 'PATCH',
        url: '/internal/jobs/j1',
        headers: AUTH,
        payload: { trigger: { type: 'unknown' } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('maps JobNotFoundError (instanceof), name-only JobNotFoundError, JobsLinkOfflineError, invalid_input, and rethrow', async () => {
    const { daemon } = setup();
    const cases: { store: AsyncJobsInterface; status: number; error?: string }[] = [
      {
        store: configurableJobsStore({
          patch: () => {
            throw new JobNotFoundError('j1');
          },
        }),
        status: 404,
        error: 'job_not_found',
      },
      {
        store: configurableJobsStore({
          patch: () => {
            throw nameOnlyError('JobNotFoundError');
          },
        }),
        status: 404,
        error: 'job_not_found',
      },
      {
        store: configurableJobsStore({
          patch: () => {
            throw new JobsLinkOfflineError();
          },
        }),
        status: 503,
        error: 'link_offline',
      },
      {
        store: configurableJobsStore({
          patch: () => {
            throw nameOnlyError('JobInvalidInputError');
          },
        }),
        status: 400,
        error: 'invalid_input',
      },
      {
        store: configurableJobsStore({
          patch: () => {
            throw new Error('boom');
          },
        }),
        status: 500,
      },
    ];
    for (const { store, status, error } of cases) {
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: store });
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/internal/jobs/j1',
          headers: AUTH,
          payload: { enabled: false },
        });
        expect(res.statusCode).toBe(status);
        if (error) expect(res.json().error).toBe(error);
      } finally {
        await app.close();
      }
    }
  });

  it('updates and returns { job }', async () => {
    const { daemon } = setup();
    const jobs = new MemoryJobsStore({ now: () => 1 });
    const created = jobs.create({
      trigger: { type: 'cron', expression: '0 0 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      name: 'j',
    });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/internal/jobs/${created.id}`,

        headers: AUTH,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.enabled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: DELETE /internal/jobs/:id (patch_job_delete)', () => {
  it('503s when no jobs store is wired', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon });
    try {
      expect(
        (await app.inject({ method: 'DELETE', url: '/internal/jobs/j1', headers: AUTH }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('404s when delete() returns false (not found, no throw)', async () => {
    const { daemon } = setup();
    const jobs = configurableJobsStore({ delete: () => false });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'DELETE', url: '/internal/jobs/j1', headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('job_not_found');
    } finally {
      await app.close();
    }
  });

  it('maps JobNotFoundError (instanceof + name-only), JobsLinkOfflineError, and rethrow', async () => {
    const { daemon } = setup();
    const cases: { store: AsyncJobsInterface; status: number; error?: string }[] = [
      {
        store: configurableJobsStore({
          delete: () => {
            throw new JobNotFoundError('j1');
          },
        }),
        status: 404,
        error: 'job_not_found',
      },
      {
        store: configurableJobsStore({
          delete: () => {
            throw nameOnlyError('JobNotFoundError');
          },
        }),
        status: 404,
        error: 'job_not_found',
      },
      {
        store: configurableJobsStore({
          delete: () => {
            throw new JobsLinkOfflineError();
          },
        }),
        status: 503,
        error: 'link_offline',
      },
      {
        store: configurableJobsStore({
          delete: () => {
            throw new Error('boom');
          },
        }),
        status: 500,
      },
    ];
    for (const { store, status, error } of cases) {
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: store });
      try {
        const res = await app.inject({ method: 'DELETE', url: '/internal/jobs/j1', headers: AUTH });
        expect(res.statusCode).toBe(status);
        if (error) expect(res.json().error).toBe(error);
      } finally {
        await app.close();
      }
    }
  });

  it('deletes and returns ok:true', async () => {
    const { daemon } = setup();
    const jobs = new MemoryJobsStore({ now: () => 1 });
    const created = jobs.create({
      trigger: { type: 'cron', expression: '0 0 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      name: 'j',
    });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/internal/jobs/${created.id}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});

describe('C1 Control IPC: POST /internal/jobs/:id/enable + /disable (patch_job_enable/disable)', () => {
  for (const seg of ['enable', 'disable'] as const) {
    it(`${seg}: 503s when no jobs store is wired`, async () => {
      const { daemon } = setup();
      const app = await buildControl({ localKey: LOCAL_KEY, daemon });
      try {
        expect(
          (await app.inject({ method: 'POST', url: `/internal/jobs/j1/${seg}`, headers: AUTH }))
            .statusCode,
        ).toBe(503);
      } finally {
        await app.close();
      }
    });

    it(`${seg}: maps JobNotFoundError (instanceof + name-only), JobsLinkOfflineError, and rethrow`, async () => {
      const { daemon } = setup();
      const cases: { store: AsyncJobsInterface; status: number; error?: string }[] = [
        {
          store: configurableJobsStore({
            [seg]: () => {
              throw new JobNotFoundError('j1');
            },
          }),
          status: 404,
          error: 'job_not_found',
        },
        {
          store: configurableJobsStore({
            [seg]: () => {
              throw nameOnlyError('JobNotFoundError');
            },
          }),
          status: 404,
          error: 'job_not_found',
        },
        {
          store: configurableJobsStore({
            [seg]: () => {
              throw new JobsLinkOfflineError();
            },
          }),
          status: 503,
          error: 'link_offline',
        },
        {
          store: configurableJobsStore({
            [seg]: () => {
              throw new Error('boom');
            },
          }),
          status: 500,
        },
      ];
      for (const { store, status, error } of cases) {
        const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: store });
        try {
          const res = await app.inject({
            method: 'POST',
            url: `/internal/jobs/j1/${seg}`,
            headers: AUTH,
          });
          expect(res.statusCode).toBe(status);
          if (error) expect(res.json().error).toBe(error);
        } finally {
          await app.close();
        }
      }
    });

    it(`${seg}: returns { job } on success`, async () => {
      const { daemon } = setup();
      const jobs = new MemoryJobsStore({ now: () => 1 });
      const created = jobs.create({
        trigger: { type: 'cron', expression: '0 0 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
        name: 'j',
        enabled: seg === 'disable',
      });
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/internal/jobs/${created.id}/${seg}`,

          headers: AUTH,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().job.enabled).toBe(seg === 'enable');
      } finally {
        await app.close();
      }
    });
  }
});

describe('C1 Control IPC: GET /internal/jobs/:id/runs + /webhooks (patch_job_*_history)', () => {
  for (const seg of ['runs', 'webhooks'] as const) {
    it(`${seg}: 503s when no jobs store is wired`, async () => {
      const { daemon } = setup();
      const app = await buildControl({ localKey: LOCAL_KEY, daemon });
      try {
        expect(
          (await app.inject({ method: 'GET', url: `/internal/jobs/j1/${seg}`, headers: AUTH }))
            .statusCode,
        ).toBe(503);
      } finally {
        await app.close();
      }
    });

    it(`${seg}: 501s when the store doesn't implement it (MemoryJobsStore)`, async () => {
      const { daemon } = setup();
      const jobs = new MemoryJobsStore();
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/internal/jobs/j1/${seg}`,
          headers: AUTH,
        });
        expect(res.statusCode).toBe(501);
      } finally {
        await app.close();
      }
    });

    it(`${seg}: defaults the limit to 50 when omitted, and clamps a valid custom limit`, async () => {
      const { daemon } = setup();
      const calls: (number | undefined)[] = [];
      const jobs = configurableJobsStore({
        [seg]: (_id: string, limit?: number) => {
          calls.push(limit);
          return [{ id: _id, limit }];
        },
      } as Record<string, unknown>);
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
      try {
        const def = await app.inject({
          method: 'GET',
          url: `/internal/jobs/j1/${seg}`,
          headers: AUTH,
        });
        expect(def.statusCode).toBe(200);
        const custom = await app.inject({
          method: 'GET',
          url: `/internal/jobs/j1/${seg}?limit=5`,
          headers: AUTH,
        });
        expect(custom.statusCode).toBe(200);
        expect(calls).toEqual([50, 5]);
      } finally {
        await app.close();
      }
    });

    it(`${seg}: maps a JobsLinkOfflineError thrown mid-call to 503`, async () => {
      const { daemon } = setup();
      const jobs = configurableJobsStore({
        [seg]: () => {
          throw new JobsLinkOfflineError();
        },
      } as Record<string, unknown>);
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/internal/jobs/j1/${seg}`,
          headers: AUTH,
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('link_offline');
      } finally {
        await app.close();
      }
    });

    it(`${seg}: rethrows an unrecognised error uncaught (500)`, async () => {
      const { daemon } = setup();
      const jobs = configurableJobsStore({
        [seg]: () => {
          throw new Error('boom');
        },
      } as Record<string, unknown>);
      const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/internal/jobs/j1/${seg}`,
          headers: AUTH,
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await app.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// GET /internal/files/:chatId — group 19 file-browser sandboxed directory list.

describe('C1 Control IPC: GET /internal/files/:chatId', () => {
  it('503s with no host', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/internal/files/x', headers: AUTH })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('404s an unknown chat', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/internal/files/nope', headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  it('lists the chat folder root, INCLUDING dotfiles, with file sizes + dir type', async () => {
    const { daemon, jobs, folder } = setup();
    mkdirSync(join(folder, 'subdir'));
    writeFileSync(join(folder, 'a.txt'), 'hello');
    writeFileSync(join(folder, '.hidden'), 'secret');
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/files/${chatId}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        path: string;
        entries: { name: string; type: string; size?: number }[];
      };
      expect(body.path).toBe('');
      const names = body.entries.map((e) => e.name).sort();
      expect(names).toEqual(['.hidden', 'a.txt', 'subdir']);
      const hidden = body.entries.find((e) => e.name === '.hidden');
      expect(hidden?.type).toBe('file');
      expect(hidden?.size).toBe(6);
      const file = body.entries.find((e) => e.name === 'a.txt');
      expect(file?.type).toBe('file');
      expect(file?.size).toBe(5);
      const dir = body.entries.find((e) => e.name === 'subdir');
      expect(dir?.type).toBe('dir');
      expect(dir?.size).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('lists a subdirectory via ?path=, stripping a leading slash', async () => {
    const { daemon, jobs, folder } = setup();
    mkdirSync(join(folder, 'sub'));
    writeFileSync(join(folder, 'sub', 'inner.txt'), 'x');
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/files/${chatId}?path=${encodeURIComponent('/sub')}`,

        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { path: string; entries: { name: string }[] };
      expect(body.path).toBe('sub');
      expect(body.entries.map((e) => e.name)).toEqual(['inner.txt']);
    } finally {
      await app.close();
    }
  });

  it('rejects a traversal escape with 400 path_escape', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/files/${chatId}?path=${encodeURIComponent('../../etc')}`,

        headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('path_escape');
    } finally {
      await app.close();
    }
  });

  it('404s when the target path does not exist on disk', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/files/${chatId}?path=${encodeURIComponent('no-such-subdir')}`,

        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Remaining branch coverage: auth edge cases, spread-ternary both-sides,
// non-Error throws, and a plain success path for patch_job_list.

describe('checkAuth branches', () => {
  it('401s with "local-key not configured" when opts.localKey is unset entirely', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs }); // no localKey at all
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/list',
        headers: { authorization: 'Bearer anything' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('local-key not configured');
    } finally {
      await app.close();
    }
  });

  it('401s "bad key" when the bearer token does not match', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/list',
        headers: { authorization: 'Bearer totally-wrong' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('bad key');
    } finally {
      await app.close();
    }
  });
});

describe('GET /chats/folders recents: defensive lastUpdated ?? 0 fallback', () => {
  it('sorts two chats with no lastUpdated value (defensive fallback on both sides)', async () => {
    const { daemon, jobs, folder } = setup();
    const folder2 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctl-folder3-')));
    const a = await daemon.spawnChat({ folder });
    const b = await daemon.spawnChat({ folder: folder2 });
    // Force the defensive branch: real ChatState always sets a numeric
    // lastUpdated, but /chats/folders casts to a looser type — exercise BOTH
    // sides of the sort comparator's `?? 0` fallback directly (comparator only
    // runs with >=2 entries, and needs undefined on both `a` and `b` in the
    // same call to hit both operands' nullish branch).
    (daemon.chatState.get(a) as unknown as { lastUpdated: undefined }).lastUpdated = undefined;
    (daemon.chatState.get(b) as unknown as { lastUpdated: undefined }).lastUpdated = undefined;
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/chats/folders',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { recents: string[] }).recents.sort()).toEqual(
        [folder, folder2].sort(),
      );
    } finally {
      await app.close();
    }
  });
});

describe('POST /chats/:id/archive: rethrows a non-ChatNotFoundError from setArchived', () => {
  it('500s', async () => {
    const chatState = new ChatStateMap();
    chatState.hydrate([
      { chatId: 'x', folder: '/work', name: null, nextSeq: 0, createdAt: 0, updatedAt: 0 },
    ]);
    const daemon = fakeDaemon({
      chatState,
      setArchived: async () => {
        throw new Error('disk full');
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ daemon, jobs, localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/chats/x/archive',
        headers: AUTH,
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe('GET /internal/diag/resume/:id — 503 with no host', () => {
  it('503s', async () => {
    const app = await buildControl({ localKey: LOCAL_KEY });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/diag/resume/x',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('non-Error throw handling (err instanceof Error ? err.message : String(err))', () => {
  it('send-to: a thrown non-Error value is stringified into the message', async () => {
    const daemon = fakeDaemon({
      submitInput: async () => {
        throw 'a plain string failure';
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: AUTH,
        payload: { chatId: 'x', message: 'hi' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toBe('a plain string failure');
    } finally {
      await app.close();
    }
  });

  it('wake: a thrown non-Error value is stringified into the message', async () => {
    const daemon = fakeDaemon({
      scheduleWake: () => {
        throw 'plain wake failure';
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/wake',
        headers: AUTH,
        payload: { chatId: 'x', message: 'hi', in: '1m' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('plain wake failure');
    } finally {
      await app.close();
    }
  });

  it('spawn (internal): a thrown non-Error value is stringified into the message', async () => {
    const daemon = fakeDaemon({
      spawnChat: async () => {
        throw 'plain spawn failure';
      },
    });
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder: '/tmp' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toBe('plain spawn failure');
    } finally {
      await app.close();
    }
  });

  it('stop (internal): a thrown non-Error value is stringified into the message', async () => {
    const chatState = new ChatStateMap();
    chatState.set({
      chatId: 'known2',
      name: null,
      preview: null,
      folder: '/tmp',
      activity: 'idle',
      lastMessages: [],
      lastUpdated: 1,
      claudeSessionId: undefined,
      model: undefined,
      permissionMode: undefined,
      nextSeq: 0,
      pinned: false,
      pinnedAt: null,
      status: 'active',
      archivedAt: null,
      createdAt: 1,
      lastError: null,
    });
    const daemon = {
      chatState,
      stopChat: async () => {
        throw 'plain stop failure';
      },
    } as unknown as Daemon;
    const jobs = new MemoryJobsStore();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'POST', url: '/internal/stop/known2', headers: AUTH });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toBe('plain stop failure');
    } finally {
      await app.close();
    }
  });
});

describe('POST /internal/spawn — remaining spread branches (name/model/permissionMode; prompt fallback)', () => {
  it('passes through name/model/permissionMode when all given', async () => {
    const { daemon, jobs, folder } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: {
          folder,
          name: 'n',
          model: 'claude-y',
          permissionMode: 'plan',
          callerChatId: 'c',
        },
      });
      expect(res.statusCode).toBe(200);
      const chatId = res.json().chatId as string;
      const state = daemon.chatState.get(chatId);
      expect(state?.model).toBe('claude-y');
      expect(state?.permissionMode).toBe('plan');
    } finally {
      await app.close();
    }
  });

  it('emits patch.spawn with prompt falling back to "" when omitted', async () => {
    const { daemon, jobs, folder } = setup();
    const upstream: WireEvent[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      emitWire: (e) => upstream.push(e),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: AUTH,
        payload: { folder, callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(200);
      const ev = upstream.find((e) => e.type === 'patch.spawn');
      expect(ev).toMatchObject({ type: 'patch.spawn', daemonId: 'd1', prompt: '' });
    } finally {
      await app.close();
    }
  });
});

describe('GET /internal/history/:id — fromSeq spread branch', () => {
  it('passes an explicit fromSeq through to readHistory', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/history/${chatId}?fromSeq=5`,

        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
    } finally {
      await app.close();
    }
  });
});

describe('POST /internal/notify — speakers cascade deviceId spread branch', () => {
  it('runs the cascade with NO explicit deviceId (falls to most-recently-active)', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const sent: string[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      speakers: {
        presence: {
          enumerate: () => [
            { deviceId: 'only-device', online: true, muted: false, lastUsedAt: Date.now() },
          ],
          isOnline: () => true,
          isMuted: () => false,
          send: (id) => {
            sent.push(id);
            return true;
          },
        },
        pushFallback: () => undefined,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        payload: { channel: 'speakers', message: 'ping', callerChatId: chatId },
      });
      expect(res.statusCode).toBe(200);
      expect(sent).toEqual(['only-device']);
    } finally {
      await app.close();
    }
  });
});

describe('POST /internal/call — deviceId spread branch', () => {
  it('passes an explicit deviceId through to the cascade input', async () => {
    const { daemon, jobs, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const seenDeviceIds: (string | undefined)[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      speakers: {
        presence: {
          enumerate: () => [{ deviceId: 'd1', online: true, muted: false, lastUsedAt: Date.now() }],
          isOnline: () => true,
          isMuted: () => false,
          send: (id) => {
            seenDeviceIds.push(id);
            return true;
          },
        },
        pushFallback: () => undefined,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/call',
        headers: AUTH,
        payload: { callerChatId: chatId, deviceId: 'd1' },
      });
      expect(res.statusCode).toBe(200);
      expect(seenDeviceIds).toEqual(['d1']);
    } finally {
      await app.close();
    }
  });
});

describe('GET /internal/jobs — plain success path', () => {
  it('returns { jobs } on a successful list()', async () => {
    const { daemon } = setup();
    const jobs = new MemoryJobsStore({ now: () => 1 });
    jobs.create({
      trigger: { type: 'cron', expression: '0 0 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'go' },
      name: 'j',
    });
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({ method: 'GET', url: '/internal/jobs', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().jobs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

// spec/02 § Control IPC lists seventeen endpoints; only four existed, so every
// host-scoped control was unreachable from the machine it belongs to — the one
// place the CLI's default host makes them most necessary.
describe('host-scoped control endpoints (spec/02 § Control IPC)', () => {
  const hostReport = {
    type: 'daemon.host' as const,
    daemonId: 'host-a',
    hostName: 'host-a',
    platform: 'darwin',
    arch: 'arm64',
    daemonVersion: '9.9.9',
    updateAvailable: false,
    permissionModeDefault: 'default' as const,
    permissionOverrides: 0,
    isHomeHost: true,
    audioRelayHost: '127.0.0.1:3003',
    backends: [
      { id: 'claude-code', label: 'Claude Code', version: null, state: 'present' as const },
    ],
    components: [],
  };

  function hostHooks(over: Record<string, unknown> = {}) {
    const calls: string[] = [];
    return {
      calls,
      host: {
        describe: () => hostReport,
        folders: {
          snapshot: () => ({ roots: ['/r'], recent: ['/x'] }),
          add: (p: string) => calls.push(`add:${p}`),
          remove: (p: string) => {
            calls.push(`remove:${p}`);
            return p === '/r';
          },
        },
        backends: {
          list: () => hostReport.backends,
        },
        models: async () => ({ models: [{ id: 'm', label: 'M', backend: 'claude-code' }] }),
        components: {
          install: (c: string) => calls.push(`install:${c}`),
          remove: (c: string) => calls.push(`remove-c:${c}`),
        },
        update: async () => ({ applied: false, message: 'knows of no available update' }),
        ...over,
      },
    };
  }

  const ROUTES: [string, string][] = [
    ['GET', '/host'],
    ['GET', '/folders'],
    ['POST', '/folders/add'],
    ['POST', '/folders/remove'],
    ['GET', '/backends'],
    ['GET', '/models'],
    ['POST', '/components/install'],
    ['POST', '/components/remove'],
    ['POST', '/update'],
    ['POST', '/pair-device'],
  ];

  it('every spec-named host endpoint exists (none 404s)', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, ...hostHooks() });
    try {
      for (const [method, url] of ROUTES) {
        const res = await app.inject({ method: method as 'GET', url, headers: AUTH, payload: {} });
        expect([method, url, res.statusCode]).not.toEqual([method, url, 404]);
      }
    } finally {
      await app.close();
    }
  });

  it('every host endpoint refuses an unauthenticated caller', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, ...hostHooks() });
    try {
      for (const [method, url] of ROUTES) {
        const res = await app.inject({ method: method as 'GET', url, payload: {} });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('reports this host and its folder registry', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, ...hostHooks() });
    try {
      const host = await app.inject({ method: 'GET', url: '/host', headers: AUTH });
      expect(host.json().daemonId).toBe('host-a');
      const folders = await app.inject({ method: 'GET', url: '/folders', headers: AUTH });
      expect(folders.json()).toEqual({ roots: ['/r'], recent: ['/x'] });
    } finally {
      await app.close();
    }
  });

  // spec/01 § Settings: shared settings change on the server, never on one
  // host's socket — so the old per-host routes are gone, not left to drift.
  it('offers no route that changes a shared setting', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, ...hostHooks() });
    try {
      for (const url of [
        '/settings',
        '/backends/connect',
        '/backends/disconnect',
        '/claude-settings/set',
      ]) {
        const res = await app.inject({ method: 'POST', url, headers: AUTH, payload: {} });
        expect([url, res.statusCode]).toEqual([url, 404]);
      }
    } finally {
      await app.close();
    }
  });

  it('removing a path that is not a project root 404s rather than reporting success', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, ...hostHooks() });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/folders/remove',
        headers: AUTH,
        payload: { path: '/never-registered' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('an update nothing can apply is a refusal, not a reported success', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, ...hostHooks() });
    try {
      const res = await app.inject({ method: 'POST', url: '/update', headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('no_update_available');
    } finally {
      await app.close();
    }
  });

  it('an update held behind running turns is accepted (202) and says so', async () => {
    const { daemon } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      ...hostHooks({
        update: async () => ({
          applied: false,
          deferred: true,
          message: 'update to 0.2.0 will apply once 1 running turn finishes',
        }),
      }),
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/update', headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        ok: true,
        deferred: true,
        message: 'update to 0.2.0 will apply once 1 running turn finishes',
      });
    } finally {
      await app.close();
    }
  });

  it('503s rather than 404s when the host controls are not wired at all', async () => {
    const { daemon } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon });
    try {
      const res = await app.inject({ method: 'GET', url: '/host', headers: AUTH });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
