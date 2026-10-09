// spec/08 § Cron: the expression is stored exactly as authored and evaluated
// in `trigger.timezone` (absent → UTC).
//
// This file is the regression proof for the reported bug: "9am jobs fire at
// 10am during BST". The scheduler used to hardcode `{ timezone: 'UTC' }`, so
// `0 9 * * *` meant 09:00 UTC = 10:00 London wall-clock every summer. The DST
// block below drives REAL node-cron and asserts the fire instant moves with
// the zone: 08:00 UTC in summer, 09:00 UTC in winter — the same 9am to a
// person in London, which is the whole point.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import cron, { type ScheduledTask } from 'node-cron';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { JobStore } from '../src/jobs/store.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { CronScheduler } from '../src/jobs/cron.js';
import { assertValidJobBody, JobValidationError } from '../src/jobs/validate.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import type { JobCreateBody, JobPatchBody } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

// 2026 UK DST: BST runs 29 Mar → 25 Oct. These two instants sit safely either
// side, so the offset difference is unambiguous.
const SUMMER = '2026-07-15T12:00:00Z'; // Europe/London = UTC+1
const WINTER = '2026-01-15T12:00:00Z'; // Europe/London = UTC+0

// A spawn action names its host and carries exactly one first turn — a body
// missing the prompt is refused for THAT reason, which would mask the
// timezone assertions on the REST route.
const ACTION = { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' } as const;

/** Wire up the store/dispatcher/logs a CronScheduler needs. */
function makeDeps(dir: string): { jobs: JobStore; dispatcher: JobDispatcher; logs: JobLogs } {
  const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
  const logs = new JobLogs(dir);
  const dispatcher = new JobDispatcher({
    dataDir: dir,
    daemonLink: new InProcessDaemonLink(),
    logger: silentLogger,
    logs: new JobLogs(dir),
  });
  return { jobs, dispatcher, logs };
}

describe('cron timezone reaches the scheduler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands node-cron the job's own zone", () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const seen: Array<{ expr: string; timezone: string | undefined }> = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((expr: string, _cb: unknown, opts: { timezone?: string }) => {
        seen.push({ expr, timezone: opts.timezone });
        return { stop: () => undefined } as unknown as ScheduledTask;
      }) as unknown as typeof cron.schedule,
    });
    scheduler.start();
    jobs.create({
      name: 'daily email update',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    expect(seen).toEqual([{ expr: '0 9 * * *', timezone: 'Europe/London' }]);
    scheduler.stop();
  });

  it('stores the expression EXACTLY as authored — no rewrite into UTC', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: (() =>
        ({ stop: () => undefined }) as unknown as ScheduledTask) as unknown as typeof cron.schedule,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'daily email update',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    const stored = jobs.get(job.id)!;
    expect(stored.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
    scheduler.stop();
  });

  it("falls back to UTC ONLY when the job carries no zone — a pre-timezone job's instant is unchanged", () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const seen: Array<string | undefined> = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((_e: string, _cb: unknown, opts: { timezone?: string }) => {
        seen.push(opts.timezone);
        return { stop: () => undefined } as unknown as ScheduledTask;
      }) as unknown as typeof cron.schedule,
    });
    scheduler.start();
    jobs.create({
      name: 'legacy',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    });
    expect(seen).toEqual(['UTC']);
    scheduler.stop();
  });

  it('re-registers with the NEW zone when the trigger is patched', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const seen: Array<string | undefined> = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((_e: string, _cb: unknown, opts: { timezone?: string }) => {
        seen.push(opts.timezone);
        return { stop: () => undefined } as unknown as ScheduledTask;
      }) as unknown as typeof cron.schedule,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    });
    jobs.patch(job.id, {
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' },
    });
    expect(seen).toEqual(['UTC', 'America/New_York']);
    scheduler.stop();
  });

  it('surfaces the zone on the registration log line so a mis-zoned job is diagnosable', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const lines: Array<Record<string, unknown>> = [];
    const capturing = {
      info: (obj: Record<string, unknown>, msg: string) => lines.push({ ...obj, msg }),
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    } as unknown as pino.Logger;
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: capturing,
      schedule: (() =>
        ({ stop: () => undefined }) as unknown as ScheduledTask) as unknown as typeof cron.schedule,
    });
    scheduler.start();
    jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    const registered = lines.find((l) => l['msg'] === 'jobs/cron: registered');
    expect(registered?.['timezone']).toBe('Europe/London');
    scheduler.stop();
  });
});

// The zone is only useful if an unresolvable one is refused BEFORE the job is
// persisted — node-cron throws at registration time otherwise, leaving a job
// on disk that looks healthy and never runs. NO FALLBACK: never demote to UTC.
describe('an unresolvable zone is rejected at write time', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('assertValidJobBody names trigger.timezone on a create body', () => {
    const body = {
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
      action: ACTION,
    } as unknown as JobCreateBody;
    expect(() => assertValidJobBody(body)).toThrowError(/invalid IANA timezone: Europe\/Landon/);
    try {
      assertValidJobBody(body);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.timezone');
    }
  });

  it('assertValidJobBody rejects a bare UTC offset — frozen, so it cannot track DST', () => {
    const body = {
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: '+01:00' },
    } as unknown as JobPatchBody;
    expect(() => assertValidJobBody(body)).toThrowError(/invalid IANA timezone/);
  });

  it('assertValidJobBody accepts a real zone and an absent one', () => {
    expect(() =>
      assertValidJobBody({
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      } as unknown as JobPatchBody),
    ).not.toThrow();
    expect(() =>
      assertValidJobBody({
        trigger: { type: 'cron', expression: '0 9 * * *' },
      } as unknown as JobPatchBody),
    ).not.toThrow();
  });

  it('JobStore.create refuses the job, and nothing is persisted', () => {
    const { jobs } = makeDeps(dir);
    expect(() =>
      jobs.create({
        name: 'bad zone',
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
        action: ACTION,
      } as unknown as JobCreateBody),
    ).toThrowError(/invalid IANA timezone/);
    expect(jobs.list()).toHaveLength(0);
  });

  it('JobStore.patch refuses the change and leaves the good zone in place', () => {
    const { jobs } = makeDeps(dir);
    const job = jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    expect(() =>
      jobs.patch(job.id, {
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
      } as unknown as JobPatchBody),
    ).toThrowError(/invalid IANA timezone/);
    expect(jobs.get(job.id)!.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });
});

