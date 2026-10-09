// Direct unit coverage of src/dev-diag.ts's route handlers — complements
// test/td1-dev-seams.test.ts (which drives the SAME routes end-to-end through
// buildAll()). Here we register the routes directly on a bare Fastify
// instance so we can cheaply exercise dependency-missing branches (503s),
// CORS/OPTIONS preflight branches, and the jobs-diag fire-cron route, none of
// which the full-stack buildAll() wiring can reach (it always constructs a
// real callOrchestrator/wsHub and never a bare cronScheduler-only stack).

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import {
  registerDevDiagRoutes,
  registerJobsDiagRoutes,
  InMemorySpeakersRecorder,
} from '../src/dev-diag.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import type { CronScheduler } from '../src/jobs/cron.js';

const TOKEN = 'unit-test-internal-token-abc';
const silentLogger = pino({ level: 'silent' });

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe('registerDevDiagRoutes — dependency-missing branches', () => {
  it('POST /internal/diag/incoming-call → 503 when callOrchestrator/wsHub are not configured', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/incoming-call',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { chatId: 'thread_manager' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/call orchestrator/);
  });

  it('GET /internal/diag/speakers/sent → 503 when speakersRecorder is not configured', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/diag/speakers/sent',
      headers: { 'x-patch-internal-token': TOKEN },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/speakers recorder/);
  });

  it('GET /internal/diag/speakers/sent → 200 with recorded entries when speakersRecorder IS configured', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    const speakersRecorder = new InMemorySpeakersRecorder();
    speakersRecorder.record({
      ts: 1,
      chatId: 'thread_speakers',
      deviceId: 'kitchen',
      message: 'ok',
    });
    registerDevDiagRoutes(app, {
      logger: silentLogger,
      daemonLink: link,
      internalToken: TOKEN,
      speakersRecorder,
    });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/diag/speakers/sent',
      headers: { 'x-patch-internal-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toHaveLength(1);
  });
});

describe('registerDevDiagRoutes — voice-device/transcript invalid body', () => {
  it('POST /internal/diag/voice-device/transcript → 401 without a valid internal token', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/transcript',
      payload: { deviceId: 'kitchen', transcript: 'hi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /internal/diag/voice-device/transcript falls back to Date.now() when no idGenerator is configured', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN }); // no idGenerator
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/transcript',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { deviceId: 'kitchen', transcript: 'turn off the lights' },
    });
    expect(res.statusCode).toBe(202);
    const sent = link.sent.find((s) => s.event.type === 'chat.input');
    expect(sent).toBeDefined();
    expect((sent!.event as { localId: string }).localId).toMatch(/^vd-kitchen-\d+$/);
  });

  it('POST /internal/diag/voice-device/transcript uses a custom idGenerator when provided', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, {
      logger: silentLogger,
      daemonLink: link,
      internalToken: TOKEN,
      idGenerator: () => 'fixed-id-1',
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/transcript',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { deviceId: 'kitchen', transcript: 'turn off the lights' },
    });
    expect(res.statusCode).toBe(202);
    const sent = link.sent.find((s) => s.event.type === 'chat.input');
    expect(sent).toBeDefined();
    expect((sent!.event as { localId: string }).localId).toBe('vd-kitchen-fixed-id-1');
  });

  it('POST /internal/diag/voice-device/transcript → 400 on an invalid body', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/transcript',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { deviceId: '' }, // missing transcript, empty deviceId
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid body');
  });
});

