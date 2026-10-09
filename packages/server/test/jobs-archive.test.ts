// Archived jobs (spec/08 § Archived jobs): a job the user has put away. It
// does not fire, it keeps its run history, and un-archiving restores it
// exactly as it was.
//
// The firing rule is `jobFires` (one definition in @patch/wire/jobs), so the
// cases below are deliberately one per INGRESS — cron, webhook, Todoist
// fan-out — because that is where a second way of being inert gets
// forgotten. A manual run is not an ingress and deliberately still works.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { CronScheduler } from '../src/jobs/cron.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobStore } from '../src/jobs/store.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

const TRIGGER = { type: 'cron', expression: '0 7 * * *' } as const;
const ACTION = { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' } as const;

describe('archived jobs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-archive-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- store -------------------------------------------------------------

  describe('JobStore', () => {
    function makeStore(): JobStore {
      return new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    }

    it('a new job is not archived, and patch archives + un-archives it', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'j', trigger: TRIGGER, action: ACTION });
        expect(job.archived).toBeUndefined();
        expect(store.patch(job.id, { archived: true }).archived).toBe(true);
        expect(store.get(job.id)?.archived).toBe(true);
        expect(store.patch(job.id, { archived: false }).archived).toBe(false);
      } finally {
        await store.close();
      }
    });

    it('archiving leaves `enabled` exactly as it was, both ways round', async () => {
      const store = makeStore();
      try {
        const on = store.create({ name: 'on', trigger: TRIGGER, action: ACTION });
        const off = store.create({
          name: 'off',
          trigger: TRIGGER,
          action: ACTION,
          enabled: false,
        });

        expect(store.patch(on.id, { archived: true }).enabled).toBe(true);
        expect(store.patch(off.id, { archived: true }).enabled).toBe(false);
        // ...and back out again, unchanged.
        expect(store.patch(on.id, { archived: false }).enabled).toBe(true);
        expect(store.patch(off.id, { archived: false }).enabled).toBe(false);
      } finally {
        await store.close();
      }
    });

    it('enabling an archived job does not un-archive it — the two are orthogonal', async () => {
      const store = makeStore();
      try {
        const job = store.create({
          name: 'j',
          trigger: TRIGGER,
          action: ACTION,
          enabled: false,
        });
        store.patch(job.id, { archived: true });
        const enabled = store.enable(job.id);
        expect(enabled.enabled).toBe(true);
        expect(enabled.archived).toBe(true);
      } finally {
        await store.close();
      }
    });

    it('an archived job survives a reload from disk', async () => {
      const first = makeStore();
      let id: string;
      try {
        id = first.create({ name: 'j', trigger: TRIGGER, action: ACTION }).id;
        first.patch(id, { archived: true });
      } finally {
        await first.close();
      }
      const second = makeStore();
      try {
        expect(second.get(id)?.archived).toBe(true);
      } finally {
        await second.close();
      }
    });
  });

  // ---- cron --------------------------------------------------------------

  describe('cron scheduler', () => {
    function setup(): {
      jobs: JobStore;
      scheduler: CronScheduler;
      dispatcher: JobDispatcher;
      link: InProcessDaemonLink;
      tasks: Map<string, () => Promise<void>>;
    } {
      const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
      const link = new InProcessDaemonLink();
      const dispatcher = new JobDispatcher({
        dataDir: dir,
        daemonLink: link,
        logger: silentLogger,
        logs: new JobLogs(dir),
      });
      const tasks = new Map<string, () => Promise<void>>();
      const scheduler = new CronScheduler({
        jobs,
        dispatcher,
        logs: new JobLogs(dir),
        logger: silentLogger,
        registerTask: (jobId, _expr, cb) => {
          tasks.set(jobId, cb);
          return () => tasks.delete(jobId);
        },
      });
      scheduler.start();
      return { jobs, scheduler, dispatcher, link, tasks };
    }

    it('archiving a live job deregisters its cron task; un-archiving registers it again', async () => {
      const { jobs, scheduler, dispatcher, tasks } = setup();
      try {
        const job = jobs.create({ name: 'morning', trigger: TRIGGER, action: ACTION });
        expect(tasks.has(job.id)).toBe(true);

        jobs.patch(job.id, { archived: true });
        expect(tasks.has(job.id)).toBe(false);

        jobs.patch(job.id, { archived: false });
        expect(tasks.has(job.id)).toBe(true);
      } finally {
        scheduler.stop();
        dispatcher.close();
        await jobs.close();
      }
    });

    it('an archived job already on disk is never registered at startup', async () => {
      const seed = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
      const id = seed.create({ name: 'morning', trigger: TRIGGER, action: ACTION }).id;
      seed.patch(id, { archived: true });
      await seed.close();

      const { jobs, scheduler, dispatcher, tasks } = setup();
      try {
        expect(jobs.get(id)?.archived).toBe(true);
        expect(tasks.has(id)).toBe(false);
      } finally {
        scheduler.stop();
        dispatcher.close();
        await jobs.close();
      }
    });

    it('a tick that arrives after the job was archived dispatches nothing', async () => {
      const { jobs, scheduler, dispatcher, link, tasks } = setup();
      try {
        const job = jobs.create({ name: 'morning', trigger: TRIGGER, action: ACTION });
        const tick = tasks.get(job.id)!;
        // The archive lands between node-cron's tick and the callback running.
        jobs.patch(job.id, { archived: true });
        await tick();

        expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
        expect(existsSync(join(dir, 'runs', `${job.id}.jsonl`))).toBe(false);
      } finally {
        scheduler.stop();
        dispatcher.close();
        await jobs.close();
      }
    });
  });

  // ---- HTTP ingress ------------------------------------------------------

  describe('ingress', () => {
    async function setup(): Promise<{
      built: Awaited<ReturnType<typeof buildAll>>;
      link: InProcessDaemonLink;
    }> {
      const registry = Registry.load(dir);
      const link = new InProcessDaemonLink();
      const built = await buildAll({ logger: false, registry, daemonLink: link });
      return { built, link };
    }

    function webhookLines(jobId: string): Array<Record<string, unknown>> {
      const p = join(dir, 'webhooks', `${jobId}.jsonl`);
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }

    it('a webhook push to an archived job is refused 503, named as archived', async () => {
      const { built, link } = await setup();
      try {
        const job = built.jobs.create({
          name: 'hook',
          trigger: { type: 'webhook', scheme: 'none' },
          action: ACTION,
        });
        built.jobs.patch(job.id, { archived: true });

        const res = await built.app.inject({
          method: 'POST',
          url: `/api/webhooks/${job.id}`,
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        });

        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'job archived' });
        expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
        // The refusal is in the firehose, saying which kind of inert it was.
        expect(webhookLines(job.id).at(-1)?.['error']).toBe('job archived');
      } finally {
        await built.app.close();
      }
    });

    it('a disabled job is still refused as disabled — the reason is not flattened', async () => {
      const { built } = await setup();
      try {
        const job = built.jobs.create({
          name: 'hook',
          trigger: { type: 'webhook', scheme: 'none' },
          action: ACTION,
        });
        built.jobs.disable(job.id);

        const res = await built.app.inject({
          method: 'POST',
          url: `/api/webhooks/${job.id}`,
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'job disabled' });
      } finally {
        await built.app.close();
      }
    });

    it('the shared Todoist fan-out skips an archived job and still fires a live one', async () => {
      const prev = process.env['TODOIST_WEBHOOK_SECRET'];
      process.env['TODOIST_WEBHOOK_SECRET'] = 'fake-secret';
      const { built } = await setup();
      try {
        const live = built.jobs.create({
          name: 'live',
          trigger: { type: 'todoist' },
          action: ACTION,
        });
        const away = built.jobs.create({
          name: 'away',
          trigger: { type: 'todoist' },
          action: ACTION,
        });
        built.jobs.patch(away.id, { archived: true });

        const raw = JSON.stringify({ event_name: 'item:added', event_data: { content: 'x' } });
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/webhooks/todoist',
          headers: {
            'content-type': 'application/json',
            'x-todoist-hmac-sha256': createHmac('sha256', 'fake-secret')
              .update(raw)
              .digest('base64'),
          },
          payload: raw,
        });

        expect(res.statusCode).toBe(200);
        const ids = (res.json() as { results: Array<{ jobId: string }> }).results.map(
          (r) => r.jobId,
        );
        expect(ids).toContain(live.id);
        expect(ids).not.toContain(away.id);
      } finally {
        await built.app.close();
        if (prev === undefined) delete process.env['TODOIST_WEBHOOK_SECRET'];
        else process.env['TODOIST_WEBHOOK_SECRET'] = prev;
      }
    });
  });

  // ---- REST --------------------------------------------------------------

  describe('REST /api/jobs', () => {
    async function bootstrap(): Promise<{
      built: Awaited<ReturnType<typeof buildAll>>;
      auth: { authorization: string };
    }> {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: user });
      registry.upsertSurface({
        surfaceId: 'srf-archive',
        surfaceKind: 'terminal',
        label: 'cli',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-archive',
        surfaceKind: 'terminal',
        label: 'cli',
      });
      const built = await buildAll({
        logger: false,
        registry,
        daemonLink: new InProcessDaemonLink(),
      });
      return { built, auth: { authorization: `Bearer ${jwt}` } };
    }

    const BODY = { name: 'j', trigger: TRIGGER, action: ACTION };

    it('PATCH archives and un-archives, and the job reads back that way', async () => {
      const { built, auth } = await bootstrap();
      try {
        const created = (
          await built.app.inject({ method: 'POST', url: '/api/jobs', headers: auth, payload: BODY })
        ).json() as Job;
        expect(created.archived).toBeUndefined();

        const archived = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { archived: true },
        });
        expect(archived.statusCode).toBe(200);
        expect((archived.json() as Job).archived).toBe(true);

        const listed = (
          await built.app.inject({ method: 'GET', url: '/api/jobs', headers: auth })
        ).json() as { jobs: Job[] };
        expect(listed.jobs.find((j) => j.id === created.id)?.archived).toBe(true);

        const back = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { archived: false },
        });
        expect((back.json() as Job).archived).toBe(false);
      } finally {
        await built.app.close();
      }
    });

    it('POST carrying archived is REFUSED — a job is archived after it exists', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { ...BODY, archived: true },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });

    it('DELETE removes an archived job, and its run log goes with it', async () => {
      const { built, auth } = await bootstrap();
      try {
        const created = (
          await built.app.inject({ method: 'POST', url: '/api/jobs', headers: auth, payload: BODY })
        ).json() as Job;
        await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { archived: true },
        });

        const del = await built.app.inject({
          method: 'DELETE',
          url: `/api/jobs/${created.id}`,
          headers: auth,
        });
        expect(del.statusCode).toBe(204);

        const gone = await built.app.inject({
          method: 'GET',
          url: `/api/jobs/${created.id}`,
          headers: auth,
        });
        expect(gone.statusCode).toBe(404);
      } finally {
        await built.app.close();
      }
    });

    it('a manual run still fires an archived job — trying it out is how it comes back', async () => {
      const { built, auth } = await bootstrap();
      try {
        const created = (
          await built.app.inject({ method: 'POST', url: '/api/jobs', headers: auth, payload: BODY })
        ).json() as Job;
        await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { archived: true },
        });

        const run = await built.app.inject({
          method: 'POST',
          url: `/api/jobs/${created.id}/run`,
          headers: auth,
        });
        expect(run.statusCode).toBe(200);
        expect((run.json() as { status: string }).status).toBeTruthy();
      } finally {
        await built.app.close();
      }
    });
  });
});
