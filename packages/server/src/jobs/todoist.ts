// Todoist webhook ingress.
//
// TWO endpoints, per spec/08-triggers-and-jobs.md ## Todoist:
//
//   POST /api/webhooks/todoist          — the SHARED ingress. A Todoist app has
//     exactly ONE callback URL, so per-job URLs cap the whole server at a single
//     Todoist job (every new subscription would rotate the URL in the app
//     console and break the previous one). This route verifies the HMAC once
//     against TODOIST_WEBHOOK_SECRET (the app's client secret, from the server
//     env) and FANS OUT: every enabled todoist-trigger job has its own filter
//     evaluated against the same payload, and each job that passes dispatches
//     its own action. One inbound event fires zero, one, or several jobs.
//
//   POST /api/webhooks/todoist/:jobId   — the legacy/per-job form, unchanged. It
//     verifies against the job's OWN `trigger.clientSecret` and fires only that
//     job. Kept working for subscriptions already wired to a per-job URL, and
//     for a job driven by a different Todoist app.
//
// Todoist signs the raw JSON body with HMAC-SHA256 keyed on the client secret,
// base64-encoded in `X-Todoist-Hmac-SHA256`.
//
// Per spec/08 ## Todoist + spec/18 ## Server we use the
// `@doist/todoist-api-typescript` client for outbound REST calls; the
// webhook itself is plain HTTP and is verified here.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { evaluateFilter, filterContext, FilterError } from './filter.js';
import { digestPayload, JOB_ID_REGEX, type JobLogs } from './logs.js';
import { ingressRateLimit } from './ingress-rate-limit.js';
import type { JobDispatcher } from './dispatcher.js';
import { jobFires, jobInertReason } from './types.js';
import type { Job, JobsInterface } from './types.js';

export interface TodoistIngressDeps {
  jobs: JobsInterface;
  dispatcher: JobDispatcher;
  logs: JobLogs;
  logger: Logger;
  /**
   * The Todoist app's client secret (`TODOIST_WEBHOOK_SECRET`), used by the
   * SHARED ingress. Absent means the shared route refuses every request — it
   * never degrades to accepting unverified posts.
   */
  webhookSecret?: string | undefined;
  nowMs?: () => number;
}

/** One job's outcome from a single inbound event. */
interface FanoutResult {
  jobId: string;
  status: string;
  fireId?: string;
}

const BODY_LIMIT = 64 * 1024;

