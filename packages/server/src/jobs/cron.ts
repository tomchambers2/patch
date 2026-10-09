// node-cron scheduler.
//
// Each enabled `cron`-trigger job registers a task that fires the action
// via the JobDispatcher. The scheduler subscribes to JobsInterface.onChange
// and re-registers tasks when jobs are created/updated/deleted/toggled.
//
// Per spec/08 § Cron: a cron expression is stored exactly as authored and
// evaluated in `trigger.timezone`. Absent → UTC, which is what every job
// stored before that field existed relies on. node-cron applies the zone at
// every tick, so a DST transition moves the fire instant correctly — do NOT
// go back to rewriting the expression into UTC at write time.

import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import { evaluateFilter, filterContext, FilterError } from './filter.js';
import type { JobDispatcher } from './dispatcher.js';
import { digestPayload, type JobLogs } from './logs.js';
import { jobFires } from './types.js';
import type { JobsInterface, Job } from './types.js';

export interface CronSchedulerOptions {
  jobs: JobsInterface;
  dispatcher: JobDispatcher;
  logs: JobLogs;
  logger: Logger;
  /** Override for tests (e.g. inject a fake `cron`-like scheduler). */
  schedule?: typeof cron.schedule;
  /**
   * Test hook — invoked synchronously instead of registering a real cron task.
   * `timezone` is the zone the real path would have handed node-cron (the
   * job's own, or `UTC` when it carries none).
   */
  registerTask?: (
    jobId: string,
    expr: string,
    cb: () => Promise<void>,
    timezone: string,
  ) => () => void;
  /** Override clock for log timestamps. */
  nowMs?: () => number;
}

export class CronScheduler {
  private readonly jobs: JobsInterface;
  private readonly dispatcher: JobDispatcher;
  private readonly logs: JobLogs;
  private readonly logger: Logger;
  private readonly schedule: typeof cron.schedule;
  private readonly nowMs: () => number;
  private readonly registerTask: NonNullable<CronSchedulerOptions['registerTask']> | null;
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly testTaskTeardowns = new Map<string, () => void>();
  private unsub: (() => void) | null = null;

  constructor(opts: CronSchedulerOptions) {
    this.jobs = opts.jobs;
    this.dispatcher = opts.dispatcher;
    this.logs = opts.logs;
    this.logger = opts.logger;
    this.schedule = opts.schedule ?? cron.schedule;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.registerTask = opts.registerTask ?? null;
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
    for (const [id] of this.tasks) this.deregister(id);
    for (const [id] of this.testTaskTeardowns) this.deregister(id);
  }

  /**
   * True when this job is registered with a real node-cron task (the live
   * wall-clock scheduler path), as opposed to the `registerTask` test hook.
   * Used by the live-fire e2e to assert it's exercising the genuine path.
   */
  hasLiveTask(jobId: string): boolean {
    return this.tasks.has(jobId);
  }

  /** Test hook: trigger a job's cron callback as if cron had ticked. */
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
    if (job.trigger.type !== 'cron') return;
    const expr = job.trigger.expression;
    // Absent `timezone` === UTC. This is the ONLY place the default is
    // applied — nothing upstream backfills the field, so a pre-timezone job
    // on disk keeps firing at exactly the instant it always did.
    const timezone = job.trigger.timezone ?? 'UTC';
    if (!cron.validate(expr) && !this.registerTask) {
      this.logger.error(
        { jobId: job.id, expression: expr },
        'jobs/cron: invalid cron expression, refusing to register',
      );
      return;
    }
    const cb = async (): Promise<void> => {
      await this.fire(job);
    };
    if (this.registerTask) {
      const teardown = this.registerTask(job.id, expr, cb, timezone);
      this.testTaskTeardowns.set(job.id, teardown);
      return;
    }
    const task = this.schedule(expr, cb, { timezone });
    this.tasks.set(job.id, task);
    this.logger.info({ jobId: job.id, expression: expr, timezone }, 'jobs/cron: registered');
  }

  private deregister(jobId: string): void {
    const task = this.tasks.get(jobId);
    if (task) {
      try {
        task.stop();
        // Defensive: node-cron's ScheduledTask.stop() is not documented to
        // throw under normal use; this guards against a future node-cron
        // version doing so without taking the process down with it.
        /* v8 ignore next 5 */
      } catch {
        /* ignore */
      }
      this.tasks.delete(jobId);
    }
    const teardown = this.testTaskTeardowns.get(jobId);
    if (teardown) {
      teardown();
      this.testTaskTeardowns.delete(jobId);
    }
  }

  private async fire(job: Job): Promise<void> {
    // Re-resolve the job from the store at fire time so a mid-flight update
    // doesn't race the cron tick.
    const live = this.jobs.get(job.id);
    if (!live || !jobFires(live)) return;
    // Per spec/08 ## Filter: all trigger types share one root model whose
    // `payload` key holds the trigger data. Cron's trigger data is
    // `{ firedAt }` (spec line 48), so filters/templates use `payload.firedAt`.
    const payload = filterContext(this.nowMs(), { firedAt: new Date(this.nowMs()).toISOString() });
    let passed: boolean;
    try {
      passed = await evaluateFilter(live.filter, payload);
    } catch (err) {
      // Defensive: evaluateFilter's contract (jobs/filter.ts) always wraps
      // both its parse and evaluate failure paths in FilterError, so the
      // String(err) fallback is unreachable given the current
      // implementation — kept as a guard against that contract changing.
      /* v8 ignore next */
      const message = err instanceof FilterError ? err.message : String(err);
      this.logger.error(
        { jobId: live.id, err: message },
        'jobs/cron: filter error, fail-closed (skipping run)',
      );
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: live.id,
        status: 'filter-error',
        trigger: 'cron',
        payloadDigest: digestPayload(payload),
        error: message,
      });
      return;
    }
    if (!passed) {
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: live.id,
        status: 'filter-rejected',
        trigger: 'cron',
        payloadDigest: digestPayload(payload),
      });
      return;
    }
    try {
      // The dispatcher writes this fire's run entry when its host answers —
      // `chat.spawned` → `ok` with the real chatId, the host's own error →
      // `dispatch-error` naming it (spec/08 ## Execution model step 6).
      this.dispatcher.dispatch(live, payload, 'cron');
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error({ jobId: live.id, err: message }, 'jobs/cron: dispatch threw');
      this.logs.appendRun({
        ts: this.nowMs(),
        jobId: live.id,
        status: 'dispatch-error',
        trigger: 'cron',
        payloadDigest: digestPayload(payload),
        error: message,
      });
    }
  }
}
