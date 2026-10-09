// Rate-limit policy for the UNTRUSTED webhook ingress routes
// (`/api/webhooks/:jobId`, `/api/webhooks/todoist/:jobId`, and the shared
// `/api/webhooks/todoist`).
//
// The shared Todoist route carries no `:jobId`, so its key degrades to
// `|<ip>` — one bucket per source IP, which is the right shape for a route
// every Todoist event shares — and its 429s are audited on the server logger,
// since no job has been identified at that point.
//
// spec/10-auth.md ## What's trusted vs untrusted, line 151:
//   "Webhook callers (Todoist) | Untrusted. Rate-limit, JSONata-filter,
//    no code exec."
// spec/08-triggers-and-jobs.md ## Logs, line 181:
//   "/data/webhooks/<jobId>.jsonl — every inbound HTTP webhook hit ... including
//    signature failures and filter rejections. The firehose."
//
// Two properties this module exists to hold:
//
//   1. PER-JOB BUCKETS. @fastify/rate-limit's default keyGenerator is the source
//      IP, so a single bucket is shared by every job served on that route. One
//      noisy trigger then 429s every OTHER trigger on the server — a whole-
//      automation-surface denial available to any unauthenticated caller who
//      knows one jobId. The key is therefore `<jobId>|<ip>`: each job gets its
//      own bucket, and a job is still bounded per source IP.
//
//   2. THE 429 IS AUDITED. @fastify/rate-limit short-circuits before the route
//      handler, so a refused inbound left no line in the per-job firehose the
//      spec says holds *every* inbound hit. `errorResponseBuilder` runs on every
//      rejected request, so the audit line is written there.
//
// NO FALLBACK: the audit line is only written for a well-formed jobId that names
// an existing job. A per-job log file belongs to a job that exists — minting one
// for an unknown id would hand an unauthenticated caller a disk-write primitive
// (and the lines would be unreadable anyway, since GET /api/jobs/:id/webhooks
// 404s on an unknown job). Those refusals go to the server logger instead.

import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { JOB_ID_REGEX, type JobLogs, type WebhookLogEntry } from './logs.js';
import type { Job, JobsInterface } from './types.js';

/** Max inbound hits per job per source IP, per window. */
export const INGRESS_RATE_LIMIT_MAX = 60;
export const INGRESS_RATE_LIMIT_WINDOW = '1 minute';

export interface IngressRateLimitDeps {
  jobs: JobsInterface;
  logs: JobLogs;
  logger: Logger;
  nowMs: () => number;
  /** The pseudo-scheme this ingress route records in the firehose. */
  resolveScheme: (job: Job) => WebhookLogEntry['scheme'];
}

function jobIdOf(req: FastifyRequest): string {
  const params = req.params as { jobId?: unknown } | undefined;
  const jobId = params?.jobId;
  return typeof jobId === 'string' ? jobId : '';
}

/** The subset of @fastify/rate-limit's response context this module reads. */
interface RateLimitErrorContext {
  statusCode: number;
  after: string;
}

/**
 * The `config.rateLimit` block for an untrusted webhook ingress route.
 */
export function ingressRateLimit(deps: IngressRateLimitDeps): {
  max: number;
  timeWindow: string;
  keyGenerator: (req: FastifyRequest) => string;
  errorResponseBuilder: (req: FastifyRequest, context: RateLimitErrorContext) => object;
} {
  return {
    max: INGRESS_RATE_LIMIT_MAX,
    timeWindow: INGRESS_RATE_LIMIT_WINDOW,
    keyGenerator: (req) => `${jobIdOf(req)}|${req.ip}`,
    errorResponseBuilder: (req, context) => {
      const jobId = jobIdOf(req);
      const job = JOB_ID_REGEX.test(jobId) ? deps.jobs.get(jobId) : undefined;
      const reason = `rate limited: more than ${INGRESS_RATE_LIMIT_MAX} inbound hits per ${INGRESS_RATE_LIMIT_WINDOW}, retry in ${context.after}`;
      if (job) {
        deps.logs.appendWebhook({
          ts: deps.nowMs(),
          jobId,
          signature: 'none',
          scheme: deps.resolveScheme(job),
          filter: 'n/a',
          status: context.statusCode,
          error: reason,
        });
      } else {
        deps.logger.warn(
          { jobId, ip: req.ip, url: req.url },
          'webhook ingress: rate limited (no job in scope — not written to a per-job log)',
        );
      }
      // @fastify/rate-limit THROWS whatever this returns (index.js:333), so it
      // must be an Error carrying `statusCode` — a plain object loses the code
      // and falls through to the 500 safety net.
      const err = new Error(reason) as Error & { statusCode?: number };
      err.statusCode = context.statusCode;
      return err;
    },
  };
}