// The real HTTP surface every client writes through (spec/01 § Jobs API).
// The store-level tests above prove the gate; these prove a client actually
// reaches it, and gets a usable status + message back.
describe('POST/PATCH /api/jobs over the real HTTP route', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-rest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap(): Promise<{
    built: Awaited<ReturnType<typeof buildAll>>;
    auth: { authorization: string };
  }> {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-tz',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-tz',
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

  it('accepts a zoned cron trigger and returns it on the created job', async () => {
    const { built, auth } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'daily email update',
          trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
          action: ACTION,
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { trigger: unknown }).trigger).toEqual({
        type: 'cron',
        expression: '0 9 * * *',
        timezone: 'Europe/London',
      });
    } finally {
      await built.app.close();
    }
  });

  it('400s an unresolvable zone with a message naming it', async () => {
    const { built, auth } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'bad zone',
          trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
          action: ACTION,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/timezone/);
      // Nothing was persisted.
      const list = await built.app.inject({ method: 'GET', url: '/api/jobs', headers: auth });
      expect((list.json() as { jobs: unknown[] }).jobs).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('a trigger with no zone round-trips with no zone', async () => {
    const { built, auth } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'legacy',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: ACTION,
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { trigger: unknown }).trigger).toEqual({
        type: 'cron',
        expression: '0 9 * * *',
      });
    } finally {
      await built.app.close();
    }
  });

  it('PATCH can add a zone to an existing job without touching its expression', async () => {
    const { built, auth } = await bootstrap();
    try {
      const created = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'daily email update',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: ACTION,
        },
      });
      const id = (created.json() as { id: string }).id;
      const patched = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${id}`,
        headers: auth,
        payload: { trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' } },
      });
      expect(patched.statusCode).toBe(200);
      expect((patched.json() as { trigger: unknown }).trigger).toEqual({
        type: 'cron',
        expression: '0 9 * * *',
        timezone: 'Europe/London',
      });
    } finally {
      await built.app.close();
    }
  });
});

// The bug itself, proven against REAL node-cron via the scheduler's real
// registration path (only `cron.schedule` is wrapped, to get a handle on the
// task node-cron actually built).
describe('DST: 0 9 * * * in Europe/London is 9am London all year', () => {
  let dir: string;
  let scheduler: CronScheduler | null = null;
  let task: ScheduledTask | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-'));
  });
  afterEach(() => {
    if (scheduler) scheduler.stop();
    if (task) task.destroy();
    scheduler = null;
    task = null;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Register `expression` (+ optional `timezone`) through the real
   * CronScheduler at the fixed instant `nowIso`, and return the UTC instant
   * node-cron will next fire it.
   */
  function nextRunUtc(nowIso: string, expression: string, timezone?: string): string {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowIso));
    const { jobs, dispatcher, logs } = makeDeps(dir);
    scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((expr: string, cb: () => Promise<void>, opts: { timezone?: string }) => {
        task = cron.schedule(expr, cb, opts);
        return task;
      }) as unknown as typeof cron.schedule,
    });
    scheduler.start();
    jobs.create({
      name: 'daily email update',
      trigger: { type: 'cron', expression, ...(timezone ? { timezone } : {}) },
      action: ACTION,
    });
    const next = task!.getNextRun();
    if (!next) throw new Error('node-cron reported no next run');
    return next.toISOString();
  }

  it('fires at 08:00 UTC in BST — the reported bug, inverted', () => {
    expect(nextRunUtc(SUMMER, '0 9 * * *', 'Europe/London')).toBe('2026-07-16T08:00:00.000Z');
  });

  it('fires at 09:00 UTC in GMT', () => {
    expect(nextRunUtc(WINTER, '0 9 * * *', 'Europe/London')).toBe('2026-01-16T09:00:00.000Z');
  });

  it('a job with NO zone still fires at 09:00 UTC in summer — old behaviour preserved', () => {
    // This is the pre-fix behaviour and it must NOT change: every job stored
    // before the field existed relies on it. It is also exactly why the bug
    // looked like "9am fires at 10am" to a person in London.
    expect(nextRunUtc(SUMMER, '0 9 * * *')).toBe('2026-07-16T09:00:00.000Z');
  });

  it('an explicit UTC zone matches an absent one', () => {
    expect(nextRunUtc(SUMMER, '0 9 * * *', 'UTC')).toBe('2026-07-16T09:00:00.000Z');
  });

  it('a zone on the far side of the world shifts the day, not just the hour', () => {
    // Sanity that the zone is genuinely applied rather than nudged: 09:00 in
    // Auckland (UTC+12 in July) on 16 Jul is 21:00 UTC on 15 Jul.
    expect(nextRunUtc(SUMMER, '0 9 * * *', 'Pacific/Auckland')).toBe('2026-07-15T21:00:00.000Z');
  });
});
