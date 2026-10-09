// Group 9B: cron scheduler — register, fire, deregister, filter.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { JobStore } from '../src/jobs/store.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { CronScheduler } from '../src/jobs/cron.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { hostConfirms } from './host-answer.js';

const silentLogger = pino({ level: 'silent' });

describe('CronScheduler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-cron-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers exactly once even with chokidar watcher running (group 10 MAJOR M5)', async () => {
    // Use the real chokidar watcher (watch: true) so we exercise the
    // self-write coalescing path. Without the M5 fix, the create() emits
    // 'created' AND the watcher fires 'add' → CronScheduler registers
    // twice (logged twice) and could double-fire.
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await jobs.watcherReady;
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const logs = new JobLogs(dir);
    const registrations: string[] = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      registerTask: (jobId, _expr, _cb) => {
        registrations.push(jobId);
        return () => undefined;
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'morning',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work' },
    });
    // Give chokidar time to fire — without the fix it would emit 'add'.
    await new Promise((r) => setTimeout(r, 200));
    expect(registrations.filter((id) => id === job.id)).toHaveLength(1);
    scheduler.stop();
    await jobs.close();
  });

  it('registers + fires + deregisters a cron job', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const logs = new JobLogs(dir);
    const tasks = new Map<string, () => Promise<void>>();
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      registerTask: (jobId, _expr, cb) => {
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();

    const job = jobs.create({
      name: 'morning',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'gm at {{payload.firedAt}}',
      },
    });
    expect(tasks.has(job.id)).toBe(true);

    // Fire it.
    await tasks.get(job.id)!();

    // Daemon-link should have received a chat.spawn_request.
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request') {
      expect(sent.event.folder).toBe('/work');
      // Prefaced with the job's autonomy prompt (spec/08 § Autonomy prompt;
      // default since this job never set `autonomyPrompt`).
      expect(sent.event.prompt).toMatch(/gm at /);
    }

    // runs.jsonl populated.
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const runsLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    expect(runsLog.length).toBeGreaterThan(0);
    const entry = JSON.parse(runsLog.split('\n')[0]!);
    expect(entry.status).toBe('ok');
    expect(entry.trigger).toBe('cron');
    // The run records the chat it dispatched to, so the Schedules UI can link
    // each run to its chat.
    expect(typeof entry.action?.chatId).toBe('string');
    expect(entry.action.chatId.length).toBeGreaterThan(0);

    // Deregister via delete.
    jobs.delete(job.id);
    expect(tasks.has(job.id)).toBe(false);

    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('disabled jobs do not run', async () => {
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
    const job = jobs.create({
      name: 'x',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    jobs.disable(job.id);
    expect(tasks.has(job.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('filter rejection logs filter-rejected and does not dispatch', async () => {
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
    const job = jobs.create({
      name: 'gated',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      filter: 'payload.firedAt = "never"',
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    await tasks.get(job.id)!();
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    expect(JSON.parse(log).status).toBe('filter-rejected');
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('filter sees a plain `now` field (spec/08 § Filter) — a date-bounded condition works with no bespoke start-date field', async () => {
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
    const job = jobs.create({
      name: 'starts-in-the-past-so-fires',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      filter: 'now >= "2000-01-01T00:00:00.000Z"',
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    await tasks.get(job.id)!();
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeDefined();
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('runtime JSONata error fails closed (no dispatch, filter-error logged)', async () => {
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
    // Compiles (passes create-time validation) but THROWS at evaluation —
    // the only way to reach the fire-time filter-error path now that
    // parse-time-broken filters are rejected at create time.
    const job = jobs.create({
      name: 'broken',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      filter: '$assert(false, "boom")',
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    await tasks.get(job.id)!();
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    expect(JSON.parse(log).status).toBe('filter-error');
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('registers with the REAL node-cron scheduler (no registerTask hook) and hasLiveTask reflects it', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    // No `registerTask` here — this exercises the genuine `cron.schedule(...)`
    // path (dispatcher.ts's `this.schedule` default), not the test hook.
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'real-schedule',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    expect(scheduler.hasLiveTask(job.id)).toBe(true);
    // A job using the registerTask test hook (none here) never appears.
    expect(scheduler.hasLiveTask('j_never_registered')).toBe(false);
    // Disabling deregisters the real task too.
    jobs.disable(job.id);
    expect(scheduler.hasLiveTask(job.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('fireForTesting throws for an unknown jobId', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTask: () => () => undefined,
    });
    scheduler.start();
    await expect(scheduler.fireForTesting('j_does_not_exist')).rejects.toThrow(/no such job/);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('fireForTesting drives the real fire() path directly for an existing job', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTask: () => () => undefined,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'direct-fire',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    await scheduler.fireForTesting(job.id);
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeDefined();
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('an invalid cron expression from an externally-edited job file is refused under the REAL scheduler (no registerTask)', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await jobs.watcherReady;
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
    });
    scheduler.start();
    // The store's own semantic gate (validate.ts) refuses a bad cron on
    // create()/patch() — the only way an invalid cron reaches applyJob() is
    // an externally-edited job file, which only goes through zod SHAPE
    // validation (Job.safeParse), not the semantic node-cron check.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    const badJob = {
      id: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'external-bad-cron',
      enabled: true,
      trigger: { type: 'cron', expression: 'not a real cron' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(join(dir, 'jobs', `${badJob.id}.json`), JSON.stringify(badJob, null, 2), 'utf8');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !jobs.get(badJob.id)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(jobs.get(badJob.id)).not.toBeNull();
    // Refused registration — no live task, and no crash.
    expect(scheduler.hasLiveTask(badJob.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a dispatcher.dispatch() throw inside fire() is caught, logged, and recorded as dispatch-error', async () => {
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
    // An unclosed mustache section makes Mustache.render throw synchronously
    // inside JobDispatcher.renderPrompt -> dispatch(), which is the only
    // realistic way to make dispatch() itself throw (rather than swallow).
    const job = jobs.create({
      name: 'bad-template',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: '{{#unclosed}}oops' },
    });
    await tasks.get(job.id)!();
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    const entry = JSON.parse(log);
    expect(entry.status).toBe('dispatch-error');
    expect(entry.trigger).toBe('cron');
    expect(typeof entry.error).toBe('string');
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('start() picks up jobs that already existed in the store before it was constructed', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    // Created BEFORE the scheduler exists — exercises start()'s initial
    // `for (const job of this.jobs.list())` bootstrap loop, not just the
    // onChange subscription used by every other test in this file.
    const job = jobs.create({
      name: 'pre-existing',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    const registrations: string[] = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTask: (jobId) => {
        registrations.push(jobId);
        return () => undefined;
      },
    });
    scheduler.start();
    expect(registrations).toContain(job.id);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a non-cron trigger job is left alone by the scheduler (no task, no crash)', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const registrations: string[] = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTask: (jobId) => {
        registrations.push(jobId);
        return () => undefined;
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'webhook-job',
      trigger: { type: 'webhook', scheme: 'none' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
    });
    expect(registrations).not.toContain(job.id);
    expect(scheduler.hasLiveTask(job.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('stop() deregisters a still-live REAL node-cron task (not just registerTask-hook ones)', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'still-live-on-stop',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    expect(scheduler.hasLiveTask(job.id)).toBe(true);
    // stop() while the real task is still registered — exercises the
    // `for (const [id] of this.tasks) this.deregister(id)` loop in stop().
    scheduler.stop();
    expect(scheduler.hasLiveTask(job.id)).toBe(false);
    dispatcher.close();
    await jobs.close();
  });

  it('fire() re-checks liveness at fire time: a job disabled between schedule and tick does not dispatch', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTask: () => () => undefined,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'disabled-before-tick',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    jobs.disable(job.id);
    await scheduler.fireForTesting(job.id);
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a cron fire against a "message" action omits `folder` from the run log action', async () => {
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
    const job = jobs.create({
      name: 'message-action',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'message', chatId: 'c_manager', prompt: 'ping' },
    });
    await tasks.get(job.id)!();
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    const entry = JSON.parse(log);
    expect(entry.status).toBe('ok');
    expect(entry.action.type).toBe('message');
    expect(entry.action.folder).toBeUndefined();
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a cron fire against an "continue" action includes `folder` in the run log action', async () => {
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
    const job = jobs.create({
      name: 'ensure-action',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'continue', daemonId: 'd1', folder: '/persist', prompt: 'ping' },
    });
    await tasks.get(job.id)!();
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    const entry = JSON.parse(log);
    expect(entry.status).toBe('ok');
    expect(entry.action.type).toBe('continue');
    expect(entry.action.folder).toBe('/persist');
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a buffered dispatch (host offline) is reflected as status:buffered in the run log', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
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
    const job = jobs.create({
      name: 'offline-cron',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    await tasks.get(job.id)!();
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    expect(JSON.parse(log).status).toBe('buffered');
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });
});
