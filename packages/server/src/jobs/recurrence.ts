// RRULE-based scheduler for `recurrence`-trigger jobs.
//
// Mirrors CronScheduler (register, fire, deregister, filter, runs.jsonl
// logging, add/remove/reload lifecycle) in every way except HOW "when's
// next" is computed. `rrule` has no built-in "call me at each occurrence"
// primitive the way node-cron does — cron just re-evaluates its own fixed
// fields on every tick of a wall-clock timer it owns. So this scheduler:
//
//   1. computes the next occurrence strictly after "now" via `RRule.after`;
//   2. arms a single `setTimeout` for that instant;
//   3. re-arms — recomputing from the new "now" — after every fire AND
//      whenever the job changes (same `JobsInterface.onChange` hook
//      CronScheduler subscribes to), so an edit takes effect immediately
//      rather than after a restart.
//
// `RecurrenceTrigger` deliberately carries no DTSTART (see the doc comment
// on it in `@patch/wire/jobs`) — the rule's clock time lives in its own
// BYHOUR/BYMINUTE, and where enumeration STARTS is a scheduler runtime
// concern, not stored state. `RULE_ANCHOR` below is that anchor: any fixed
// date safely in the past works, because `RRule.after(now)` is what actually
// decides the next fire, never the anchor itself.

import rrulePkg from 'rrule';
import type { Logger } from 'pino';
import { evaluateFilter, filterContext, FilterError } from './filter.js';
import type { JobDispatcher } from './dispatcher.js';
import { digestPayload, type JobLogs } from './logs.js';
import { jobFires } from './types.js';
import type { JobsInterface, Job } from './types.js';

const { RRule } = rrulePkg;

/**
 * Anchor DTSTART every `RecurrenceTrigger` rule is enumerated from. Never
 * exposed — `nextOccurrence` always asks for the first occurrence AFTER a
 * caller-given instant, so this only has to predate every real job (it does,
 * by decades) and never has to change.
 */
const RULE_ANCHOR = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/**
 * A `RecurrenceTrigger.rrule` that `rrule`'s own parser rejects (spec/08 §
 * Recurrence). Distinct from "no future occurrences" — one is a broken rule,
 * the other is a rule that worked and ran out; conflating them would make a
 * typo'd RRULE look like a schedule that completed on purpose.
 */
export class InvalidRecurrenceError extends Error {
  constructor(rrule: string, cause: string) {
    super(`invalid RRULE "${rrule}": ${cause}`);
    this.name = 'InvalidRecurrenceError';
  }
}

/**
 * The next occurrence of `rrule` (the bare RRULE value string — no
 * `RRULE:` label, no `DTSTART` line, per `RecurrenceTrigger`'s contract)
 * strictly after `after`, evaluated in `timezone`.
 *
 * Returns null when the rule has no more future occurrences (e.g. an
 * `UNTIL` in the past) — a real, expected outcome, not an error.
 *
 * Throws `InvalidRecurrenceError` for a rule `rrule`'s own parser rejects.
 * NO FALLBACK: this must never be silently treated as "no more
 * occurrences" — one is a rule that is broken, the other a rule that
 * finished; validate.ts is supposed to have already refused the former at
 * write time, so reaching it here (an externally-edited job file) is exactly
 * the same "loud, not silently skipped" case CronScheduler's own
 * `cron.validate()` guard covers for cron.
 */
export function nextOccurrence(rrule: string, timezone: string, after: Date): Date | null {
  let rule: InstanceType<typeof RRule>;
  try {
    const opts = RRule.parseString(rrule);
    rule = new RRule({ ...opts, dtstart: RULE_ANCHOR, tzid: timezone });
  } catch (err) {
    throw new InvalidRecurrenceError(rrule, (err as Error).message);
  }
  return rule.after(after, false);
}

export interface RecurrenceSchedulerOptions {
  jobs: JobsInterface;
  dispatcher: JobDispatcher;
  logs: JobLogs;
  logger: Logger;
  /**
   * Test hook — invoked synchronously instead of arming a real `setTimeout`.
   * Mirrors CronScheduler's `registerTask`: given the job id, the computed
   * next-fire instant (epoch ms) and the fire callback, returns a teardown.
   */
  registerTimer?: (jobId: string, fireAtMs: number, cb: () => Promise<void>) => () => void;
  /** Override clock for log timestamps and "now" in next-occurrence lookups. */
  nowMs?: () => number;
}

export class RecurrenceScheduler {
  private readonly jobs: JobsInterface;
  private readonly dispatcher: JobDispatcher;
  private readonly logs: JobLogs;
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly registerTimer: NonNullable<RecurrenceSchedulerOptions['registerTimer']> | null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly testTimerTeardowns = new Map<string, () => void>();
  private unsub: (() => void) | null = null;

  constructor(opts: RecurrenceSchedulerOptions) {
    this.jobs = opts.jobs;
    this.dispatcher = opts.dispatcher;
    this.logs = opts.logs;
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.registerTimer = opts.registerTimer ?? null;
  }

