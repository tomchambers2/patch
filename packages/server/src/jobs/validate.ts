// Semantic validation for job bodies — the SINGLE source of truth shared by
// every CRUD surface (REST `/api/jobs`, the host UDS `/internal/jobs`, the
// cross-chat `patch_job_*` RPC bridge, and direct file edits loaded by the
// store). Zod proves the SHAPE; this proves the SEMANTICS:
//
//   - cron trigger    → the expression is a valid 5-field cron (node-cron).
//   - job filter      → the `filter` JSONata compiles.
//
// Per spec/08 (jobs are a "single source of truth") and the portfolio-wide
// NO-FALLBACKS rule: a bad-cron / bad-JSONata job must be REJECTED at write
// time on every surface, never silently persisted to produce no runs. The
// validation lives in `JobStore.create`/`patch` (the one canonical write
// point) so the two CRUD surfaces can never diverge.

import cron from 'node-cron';
import jsonata from 'jsonata';
import rrulePkg from 'rrule';
import { isValidTimeZone } from '@patch/wire';
import type { JobCreateBody, JobPatchBody, Queueing } from './types.js';

const { RRule } = rrulePkg;

export class JobValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'JobValidationError';
  }
}

/**
 * Cross-field rules for a job's queueing (spec/08 § Queueing), checked on the
 * job AS IT WILL BE STORED so a patch that changes only the action is still
 * held to them. NO FALLBACK: a combination that cannot mean one thing is
 * refused rather than resolved in favour of either field.
 */
export function assertValidQueueing(job: {
  queueing?: Queueing | null;
  concurrency?: number | null;
  action: { type: string };
}): void {
  const q = job.queueing;
  if (q === undefined || q === null) return;
  if (job.concurrency !== undefined && job.concurrency !== null) {
    throw new JobValidationError(
      '`queueing` and `concurrency` both set the job limit — use queueing { mode: "queue", concurrency } and drop `concurrency`',
      'queueing',
    );
  }
  if (q.mode === 'append' && job.action.type !== 'continue') {
    throw new JobValidationError(
      `queueing mode "append" delivers into one durable chat, which only a "continue" action has (this action is "${job.action.type}")`,
      'queueing.mode',
    );
  }
}

/**
 * Validate the semantic content of a create/patch body. Throws
 * `JobValidationError` on the first problem (NO FALLBACK). Callers map this to
 * a 400 (REST) / `invalid_input` (RPC bridge) / process-level skip (file load).
 */
export function assertValidJobBody(body: JobCreateBody | JobPatchBody): void {
  const trigger = body.trigger;
  if (trigger && trigger.type === 'cron') {
    // Spec/08 mandates a STANDARD 5-field cron. node-cron.validate() also
    // accepts 6/7-field expressions (with a leading seconds/year field), but
    // those silently mis-schedule under our 5-field assumption — node-cron
    // would treat field 1 as seconds. Reject anything that isn't exactly 5
    // fields BEFORE the validate() check (NO FALLBACK).
    const fieldCount = trigger.expression.trim().split(/\s+/).length;
    if (fieldCount !== 5) {
      throw new JobValidationError(
        `invalid cron expression (expected 5 fields, got ${fieldCount}): ${trigger.expression}`,
        'trigger.expression',
      );
    }
    if (!cron.validate(trigger.expression)) {
      throw new JobValidationError(
        `invalid cron expression: ${trigger.expression}`,
        'trigger.expression',
      );
    }
    // The zone is what node-cron evaluates the expression in. A zone this
    // machine's ICU cannot resolve makes node-cron throw at REGISTRATION
    // time — after the job is already persisted and looking healthy — so
    // refuse it at write time instead. NO FALLBACK: never demote to UTC.
    if (trigger.timezone !== undefined && !isValidTimeZone(trigger.timezone)) {
      throw new JobValidationError(
        `invalid IANA timezone: ${trigger.timezone}`,
        'trigger.timezone',
      );
    }
  }
  if (trigger && trigger.type === 'recurrence') {
    // `timezone` is validated at the schema layer (RecurrenceTrigger.timezone
    // is IanaTimeZone, required, not optional — see @patch/wire/jobs) so
    // there's nothing left to check for it here. The one thing zod's plain
    // `z.string().min(1)` cannot catch is whether `rrule` PARSES — the same
    // role `cron.validate()` plays for a cron expression. `RRule.fromString`
    // parses the bare RRULE value string (no `RRULE:`/`DTSTART`) exactly as
    // the scheduler will (`packages/server/src/jobs/recurrence.ts`), so a rule
    // rejected here is refused at write time rather than persisted looking
    // healthy and then silently refused at registration (NO FALLBACK).
    try {
      RRule.fromString(trigger.rrule);
    } catch (err) {
      throw new JobValidationError(`invalid RRULE: ${(err as Error).message}`, 'trigger.rrule');
    }
  }
  if (typeof body.filter === 'string' && body.filter.length > 0) {
    try {
      jsonata(body.filter);
    } catch (err) {
      throw new JobValidationError(`invalid JSONata (filter): ${(err as Error).message}`, 'filter');
    }
  }
}
