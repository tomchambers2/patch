// RRULE scheduler — `nextOccurrence` (pure) plus the full RecurrenceScheduler
// lifecycle (register, fire, deregister, re-arm, filter), mirroring
// jobs-cron.test.ts's coverage of CronScheduler.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { JobStore } from '../src/jobs/store.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import {
  RecurrenceScheduler,
  nextOccurrence,
  InvalidRecurrenceError,
} from '../src/jobs/recurrence.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { hostConfirms } from './host-answer.js';

const silentLogger = pino({ level: 'silent' });

describe('nextOccurrence', () => {
  it('computes "every 3rd Sunday, May through August at 9am" correctly', () => {
    const rrule = 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0';
    const after = new Date('2026-09-18T12:00:00Z');
    const next = nextOccurrence(rrule, 'Europe/London', after);
    expect(next).not.toBeNull();
    // 3rd Sunday of May 2027 is the 16th; 9am BST is 08:00 UTC.
    expect(next?.toISOString()).toBe('2027-05-16T08:00:00.000Z');
  });

  it('tracks a DST spring-forward transition (Europe/London, 29 Mar 2026)', () => {
    const rrule = 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0';
    // The Sunday immediately before the transition.
    const beforeTransition = nextOccurrence(
      rrule,
      'Europe/London',
      new Date('2026-03-20T00:00:00Z'),
    );
    expect(beforeTransition?.toISOString()).toBe('2026-03-22T09:00:00.000Z'); // still GMT (UTC+0)
    // The following Sunday is 29 Mar 2026 — the day BST starts (clocks go
    // forward at 1am). 9am local is now 8am UTC, not 9am.
    const afterTransition = nextOccurrence(
      rrule,
      'Europe/London',
      new Date(beforeTransition!.getTime() + 1000),
    );
    expect(afterTransition?.toISOString()).toBe('2026-03-29T08:00:00.000Z'); // now BST (UTC+1)
  });

  it('returns null when the rule has no future occurrences (UNTIL in the past)', () => {
    const rrule = 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;UNTIL=20200201T000000Z';
    const next = nextOccurrence(rrule, 'Europe/London', new Date('2026-09-18T12:00:00Z'));
    expect(next).toBeNull();
  });

  it('throws InvalidRecurrenceError for a rule rrule cannot parse', () => {
    expect(() =>
      nextOccurrence('FREQ=BOGUS', 'Europe/London', new Date('2026-09-18T12:00:00Z')),
    ).toThrow(InvalidRecurrenceError);
    expect(() =>
      nextOccurrence('this is not an rrule at all', 'Europe/London', new Date()),
    ).toThrow(InvalidRecurrenceError);
  });
});

function recurrenceTrigger(
  rrule: string,
  timezone = 'Europe/London',
): {
  type: 'recurrence';
  rrule: string;
  timezone: string;
} {
  return { type: 'recurrence', rrule, timezone };
}

