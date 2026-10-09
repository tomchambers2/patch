// Server-side daemon-link bridge for `patch.jobs.request` events.
//
// Group 10 BLOCKER B.8: the host's MCP child invokes `patch_job_*` tools
// that hit the host UDS, which in turn calls `RemoteJobsStore` — that
// store sends `patch.jobs.request` upstream. This bridge:
//
//   1. Listens for inbound `patch.jobs.request` on the daemon-link.
//   2. Maps the op onto the server's persistent JobsInterface (JobStore).
//   3. Emits `patch.jobs.response` back via daemonLink.send.
//
// NO FALLBACK: zod-schema rejections produce `invalid_input`; missing jobs
// produce `not_found`; everything else is `internal` (logged with stack).

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import { JobCreateBody, JobPatchBody } from '@patch/wire/jobs';
import type { DaemonLink } from '../daemon-link.js';
import { JOB_ID_REGEX, type JobLogs } from './logs.js';
import { JobValidationError } from './validate.js';
import type { JobsInterface } from './types.js';

const BRIDGE_SURFACE_ID = 'jobs-rpc-bridge';

export interface AttachOptions {
  link: DaemonLink;
  jobs: JobsInterface;
  logs: JobLogs;
  logger: Logger;
}

export function attachJobsRpcBridge(opts: AttachOptions): () => void {
  const { link, jobs, logs, logger } = opts;
  const unsub = link.onEvent((event, fromDaemonId) => {
    if (event.type !== 'patch.jobs.request') return;
    // The response MUST go back to the machine that asked. `patch.jobs.response`
    // carries neither `daemonId` nor `chatId`, so `DaemonLink.routeOf()` would
    // fall through to the account's HOME machine — every request from any other
    // host then hung until its 10s client timeout. `fromDaemonId` is the
    // requester, and `sendTo` addresses it directly.
    if (fromDaemonId === null) {
      logger.error(
        { requestId: event.requestId, op: event.op },
        'jobs-rpc-bridge: request with no originating machine; dropping (cannot route a reply)',
      );
      return;
    }
    handle(event, jobs, logs, link, logger, fromDaemonId);
  });
  return unsub;
}

function handle(
  event: Extract<WireEvent, { type: 'patch.jobs.request' }>,
  jobs: JobsInterface,
  logs: JobLogs,
  link: DaemonLink,
  logger: Logger,
  fromDaemonId: string,
): void {
  const reply = (
    ok: boolean,
    result?: unknown,
    error?: { code: 'not_found' | 'invalid_input' | 'internal' | 'offline'; message: string },
  ): void => {
    const response: WireEvent = ok
      ? { type: 'patch.jobs.response', requestId: event.requestId, ok: true, result }
      : {
          type: 'patch.jobs.response',
          requestId: event.requestId,
          ok: false,
          // Defensive: every `reply(false, ...)` call site in this file
          // passes an explicit third argument, so this fallback is
          // unreachable given the current implementation — it only guards
          // the (optional-per-the-type-signature) case of a future call
          // site forgetting to.
          /* v8 ignore next */
          error: error ?? { code: 'internal', message: 'unknown' },
        };
    link.sendTo(fromDaemonId, BRIDGE_SURFACE_ID, response);
  };

  try {
    switch (event.op) {
      case 'list': {
        reply(true, jobs.list());
        return;
      }
      case 'get': {
        if (!event.jobId)
          return reply(false, undefined, { code: 'invalid_input', message: 'missing jobId' });
        reply(true, jobs.get(event.jobId));
        return;
      }
      case 'create': {
        const parsed = JobCreateBody.safeParse(event.body);
        if (!parsed.success) {
          return reply(false, undefined, {
            code: 'invalid_input',
            message: parsed.error.message,
          });
        }
        reply(true, jobs.create(parsed.data));
        return;
      }
      case 'patch': {
        if (!event.jobId)
          return reply(false, undefined, { code: 'invalid_input', message: 'missing jobId' });
        const parsed = JobPatchBody.safeParse(event.body);
        if (!parsed.success) {
          return reply(false, undefined, {
            code: 'invalid_input',
            message: parsed.error.message,
          });
        }
        if (!jobs.get(event.jobId)) {
          return reply(false, undefined, {
            code: 'not_found',
            message: `job not found: ${event.jobId}`,
          });
        }
        reply(true, jobs.patch(event.jobId, parsed.data));
        return;
      }
      case 'delete': {
        if (!event.jobId)
          return reply(false, undefined, { code: 'invalid_input', message: 'missing jobId' });
        const ok = jobs.delete(event.jobId);
        if (!ok) {
          return reply(false, undefined, {
            code: 'not_found',
            message: `job not found: ${event.jobId}`,
          });
        }
        reply(true, true);
        return;
      }
      case 'enable': {
        if (!event.jobId)
          return reply(false, undefined, { code: 'invalid_input', message: 'missing jobId' });
        if (!jobs.get(event.jobId)) {
          return reply(false, undefined, {
            code: 'not_found',
            message: `job not found: ${event.jobId}`,
          });
        }
        reply(true, jobs.enable(event.jobId));
        return;
      }
      case 'disable': {
        if (!event.jobId)
          return reply(false, undefined, { code: 'invalid_input', message: 'missing jobId' });
        if (!jobs.get(event.jobId)) {
          return reply(false, undefined, {
            code: 'not_found',
            message: `job not found: ${event.jobId}`,
          });
        }
        reply(true, jobs.disable(event.jobId));
        return;
      }
      case 'runs': {
        if (!event.jobId || !JOB_ID_REGEX.test(event.jobId)) {
          return reply(false, undefined, { code: 'invalid_input', message: 'invalid jobId' });
        }
        const limit = event.limit ?? 50;
        reply(true, logs.readRuns(event.jobId, limit));
        return;
      }
      case 'webhooks': {
        if (!event.jobId || !JOB_ID_REGEX.test(event.jobId)) {
          return reply(false, undefined, { code: 'invalid_input', message: 'invalid jobId' });
        }
        const limit = event.limit ?? 50;
        reply(true, logs.readWebhooks(event.jobId, limit));
        return;
      }
      default: {
        // Exhaustiveness — a schema-side missed case ends up here.
        const _exhaustive: never = event.op;
        void _exhaustive;
        reply(false, undefined, {
          code: 'invalid_input',
          message: `unknown op: ${String(event.op)}`,
        });
      }
    }
  } catch (err) {
    // Semantic validation failures (bad cron / JSONata) from JobStore are a
    // caller problem, not a server fault — surface as invalid_input so the
    // creating agent gets a clear rejection (parity with REST 400).
    if (err instanceof JobValidationError) {
      return reply(false, undefined, { code: 'invalid_input', message: err.message });
    }
    logger.error(
      { err: (err as Error).message, op: event.op, requestId: event.requestId },
      'jobs-rpc-bridge: handler threw',
    );
    reply(false, undefined, { code: 'internal', message: (err as Error).message });
  }
}