  start(): void {
    for (const job of this.jobs.list()) this.applyJob(job);
    this.unsub = this.jobs.onChange((event) => {
      if (event.type === 'deleted') {
        this.deregister(event.id);
        return;
      }
      this.applyJob(event.job);
    });
  }

  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    for (const [id] of this.timers) this.deregister(id);
    for (const [id] of this.testTimerTeardowns) this.deregister(id);
  }

  /**
   * True when this job has a real `setTimeout` armed (the live wall-clock
   * path), as opposed to the `registerTimer` test hook. Mirrors
   * CronScheduler.hasLiveTask.
   */
  hasLiveTimer(jobId: string): boolean {
    return this.timers.has(jobId);
  }

  /** Test hook: trigger a job's fire callback as if its timer had elapsed. */
  async fireForTesting(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`fireForTesting: no such job ${jobId}`);
    await this.fire(job);
  }

  private applyJob(job: Job): void {
    this.deregister(job.id);
    // Disabled or archived — one definition of "does this job fire"
    // (spec/08 § Archived jobs).
    if (!jobFires(job)) return;
    if (job.trigger.type !== 'recurrence') return;
    const { rrule, timezone } = job.trigger;

    let next: Date | null;
    try {
      next = nextOccurrence(rrule, timezone, new Date(this.nowMs()));
    } catch (err) {
      // Same shape as CronScheduler's invalid-expression guard: reachable
      // only via an externally-edited job file, since validate.ts refuses a
      // bad RRULE at write time. Refuse registration, don't crash.
      this.logger.error(
        { jobId: job.id, rrule, err: (err as Error).message },
        'jobs/recurrence: invalid RRULE, refusing to register',
      );
      return;
    }

    if (next === null) {
      // A rule that has run out (e.g. UNTIL in the past) must not go quiet
      // with no signal anywhere (this is the whole point of a scheduler that
      // re-arms itself rather than ticking forever on its own like cron
      // does) — logged as an error-level server log AND a run-log entry, so
      // it shows up in the job's own history, not just a log line nobody is
      // watching. `dispatch-error` is the closest existing `JobRunStatus` —
      // this is not a filter/gate outcome, and the message says exactly what
      // happened rather than leaving a bare status code to interpret.
      this.logger.error(
        { jobId: job.id, rrule, timezone },
        'jobs/recurrence: no future occurrences — this job will never fire again',
      );
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: job.id,
        status: 'dispatch-error',
        trigger: 'recurrence',
        error: 'no future occurrences for this RRULE — job will never fire again',
      });
      return;
    }

    const cb = async (): Promise<void> => {
      await this.fire(job);
    };
    const fireAtMs = next.getTime();
    if (this.registerTimer) {
      const teardown = this.registerTimer(job.id, fireAtMs, cb);
      this.testTimerTeardowns.set(job.id, teardown);
      return;
    }
    const delayMs = Math.max(0, fireAtMs - this.nowMs());
    const timer = setTimeout(() => {
      void cb();
    }, delayMs);
    this.timers.set(job.id, timer);
    this.logger.info(
      { jobId: job.id, rrule, timezone, nextFireAt: next.toISOString() },
      'jobs/recurrence: registered',
    );
  }

  private deregister(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    const teardown = this.testTimerTeardowns.get(jobId);
    if (teardown) {
      teardown();
      this.testTimerTeardowns.delete(jobId);
    }
  }

  private async fire(job: Job): Promise<void> {
    // Re-resolve the job from the store at fire time so a mid-flight update
    // doesn't race the timer.
    const live = this.jobs.get(job.id);
    if (!live || !jobFires(live)) return;
    // Per spec/08 ## Filter: all trigger types share one root model whose
    // `payload` key holds the trigger data. Recurrence's trigger data is
    // `{ firedAt }`, same shape as cron's (spec/08 § Recurrence).
    const payload = filterContext(this.nowMs(), { firedAt: new Date(this.nowMs()).toISOString() });
    let passed: boolean;
    try {
      passed = await evaluateFilter(live.filter, payload);
    } catch (err) {
      /* v8 ignore next */
      const message = err instanceof FilterError ? err.message : String(err);
      this.logger.error(
        { jobId: live.id, err: message },
        'jobs/recurrence: filter error, fail-closed (skipping run)',
      );
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: live.id,
        status: 'filter-error',
        trigger: 'recurrence',
        payloadDigest: digestPayload(payload),
        error: message,
      });
      // Re-arm regardless of outcome: the fire already happened, and the
      // schedule must keep advancing to its NEXT occurrence rather than
      // dying on the first filtered/failed one.
      this.applyJob(live);
      return;
    }
    if (!passed) {
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: live.id,
        status: 'filter-rejected',
        trigger: 'recurrence',
        payloadDigest: digestPayload(payload),
      });
      this.applyJob(live);
      return;
    }
    try {
      // The dispatcher writes this fire's run entry when its host answers —
      // `chat.spawned` → `ok` with the real chatId, the host's own error →
      // `dispatch-error` naming it (spec/08 ## Execution model step 6).
      this.dispatcher.dispatch(live, payload, 'recurrence');
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error({ jobId: live.id, err: message }, 'jobs/recurrence: dispatch threw');
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: live.id,
        status: 'dispatch-error',
        trigger: 'recurrence',
        payloadDigest: digestPayload(payload),
        error: message,
      });
    }
    this.applyJob(live);
  }
}
