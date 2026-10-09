// Group 9B: REST CRUD for /api/jobs* — JWT auth + zod body validation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { registerJobRoutes } from '../src/jobs/routes.js';
import { JobStore } from '../src/jobs/store.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobListEntry, JobWithCounts } from '../src/jobs/types.js';
import type { JobsInterface, Job, JobCreateBody, JobPatchBody } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

describe('jobs REST routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-jobs-rest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(20));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-jobs',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-jobs',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
    });
    return { built, jwt };
  }

  // TA3-14b. spec/10-auth.md line 152 — "Phone/web clients | Trusted via
  // server-issued credential." These reads are reached only with a verified,
  // non-revoked surface credential, so they carry no rate limit: a Schedules
  // view polling its runs drawer was 429ing against itself at 30/min. The
  // limiter belongs on the UNTRUSTED webhook ingress (line 151), not here.
  it('credential-authenticated job READ routes are not rate-limited', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'polled-by-the-ui',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const auth = { authorization: `Bearer ${jwt}` };
      for (const url of [
        '/api/jobs',
        `/api/jobs/${job.id}`,
        `/api/jobs/${job.id}/runs`,
        `/api/jobs/${job.id}/webhooks`,
        `/api/jobs/${job.id}/queue`,
      ]) {
        const codes: number[] = [];
        for (let i = 0; i < 120; i++) {
          codes.push((await built.app.inject({ method: 'GET', url, headers: auth })).statusCode);
        }
        expect({ url, codes: [...new Set(codes)] }).toEqual({ url, codes: [200] });
      }
    } finally {
      await built.app.close();
    }
  });

  it('job MUTATING routes keep their per-IP limit', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'mutated',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const codes: number[] = [];
      for (let i = 0; i < 40; i++) {
        codes.push(
          (
            await built.app.inject({
              method: 'POST',
              url: `/api/jobs/${job.id}/enable`,
              headers: { authorization: `Bearer ${jwt}` },
            })
          ).statusCode,
        );
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    } finally {
      await built.app.close();
    }
  });

  it('full CRUD with JWT auth + enable/disable', async () => {
    const { built, jwt } = await bootstrap();
    try {
      // POST
      const create = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'morning bus',
          trigger: { type: 'cron', expression: '0 7 * * 1-5' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'check buses' },
        },
      });
      expect(create.statusCode).toBe(201);
      const job = create.json() as { id: string; enabled: boolean };
      expect(job.enabled).toBe(true);

      // GET list
      const list = await built.app.inject({
        method: 'GET',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

      // GET one
      const one = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(one.statusCode).toBe(200);

      // PATCH
      const patch = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'renamed' },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { name: string }).name).toBe('renamed');

      // disable
      const dis = await built.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/disable`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(dis.statusCode).toBe(200);
      expect((dis.json() as { enabled: boolean }).enabled).toBe(false);

      // enable
      const en = await built.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/enable`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(en.statusCode).toBe(200);
      expect((en.json() as { enabled: boolean }).enabled).toBe(true);

      // DELETE
      const del = await built.app.inject({
        method: 'DELETE',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(del.statusCode).toBe(204);
    } finally {
      await built.app.close();
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({ method: 'GET', url: '/api/jobs' });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects invalid body with 400 + zod issues', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'x' /* missing trigger + action */ },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; issues: unknown[] };
      expect(body.error).toBe('invalid body');
      expect(body.issues.length).toBeGreaterThan(0);
    } finally {
      await built.app.close();
    }
  });

  it('rejects invalid cron expression with 400 (group 10 MAJOR M3)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'bad cron',
          trigger: { type: 'cron', expression: 'not a real cron' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { issues: Array<{ message: string }> };
      expect(body.issues.some((i) => i.message.includes('invalid cron'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('rejects non-5-field cron (6/7 fields) with 400, accepts 5-field (spec/08 standard 5-field; H1-d1-1)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const post = (expression: string) =>
        built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: { authorization: `Bearer ${jwt}` },
          payload: {
            name: 'cron-fields',
            trigger: { type: 'cron', expression },
            action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'x' },
          },
        });

      // 6-field (leading seconds field) — node-cron.validate() accepts it but
      // it mis-schedules under our 5-field assumption. Must be rejected.
      const six = await post('0 0 9 * * *');
      expect(six.statusCode).toBe(400);
      expect(
        (six.json() as { issues: Array<{ message: string }> }).issues.some((i) =>
          i.message.includes('invalid cron'),
        ),
      ).toBe(true);

      // 7-field (seconds + year) — also rejected.
      const seven = await post('0 0 0 9 * * *');
      expect(seven.statusCode).toBe(400);

      // Valid 5-field — accepted and persisted.
      const five = await post('0 9 * * *');
      expect(five.statusCode).toBe(201);
    } finally {
      await built.app.close();
    }
  });

  it('rejects invalid JSONata filter with 400 (group 10 MAJOR M3)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'bad filter',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          filter: '$.broken(',
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { issues: Array<{ message: string }> };
      expect(body.issues.some((i) => i.message.includes('invalid JSONata'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('rejects action.message.chatId that is not in chat registry (group 10 MAJOR DX-M3)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      // Seed the registry with a known chat so the gate is "warm".
      built.chatRegistry.observe({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'real',
        folder: '/x',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'unknown chat',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'message', chatId: 'totally-fake', prompt: 'x' },
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { issues: Array<{ message: string }> };
      expect(body.issues.some((i) => i.message.includes('action.chatId not found'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('DELETE an unknown id -> 404', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'DELETE',
        url: '/api/jobs/j_does_not_exist',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('a non-numeric ?limit falls back to the default of 50 on both /runs and /webhooks', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const created = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'bad-limit',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        },
      });
      const job = created.json() as { id: string };
      const runs = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/runs?limit=not-a-number`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(runs.statusCode).toBe(200);
      const webhooks = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/webhooks?limit=not-a-number`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(webhooks.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('GET /api/jobs/:id/runs returns recent run log entries', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const created = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 't',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        },
      });
      const job = created.json() as { id: string };
      // No runs yet — endpoint returns []
      const empty = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/runs`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(empty.statusCode).toBe(200);
      expect((empty.json() as { runs: unknown[] }).runs).toEqual([]);

      // Bad jobId rejected with 400 (regex guard).
      const bad = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/..%2Ftraversal/runs`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  // spec/08 § Concurrency — `GET /api/jobs/:id` reports the two counts; this
  // route reports what those counts are counting, which is what the job page
  // shows.
  it('GET /api/jobs/:id/queue lists the fires in flight and the fires waiting', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'serialised',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
        concurrency: 1,
      });
      const auth = { authorization: `Bearer ${jwt}` };

      // Nothing has fired: an empty queue, but the job's own limit is still
      // reported — the gate has not seen this job yet.
      const idle = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/queue`,
        headers: auth,
      });
      expect(idle.statusCode).toBe(200);
      expect(idle.json()).toEqual({ concurrency: 1, inFlight: [], queued: [] });

      // One fire goes out and takes the only slot; the next waits behind it.
      expect(built.jobDispatcher.dispatch(job, { n: 1 }, 'todoist').status).toBe('sent');
      expect(built.jobDispatcher.dispatch(job, { n: 2 }, 'todoist').status).toBe('queued');

      const res = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/queue`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        concurrency: number | null;
        inFlight: Array<Record<string, unknown>>;
        queued: Array<Record<string, unknown>>;
      };
      expect(body.concurrency).toBe(1);
      expect(body.inFlight).toHaveLength(1);
      expect(body.queued).toHaveLength(1);
      expect(body.inFlight[0]).toMatchObject({
        trigger: 'todoist',
        actionType: 'spawn',
        daemonId: 'd1',
        folder: '/x',
      });
      expect(typeof body.inFlight[0]?.chatId).toBe('string');
      expect(typeof body.inFlight[0]?.startedAt).toBe('number');
      expect(body.queued[0]).toMatchObject({
        trigger: 'todoist',
        actionType: 'spawn',
        daemonId: 'd1',
        folder: '/x',
      });
      expect(typeof body.queued[0]?.fireId).toBe('string');
      expect(typeof body.queued[0]?.queuedAt).toBe('number');
      // The waiting fire is a DIFFERENT fire from the one in flight — a queue
      // that echoed the running chat back would look right and mean nothing.
      expect(body.queued[0]?.chatId).not.toBe(body.inFlight[0]?.chatId);

      // Bad jobId rejected with 400 (regex guard), as on the sibling routes.
      const bad = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/..%2Ftraversal/queue`,
        headers: auth,
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('a job with no limit reports a null concurrency and an empty queue', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'unlimited',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      built.jobDispatcher.dispatch(job, { n: 1 }, 'todoist');
      const res = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/queue`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
      // No limit → no slot is taken and nothing can ever queue, so the fire
      // that just went out is NOT in flight as far as the gate is concerned.
      expect(res.json()).toEqual({ concurrency: null, inFlight: [], queued: [] });
    } finally {
      await built.app.close();
    }
  });

  it('GET unknown id → 404', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/jobs/j_does_not_exist',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('GET /runs and /webhooks for a nonexistent job → 404 (TH1 H1-d2-3)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      // Well-formed but never-existed jobId — must 404 consistently with
      // GET /api/jobs/:id, so a client can't mistake it for an empty-but-real
      // job. A 200 {runs:[]} / {webhooks:[]} would be the disqualifying case.
      const id = 'j_01KV8Y3ZFYD23SSNST7YB8000X';
      const base = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${id}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(base.statusCode).toBe(404);

      const runs = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${id}/runs`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(runs.statusCode).toBe(404);
      expect((runs.json() as { error: string }).error).toBe('job not found');

      const webhooks = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${id}/webhooks`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(webhooks.statusCode).toBe(404);
      expect((webhooks.json() as { error: string }).error).toBe('job not found');

      const queue = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${id}/queue`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(queue.statusCode).toBe(404);
      expect((queue.json() as { error: string }).error).toBe('job not found');
    } finally {
      await built.app.close();
    }
  });

  it('rejects an action with neither skill nor prompt (TH1 H1-d2-1)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const spawn = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'no-op spawn',
          trigger: { type: 'cron', expression: '0 8 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/tmp' },
        },
      });
      expect(spawn.statusCode).toBe(400);
      expect(
        (spawn.json() as { issues: Array<{ message: string }> }).issues.some((i) =>
          /a skill, a prompt, or both/.test(i.message),
        ),
      ).toBe(true);

      built.chatRegistry.observe({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'real',
        folder: '/x',
      });
      const message = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'no-op message',
          trigger: { type: 'cron', expression: '0 8 * * *' },
          action: { type: 'message', chatId: 'real' },
        },
      });
      expect(message.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('ACCEPTS an action carrying BOTH skill and prompt (skill runs with the prompt)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'both',
          trigger: { type: 'cron', expression: '0 8 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', skill: 'foo', prompt: 'x' },
        },
      });
      expect(res.statusCode).toBe(201);
      const job = res.json() as { action: { skill?: string; prompt?: string } };
      expect(job.action.skill).toBe('foo');
      expect(job.action.prompt).toBe('x');
    } finally {
      await built.app.close();
    }
  });

  it('rejects with 401 when the registry has no bootstrapped account at all', async () => {
    const registry = Registry.load(dir);
    // Deliberately skip bootstrapAccount().
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
    });
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/jobs',
        headers: { authorization: 'Bearer whatever' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a syntactically-malformed bearer token with 401 (verifySurfaceCredential throws)', async () => {
    const { built } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/jobs',
        headers: { authorization: 'Bearer not-a-real-jwt-at-all' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('accepts a message action whose chatId IS present in a warm chat registry', async () => {
    const { built, jwt } = await bootstrap();
    try {
      built.chatRegistry.observe({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'real',
        folder: '/x',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'known-chat',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'message', chatId: 'real', prompt: 'x' },
        },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await built.app.close();
    }
  });

  it('PATCH with an invalid cron expression is rejected with 400 (invalid_body / JobValidationError)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'patch-bad-cron-target',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const res = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { trigger: { type: 'cron', expression: 'not a real cron' } },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { issues: Array<{ message: string }> };
      expect(body.issues.some((i) => i.message.includes('invalid cron'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('every job route rejects an unauthenticated request with 401', async () => {
    const { built } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'auth-probe',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const routes: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
        { method: 'GET', url: `/api/jobs/${job.id}` },
        { method: 'POST', url: '/api/jobs' },
        { method: 'PATCH', url: `/api/jobs/${job.id}` },
        { method: 'DELETE', url: `/api/jobs/${job.id}` },
        { method: 'POST', url: `/api/jobs/${job.id}/enable` },
        { method: 'POST', url: `/api/jobs/${job.id}/disable` },
        { method: 'POST', url: `/api/jobs/${job.id}/run` },
        { method: 'GET', url: `/api/jobs/${job.id}/runs` },
        { method: 'GET', url: `/api/jobs/${job.id}/webhooks` },
        { method: 'GET', url: `/api/jobs/${job.id}/queue` },
      ];
      for (const route of routes) {
        const res = await built.app.inject({ method: route.method, url: route.url });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      }
    } finally {
      await built.app.close();
    }
  });

  it('a revoked surface credential is rejected with 401', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-revoked',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-revoked',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: new InProcessDaemonLink(),
    });
    try {
      const before = await built.app.inject({
        method: 'GET',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(before.statusCode).toBe(200);
      registry.revoke('srf-revoked');
      const after = await built.app.inject({
        method: 'GET',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('PATCH an unknown id -> 404', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'PATCH',
        url: '/api/jobs/j_does_not_exist',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('PATCH with an invalid body -> 400', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'patch-invalid',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const res = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { trigger: { type: 'cron' } /* missing required expression */ },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST + PATCH with action.message.chatId while the chat registry is still empty -> 503 transient', async () => {
    const { built, jwt } = await bootstrap();
    try {
      // No `built.chatRegistry.observe(...)` call — the registry is still
      // empty ("not seeded yet"), which is the TRANSIENT (retryable) gate,
      // distinct from a chatId that's simply unknown once the registry has
      // entries.
      const post = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'transient-post',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'message', chatId: 'whatever', prompt: 'x' },
        },
      });
      expect(post.statusCode).toBe(503);
      expect(post.headers['retry-after']).toBe('2');
      expect((post.json() as { error: string }).error).toMatch(/chat registry not seeded yet/);

      const job = built.jobs.create({
        name: 'transient-patch-target',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const patch = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { action: { type: 'message', chatId: 'whatever', prompt: 'x' } },
      });
      expect(patch.statusCode).toBe(503);
      expect(patch.headers['retry-after']).toBe('2');
    } finally {
      await built.app.close();
    }
  });

  it('PATCH rejects action.message.chatId that is not in a WARM chat registry (400, not 503)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      built.chatRegistry.observe({
        type: 'chat.spawned',
        daemonId: 'd1',
        chatId: 'real',
        folder: '/x',
      });
      const job = built.jobs.create({
        name: 'patch-bad-chatid',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const res = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { action: { type: 'message', chatId: 'totally-fake', prompt: 'x' } },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { issues: Array<{ message: string }> };
      expect(body.issues.some((i) => i.message.includes('action.chatId not found'))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('enable / disable on an unknown id -> 404', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const enable = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/j_does_not_exist/enable',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(enable.statusCode).toBe(404);
      const disable = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/j_does_not_exist/disable',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(disable.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/jobs/:id/run fires the action immediately, tagged manual, even while disabled (spec/08 ## Manual run)', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const create = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'run-now-target',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
        },
      });
      const job = create.json() as { id: string };

      // Disabled — manual run must still fire; testing before enabling is the point.
      await built.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/disable`,
        headers: { authorization: `Bearer ${jwt}` },
      });

      const run = await built.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/run`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(run.statusCode).toBe(200);
      const body = run.json() as { status: string; fireId: string };
      // bootstrap()'s InProcessDaemonLink reports itself online by default -> sent.
      expect(body.status).toBe('sent');
      expect(typeof body.fireId).toBe('string');

      const runs = await built.app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/runs`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      const entries = (runs.json() as { runs: Array<{ trigger: string; status: string }> }).runs;
      // dispatch() only writes an entry itself for `buffered`; a `sent` fire's
      // run entry is written later from what the host reports back (spec/08 ##
      // Execution model step 6) — no host is attached here to report anything,
      // so the log is legitimately still empty right after a `sent` dispatch.
      expect(entries).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/jobs/:id/run with a draft fires it without saving it; a bad draft -> 400', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const headers = { authorization: `Bearer ${jwt}` };
      const create = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers,
        payload: {
          name: 'run-draft',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'saved prompt' },
        },
      });
      const job = create.json() as { id: string };
      const ok = await built.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/run`,
        headers,
        payload: {
          draft: {
            action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'edited prompt' },
          },
        },
      });
      expect(ok.statusCode).toBe(200);
      const after = await built.app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers });
      expect((after.json() as { action: { prompt: string } }).action.prompt).toBe('saved prompt');

      const bad = await built.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/run`,
        headers,
        payload: { draft: { trigger: { type: 'cron', expression: 'not a cron' } } },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/jobs/:id/run on an unknown id -> 404', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs/j_does_not_exist/run',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/jobs/:id/run rejects unauthenticated requests with 401', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const create = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'run-now-auth',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
        },
      });
      const job = create.json() as { id: string };
      const res = await built.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/run` });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('POST /api/jobs/:id/run -> 503 when no dispatcher is configured', async () => {
    const registry = Registry.load(dir);
    const user = generateUserKeypair(() => new Uint8Array(32).fill(24));
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-run-no-dispatcher',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-run-no-dispatcher',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const app = Fastify();
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const job = store.create({
      name: 'no-dispatcher-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    registerJobRoutes(app, { logger: silentLogger, registry, jobs: store });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/run`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('GET /api/jobs/:id/webhooks rejects a malformed jobId with 400', async () => {
    const { built, jwt } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/jobs/..%2Ftraversal/webhooks',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  describe('a bare registerJobRoutes harness (no chatRegistry / no jobLogs / a throwing JobsInterface)', () => {
    function fakeThrowingJobs(existing?: Job): JobsInterface {
      return {
        list: () => (existing ? [existing] : []),
        get: (id) => (existing && existing.id === id ? existing : null),
        create: (_body: JobCreateBody) => {
          throw new Error('boom: create');
        },
        patch: (_id: string, _body: JobPatchBody) => {
          throw new Error('boom: patch');
        },
        delete: () => true,
        enable: (id) => {
          if (existing) return existing;
          throw new Error(`no such job: ${id}`);
        },
        disable: (id) => {
          if (existing) return existing;
          throw new Error(`no such job: ${id}`);
        },
        onChange: () => () => undefined,
      };
    }

    async function rawApp(
      jobs: JobsInterface,
      opts: { withChatRegistry?: boolean; withJobLogs?: boolean } = {},
    ) {
      const registry = Registry.load(dir);
      const user = generateUserKeypair(() => new Uint8Array(32).fill(22));
      registry.bootstrapAccount({ keypair: user });
      registry.upsertSurface({
        surfaceId: 'srf-raw',
        surfaceKind: 'terminal',
        label: 'cli',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-raw',
        surfaceKind: 'terminal',
        label: 'cli',
      });
      const app = Fastify();
      const { ChatRegistry } = await import('../src/chat-registry.js');
      const { JobLogs } = await import('../src/jobs/logs.js');
      registerJobRoutes(app, {
        logger: silentLogger,
        registry,
        jobs,
        ...(opts.withChatRegistry
          ? { chatRegistry: new ChatRegistry({ logger: silentLogger }) }
          : {}),
        ...(opts.withJobLogs ? { jobLogs: new JobLogs(dir) } : {}),
      });
      await app.ready();
      return { app, jwt };
    }

    it('without a chatRegistry dependency, action.message.chatId validation is skipped entirely', async () => {
      const { app, jwt } = await rawApp(fakeThrowingJobs());
      try {
        // create() on this fake jobs interface always throws, but the point
        // of this test is that we get PAST the chat-gate (no 503/400 from
        // validateActionChatId) and reach the create() call at all — proven
        // by the 500 (rethrown non-JobValidationError) rather than 503/400.
        const res = await app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: { authorization: `Bearer ${jwt}` },
          payload: {
            name: 'no-registry',
            trigger: { type: 'cron', expression: '0 9 * * *' },
            action: { type: 'message', chatId: 'anything-at-all', prompt: 'x' },
          },
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await app.close();
      }
    });

    it('POST: a non-JobValidationError thrown by jobs.create() is rethrown (500), not swallowed as a 400', async () => {
      const { app, jwt } = await rawApp(fakeThrowingJobs());
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: { authorization: `Bearer ${jwt}` },
          payload: {
            name: 'rethrow-create',
            trigger: { type: 'cron', expression: '0 9 * * *' },
            action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
          },
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await app.close();
      }
    });

    it('PATCH: a non-JobValidationError thrown by jobs.patch() is rethrown (500), not swallowed as a 400', async () => {
      const existing: Job = {
        id: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'existing',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        createdAt: 1,
        updatedAt: 1,
      };
      const { app, jwt } = await rawApp(fakeThrowingJobs(existing));
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${existing.id}`,
          headers: { authorization: `Bearer ${jwt}` },
          payload: { name: 'renamed' },
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await app.close();
      }
    });

    it('GET /runs and /webhooks -> 503 when jobLogs is not configured', async () => {
      const existing: Job = {
        id: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'existing',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        createdAt: 1,
        updatedAt: 1,
      };
      const { app, jwt } = await rawApp(fakeThrowingJobs(existing));
      try {
        const runs = await app.inject({
          method: 'GET',
          url: `/api/jobs/${existing.id}/runs`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(runs.statusCode).toBe(503);
        const webhooks = await app.inject({
          method: 'GET',
          url: `/api/jobs/${existing.id}/webhooks`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(webhooks.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });

    it('GET /queue -> 503 when the dispatcher is not configured', async () => {
      const existing: Job = {
        id: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'existing',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        filter: null,
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        createdAt: 1,
        updatedAt: 1,
      };
      const { app, jwt } = await rawApp(fakeThrowingJobs(existing));
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/jobs/${existing.id}/queue`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });

    // The jobs LIST carries each job's most recent fire as runtime state
    // (spec/14 § Jobs view), so the page draws a last-fired per row from one
    // request. It is reported only when the server has a jobLogs to read.
    it("GET /api/jobs reports each job's latest run when jobLogs IS configured", async () => {
      const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
      const fired = store.create({
        name: 'has-fired',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const never = store.create({
        name: 'never-fired',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const logs = new JobLogs(dir);
      logs.appendRun({ ts: 10, jobId: fired.id, status: 'ok', trigger: 'cron' });
      logs.appendRun({
        ts: 20,
        jobId: fired.id,
        status: 'chat-error',
        trigger: 'cron',
        action: { type: 'spawn', chatId: 'c_latest', daemonId: 'd1' },
      });
      const { app, jwt } = await rawApp(store, { withJobLogs: true });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/jobs',
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { jobs: Array<Record<string, unknown>> };
        const parsed = body.jobs.map((j) => JobListEntry.parse(j));
        const firedRow = parsed.find((j) => j.id === fired.id);
        const neverRow = parsed.find((j) => j.id === never.id);
        // Only the latest fire, with its outcome and the chat it landed in.
        expect(firedRow?.latestRun).toEqual({ ts: 20, status: 'chat-error', chatId: 'c_latest' });
        // A job that has never fired reports null, not an absent key.
        expect(neverRow?.latestRun).toBeNull();
      } finally {
        await app.close();
        await store.close();
      }
    });

    it('GET /api/jobs omits latestRun entirely when jobLogs is NOT configured', async () => {
      const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
      store.create({
        name: 'no-logs',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const { app, jwt } = await rawApp(store);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/jobs',
          headers: { authorization: `Bearer ${jwt}` },
        });
        const body = res.json() as { jobs: Array<Record<string, unknown>> };
        expect(body.jobs[0]).not.toHaveProperty('latestRun');
      } finally {
        await app.close();
        await store.close();
      }
    });

    // The SINGLE-job response is spec'd as `JobWithCounts`, which is
    // `.strict()`, so it must stay exactly that: the latest run is a thing the
    // LIST needs per row, and no reason to widen a response nothing asked for.
    it('GET /api/jobs/:id does NOT carry latestRun', async () => {
      const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
      const job = store.create({
        name: 'single',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      new JobLogs(dir).appendRun({ ts: 5, jobId: job.id, status: 'ok', trigger: 'cron' });
      const { app, jwt } = await rawApp(store, { withJobLogs: true });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/jobs/${job.id}`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(200);
        expect(() => JobWithCounts.parse(res.json())).not.toThrow();
        expect(res.json()).not.toHaveProperty('latestRun');
      } finally {
        await app.close();
        await store.close();
      }
    });

    it('GET /webhooks returns entries when jobLogs IS configured', async () => {
      const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
      const job = store.create({
        name: 'with-jobLogs',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      const { app, jwt } = await rawApp(store, { withJobLogs: true });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/jobs/${job.id}/webhooks`,
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as { webhooks: unknown[] }).webhooks).toEqual([]);
      } finally {
        await app.close();
        await store.close();
      }
    });
  });
});