describe('RecurrenceScheduler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-recurrence-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers + fires + re-arms + deregisters a recurrence job', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const logs = new JobLogs(dir);
    const registrations: string[] = [];
    const tasks = new Map<string, () => Promise<void>>();
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      registerTimer: (jobId, _fireAtMs, cb) => {
        registrations.push(jobId);
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();

    const job = jobs.create({
      name: 'weekly-sunday',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'gm at {{payload.firedAt}}',
      },
    });
    expect(tasks.has(job.id)).toBe(true);
    // Registered once on create.
    expect(registrations.filter((id) => id === job.id)).toHaveLength(1);

    // Fire it.
    await tasks.get(job.id)!();

    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();

    hostConfirms(link);
    const runsLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    const entry = JSON.parse(runsLog.split('\n')[0]!);
    expect(entry.status).toBe('ok');
    expect(entry.trigger).toBe('recurrence');

    // Firing re-arms: a second registration for the same job, for its next
    // occurrence (the whole point — rrule has no ticking primitive of its own).
    expect(registrations.filter((id) => id === job.id)).toHaveLength(2);
    expect(tasks.has(job.id)).toBe(true);

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
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: (jobId, _fireAtMs, cb) => {
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'x',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    jobs.disable(job.id);
    expect(tasks.has(job.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a non-recurrence trigger job is left alone by the scheduler (no timer, no crash)', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const registrations: string[] = [];
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: (jobId) => {
        registrations.push(jobId);
        return () => undefined;
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'cron-job',
      trigger: { type: 'cron', expression: '0 7 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
    });
    expect(registrations).not.toContain(job.id);
    expect(scheduler.hasLiveTimer(job.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('filter rejection logs filter-rejected, does not dispatch, and re-arms', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const tasks = new Map<string, () => Promise<void>>();
    let registerCount = 0;
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: (jobId, _fireAtMs, cb) => {
        registerCount += 1;
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'gated',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      filter: 'payload.firedAt = "never"',
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    await tasks.get(job.id)!();
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    expect(JSON.parse(log).status).toBe('filter-rejected');
    expect(registerCount).toBe(2); // initial + re-arm after the fire
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('runtime JSONata filter error fails closed and still re-arms', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const tasks = new Map<string, () => Promise<void>>();
    let registerCount = 0;
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: (jobId, _fireAtMs, cb) => {
        registerCount += 1;
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'broken',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      filter: '$assert(false, "boom")',
      action: { type: 'spawn', daemonId: 'd1', folder: '/y' },
    });
    await tasks.get(job.id)!();
    expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    expect(JSON.parse(log).status).toBe('filter-error');
    expect(registerCount).toBe(2);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a dispatcher.dispatch() throw is caught, logged as dispatch-error, and still re-arms', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const tasks = new Map<string, () => Promise<void>>();
    let registerCount = 0;
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: (jobId, _fireAtMs, cb) => {
        registerCount += 1;
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'bad-template',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: '{{#unclosed}}oops' },
    });
    await tasks.get(job.id)!();
    hostConfirms(link);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    const entry = JSON.parse(log);
    expect(entry.status).toBe('dispatch-error');
    expect(entry.trigger).toBe('recurrence');
    expect(registerCount).toBe(2);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('a rule with no future occurrences logs a loud dispatch-error run and never registers a timer', async () => {
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
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      registerTimer: (jobId, _fireAtMs, cb) => {
        tasks.set(jobId, cb);
        return () => tasks.delete(jobId);
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'expired-rule',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;UNTIL=20200201T000000Z'),
      action: { type: 'spawn', daemonId: 'd1', folder: '/y', prompt: 'go' },
    });
    // Never registered — there is nothing to arm a timer for.
    expect(tasks.has(job.id)).toBe(false);
    const log = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
    const entry = JSON.parse(log.split('\n')[0]!);
    expect(entry.status).toBe('dispatch-error');
    expect(entry.trigger).toBe('recurrence');
    expect(entry.error).toMatch(/no future occurrences/);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it('registers with a REAL setTimeout (no registerTimer hook) and hasLiveTimer reflects it', async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'real-timer',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    expect(scheduler.hasLiveTimer(job.id)).toBe(true);
    expect(scheduler.hasLiveTimer('j_never_registered')).toBe(false);
    jobs.disable(job.id);
    expect(scheduler.hasLiveTimer(job.id)).toBe(false);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });

  it("editing a job's rrule re-arms immediately via onChange, not just on the next process restart", async () => {
    const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const link = new InProcessDaemonLink();
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    const seenFireAt = new Map<string, number>();
    const teardowns = new Map<string, () => void>();
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: (jobId, fireAtMs) => {
        seenFireAt.set(jobId, fireAtMs);
        const teardown = (): void => undefined;
        teardowns.set(jobId, teardown);
        return teardown;
      },
    });
    scheduler.start();
    const job = jobs.create({
      name: 'editable',
      trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'),
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    const firstFireAt = seenFireAt.get(job.id);
    expect(firstFireAt).toBeDefined();

    // Change the rule to a different weekday — the fire instant must change
    // immediately, without restarting the process.
    jobs.patch(job.id, { trigger: recurrenceTrigger('FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0') });
    const secondFireAt = seenFireAt.get(job.id);
    expect(secondFireAt).toBeDefined();
    expect(secondFireAt).not.toBe(firstFireAt);

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
    const scheduler = new RecurrenceScheduler({
      jobs,
      dispatcher,
      logs: new JobLogs(dir),
      logger: silentLogger,
      registerTimer: () => () => undefined,
    });
    scheduler.start();
    await expect(scheduler.fireForTesting('j_does_not_exist')).rejects.toThrow(/no such job/);
    scheduler.stop();
    dispatcher.close();
    await jobs.close();
  });
});