function safeEqualBase64(a: string, b: string): boolean {
  let ab: Buffer;
  let bb: Buffer;
  try {
    ab = Buffer.from(a, 'base64');
    bb = Buffer.from(b, 'base64');
    // Defensive: Node's Buffer.from(str, 'base64') never throws (it decodes
    // leniently), so this catch is unreachable in practice.
    /* v8 ignore next 3 */
  } catch {
    return false;
  }
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The bytes the signature covers. Falls back to empty when the custom JSON
 * parser did not run (a non-`application/json` content-type never sets
 * `rawBody`), which is what the sender then has to have signed.
 */
function rawBodyOf(req: FastifyRequest): Buffer {
  return (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
}

function signatureOf(req: FastifyRequest): string | undefined {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const sigHeader = headers['x-todoist-hmac-sha256'];
  // Defensive: Node's http server joins duplicate occurrences of a
  // non-list header (this isn't `set-cookie`) into a single
  // comma-separated string, so `sigHeader` is never actually an array in
  // practice — this only guards a theoretical alternate transport.
  /* v8 ignore next */
  return Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
}

/**
 * Evaluate one job's filter against an ALREADY-VERIFIED payload and dispatch
 * its action if it passes, writing that job's own webhooks.jsonl + runs.jsonl
 * lines either way. Shared by both routes, so per-job observability is
 * identical whether the event arrived on the shared URL or a per-job one.
 */
async function evaluateAndDispatch(
  job: Job,
  payload: { payload: unknown },
  deps: TodoistIngressDeps,
  nowMs: () => number,
): Promise<FanoutResult> {
  const jobId = job.id;
  const kind = job.trigger.type === 'todoist' ? 'todoist' : 'webhook';
  let passed: boolean;
  try {
    passed = await evaluateFilter(job.filter, payload);
  } catch (err) {
    // Defensive: evaluateFilter's contract (jobs/filter.ts) always wraps
    // both its parse and evaluate failure paths in FilterError, so the
    // String(err) fallback is unreachable given the current
    // implementation — kept as a guard against that contract changing.
    /* v8 ignore next */
    const message = err instanceof FilterError ? err.message : String(err);
    deps.logs.appendWebhook({
      ts: nowMs(),
      jobId,
      signature: 'ok',
      scheme: 'todoist',
      filter: 'error',
      status: 200,
      error: message,
    });
    deps.logs.appendRun({
      ts: nowMs(),
      jobId,
      status: 'filter-error',
      trigger: kind,
      payloadDigest: digestPayload(payload),
      error: message,
    });
    return { jobId, status: 'filter-error' };
  }
  if (!passed) {
    deps.logs.appendWebhook({
      ts: nowMs(),
      jobId,
      signature: 'ok',
      scheme: 'todoist',
      filter: 'reject',
      status: 200,
    });
    deps.logs.appendRun({
      ts: nowMs(),
      jobId,
      status: 'filter-rejected',
      trigger: kind,
      payloadDigest: digestPayload(payload),
    });
    return { jobId, status: 'filter-rejected' };
  }
  // Run entry comes from the host's own answer — see the dispatcher
  // (spec/08 ## Execution model step 6).
  const result = deps.dispatcher.dispatch(job, payload, kind);
  deps.logs.appendWebhook({
    ts: nowMs(),
    jobId,
    signature: 'ok',
    scheme: 'todoist',
    filter: 'pass',
    status: 200,
  });
  return { jobId, status: result.status, fireId: result.id };
}

export function registerTodoistRoutes(app: FastifyInstance, deps: TodoistIngressDeps): void {
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const rateLimit = ingressRateLimit({
    jobs: deps.jobs,
    logs: deps.logs,
    logger: deps.logger,
    nowMs,
    resolveScheme: () => 'todoist',
  });

  // ---- SHARED ingress: one URL for the whole Todoist app, fans out. ----
  //
  // Registered as a STATIC path, so find-my-way prefers it over the parametric
  // `/api/webhooks/:jobId` that would otherwise swallow `/api/webhooks/todoist`
  // as a (malformed) jobId.
  //
  // The rate-limit bucket degrades to per-source-IP here: there is no `:jobId`
  // param, so the key is `|<ip>`. That is the right shape for a route every
  // Todoist event shares, and a 429 is audited on the server logger (no per-job
  // line, since no job has been identified yet).
  app.post(
    '/api/webhooks/todoist',
    { bodyLimit: BODY_LIMIT, config: { rateLimit } },
    async (req, reply) => {
      const sig = signatureOf(req);
      const raw = rawBodyOf(req);
      // Two kinds of subscriber share this URL. Ordinary webhook jobs with the
      // `todoist` scheme carry their own secret and are verified against it;
      // legacy `todoist`-type jobs are verified against the server env secret.
      const envSecret = deps.webhookSecret;
      const hooks = deps.jobs
        .list()
        .filter(
          (j) => j.trigger.type === 'webhook' && j.trigger.scheme === 'todoist' && jobFires(j),
        );
      const legacy = deps.jobs.list().filter((j) => j.trigger.type === 'todoist' && jobFires(j));
      const hasSecret = hooks.some((j) => j.trigger.type === 'webhook' && j.trigger.secret);
      if (!envSecret && !hasSecret) {
        // NO FALLBACK: nothing configured to verify against refuses rather
        // than accepting unverified posts (spec/08 § Shared ingress).
        deps.logger.error(
          { ip: req.ip },
          'todoist: refused — no todoist webhook secret configured, cannot verify the signature',
        );
        return reply.code(503).send({ error: 'TODOIST_WEBHOOK_SECRET not configured' });
      }
      if (!sig) {
        deps.logger.warn({ ip: req.ip }, 'todoist (shared): missing signature header');
        return reply.code(401).send({ error: 'missing x-todoist-hmac-sha256' });
      }
      const matches = (secret: string | undefined): boolean =>
        !!secret && safeEqualBase64(sig, createHmac('sha256', secret).update(raw).digest('base64'));
      const targets: Job[] = [
        ...hooks.filter((j) => j.trigger.type === 'webhook' && matches(j.trigger.secret)),
        ...(matches(envSecret) ? legacy : []),
      ];
      const anyVerified = targets.length > 0 || matches(envSecret);
      if (!anyVerified) {
        deps.logger.warn({ ip: req.ip }, 'todoist (shared): signature rejected');
        return reply.code(401).send({ error: 'signature rejected' });
      }
      const payload = filterContext(nowMs(), req.body as unknown);
      const results: FanoutResult[] = [];
      for (const job of targets) {
        results.push(await evaluateAndDispatch(job, payload, deps, nowMs));
      }
      return reply.code(200).send({ results });
    },
  );

  // ---- LEGACY per-job ingress: verifies against the job's own clientSecret. ----
  app.post<{ Params: { jobId: string } }>(
    '/api/webhooks/todoist/:jobId',
    {
      bodyLimit: BODY_LIMIT,
      config: {
        // Per-job bucket + an audit line on every 429 — see
        // jobs/ingress-rate-limit.ts (spec/10 line 151, spec/08 line 181).
        rateLimit,
      },
    },
    async (req, reply) => {
      const jobId = req.params.jobId;
      if (!JOB_ID_REGEX.test(jobId)) {
        return reply.code(400).send({ error: 'invalid jobId' });
      }
      const job = deps.jobs.get(jobId);
      if (!job || job.trigger.type !== 'todoist') {
        // NO per-job log line for an unknown job — see the same guard in
        // jobs/webhooks.ts. appendFileSync would MINT a file in the server data
        // dir for an unauthenticated caller's made-up jobId, and those lines are
        // unreadable afterwards (GET /api/jobs/:id/webhooks 404s). Audited on
        // the server logger instead; the 404 is unchanged.
        deps.logger.warn(
          { jobId, ip: req.ip },
          'todoist: refused — no such job (or not a todoist trigger)',
        );
        return reply.code(404).send({ error: 'job not found' });
      }
      const inert = jobInertReason(job);
      if (inert) {
        deps.logs.appendWebhook({
          ts: nowMs(),
          jobId,
          signature: 'none',
          scheme: 'todoist',
          filter: 'n/a',
          status: 503,
          error: `job ${inert}`,
        });
        return reply.code(503).send({ error: `job ${inert}` });
      }
      const sig = signatureOf(req);
      const secret = job.trigger.clientSecret;
      const sigFail = (reason: string): void => {
        deps.logs.appendWebhook({
          ts: nowMs(),
          jobId,
          signature: 'fail',
          scheme: 'todoist',
          filter: 'n/a',
          status: 401,
          error: reason,
        });
      };
      if (!secret) {
        sigFail('job missing clientSecret');
        return reply.code(401).send({ error: 'job missing clientSecret' });
      }
      if (!sig) {
        sigFail('missing x-todoist-hmac-sha256');
        return reply.code(401).send({ error: 'missing x-todoist-hmac-sha256' });
      }
      const expected = createHmac('sha256', secret).update(rawBodyOf(req)).digest('base64');
      if (!safeEqualBase64(sig, expected)) {
        deps.logger.warn({ jobId }, 'todoist: signature rejected');
        sigFail('signature rejected');
        return reply.code(401).send({ error: 'signature rejected' });
      }
      const payload = filterContext(nowMs(), req.body as unknown);
      const outcome = await evaluateAndDispatch(job, payload, deps, nowMs);
      if (outcome.fireId === undefined) {
        return reply.code(200).send({ status: outcome.status });
      }
      return reply.code(200).send({ status: outcome.status, fireId: outcome.fireId });
    },
  );
}