describe('registerDevDiagRoutes — voice-device/session route', () => {
  it('POST /internal/diag/voice-device/session injects a device.session event', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    const received: WireEvent[] = [];
    link.onEvent((e) => received.push(e));
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/session',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { deviceId: 'kitchen', name: 'Kitchen Display', active: true },
    });
    expect(res.statusCode).toBe(202);
    const ev = received.find((e) => e.type === 'device.session');
    expect(ev).toMatchObject({
      type: 'device.session',
      deviceId: 'kitchen',
      name: 'Kitchen Display',
      active: true,
    });
  });

  it('POST /internal/diag/voice-device/session → 401 without a valid internal token', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/session',
      payload: { deviceId: 'kitchen', name: 'Kitchen Display', active: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /internal/diag/voice-device/session → 400 on an invalid body', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-device/session',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { deviceId: '', name: 'x' }, // missing `active`, empty deviceId
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('registerDevDiagRoutes — incoming-call success path', () => {
  it('POST /internal/diag/incoming-call → 202 + callId when callOrchestrator/wsHub ARE configured', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    const sentToWeb: WireEvent[] = [];
    const fakeWsHub = {
      sendToKind: (_kind: string, event: WireEvent) => {
        sentToWeb.push(event);
      },
    };
    const fakeCallOrchestrator = {
      startCall: async (_event: unknown) => 'call-123',
    };
    registerDevDiagRoutes(app, {
      logger: silentLogger,
      daemonLink: link,
      internalToken: TOKEN,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOrchestrator: fakeCallOrchestrator as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsHub: fakeWsHub as any,
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/incoming-call',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { chatId: 'thread_manager', message: 'pick up!' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: true, callId: 'call-123' });
    expect(sentToWeb).toHaveLength(1);
    expect(sentToWeb[0]).toMatchObject({
      type: 'chat.call_request',
      callId: 'call-123',
      chatId: 'thread_manager',
      message: 'pick up!',
    });
  });

  it('POST /internal/diag/incoming-call → 202 with just chatId (no optional message)', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    const sentToWeb: WireEvent[] = [];
    const fakeWsHub = {
      sendToKind: (_kind: string, event: WireEvent) => {
        sentToWeb.push(event);
      },
    };
    const fakeCallOrchestrator = {
      startCall: async (_event: unknown) => 'call-456',
    };
    registerDevDiagRoutes(app, {
      logger: silentLogger,
      daemonLink: link,
      internalToken: TOKEN,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callOrchestrator: fakeCallOrchestrator as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsHub: fakeWsHub as any,
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/incoming-call',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { chatId: 'thread_manager' },
    });
    expect(res.statusCode).toBe(202);
    expect(sentToWeb[0]).not.toHaveProperty('message');
  });

  it('POST /internal/diag/incoming-call → 400 on an invalid body (missing chatId)', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/incoming-call',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('registerDevDiagRoutes — permission-request / voice-inject invalid bodies', () => {
  it('POST /internal/diag/permission-request → 202 applying defaults when tool/description are omitted', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/permission-request',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { chatId: 'thread_manager' }, // no tool, no description
    });
    expect(res.statusCode).toBe(202);
    const sent = link.sent.find((s) => s.event.type === 'patch.diag.inject_permission');
    expect(sent!.event).toMatchObject({
      chatId: 'thread_manager',
      tool: 'Bash',
      description: 'Run a command — approve?',
    });
  });

  it('POST /internal/diag/permission-request → 400 on invalid body', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/permission-request',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /internal/diag/voice-inject → 400 on invalid body', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/voice-inject',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { surfaceId: '' }, // empty surfaceId + missing text
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('registerDevDiagRoutes — dev CORS/OPTIONS preflight hook', () => {
  it('sets CORS headers + short-circuits with 204 on an OPTIONS preflight to a diag route', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/internal/diag/speakers/sent',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('does not set access-control-allow-origin when no Origin header is present', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/diag/speakers/sent',
      headers: { 'x-patch-internal-token': TOKEN },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the CORS hook does not touch non-diag routes (early return)', async () => {
    app = Fastify();
    const link = new InProcessDaemonLink();
    app.get('/api/healthz', async () => ({ ok: true }));
    registerDevDiagRoutes(app, { logger: silentLogger, daemonLink: link, internalToken: TOKEN });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    // Non-diag route: the hook returns before setting any CORS header.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('registerJobsDiagRoutes', () => {
  function fakeScheduler(fire: (jobId: string) => Promise<void>): CronScheduler {
    return { fireForTesting: fire } as unknown as CronScheduler;
  }

  it('POST /internal/diag/jobs/fire-cron → 202 { fired: true } on success', async () => {
    app = Fastify();
    const calls: string[] = [];
    registerJobsDiagRoutes(app, {
      logger: silentLogger,
      internalToken: TOKEN,
      cronScheduler: fakeScheduler(async (jobId) => {
        calls.push(jobId);
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/jobs/fire-cron',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { jobId: 'job-1' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ fired: true, jobId: 'job-1' });
    expect(calls).toEqual(['job-1']);
  });

  it('POST /internal/diag/jobs/fire-cron → 401 without a valid internal token', async () => {
    app = Fastify();
    registerJobsDiagRoutes(app, {
      logger: silentLogger,
      internalToken: TOKEN,
      cronScheduler: fakeScheduler(async () => undefined),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/jobs/fire-cron',
      payload: { jobId: 'job-1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /internal/diag/jobs/fire-cron → 400 on invalid body', async () => {
    app = Fastify();
    registerJobsDiagRoutes(app, {
      logger: silentLogger,
      internalToken: TOKEN,
      cronScheduler: fakeScheduler(async () => undefined),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/jobs/fire-cron',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /internal/diag/jobs/fire-cron → 404 when the job does not exist', async () => {
    app = Fastify();
    registerJobsDiagRoutes(app, {
      logger: silentLogger,
      internalToken: TOKEN,
      cronScheduler: fakeScheduler(async (jobId) => {
        throw new Error(`fireForTesting: no such job ${jobId}`);
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/jobs/fire-cron',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { jobId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'no such job', jobId: 'nope' });
  });

  it('POST /internal/diag/jobs/fire-cron → 500 on any other thrown error', async () => {
    app = Fastify();
    registerJobsDiagRoutes(app, {
      logger: silentLogger,
      internalToken: TOKEN,
      cronScheduler: fakeScheduler(async () => {
        throw new Error('boom: dispatcher exploded');
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/diag/jobs/fire-cron',
      headers: { 'x-patch-internal-token': TOKEN },
      payload: { jobId: 'job-1' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/boom/);
  });
});
