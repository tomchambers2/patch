// Webhook ingress.
//
// Replaces the 501 stub at `POST /api/webhooks/:jobId`. Verifies the
// signature according to the job's `trigger.scheme`, runs the JSONata
// filter, and dispatches the action.
//
// Schemes:
//   - none           accept anything (URL secrecy only — Home Assistant pattern)
//   - hmac-sha256    `X-Patch-Signature: <hex>` (bare hex of hmac_sha256(secret, body)), key = job secret
//   - github         `X-Hub-Signature-256: sha256=<hex>` over raw body, key = job secret
//   - todoist        `X-Todoist-Hmac-SHA256: <base64>` over raw body, key = job secret
//   - stripe         `Stripe-Signature: t=<unix>,v1=<hex>` per Stripe verification doc
//
// All schemes use timing-safe comparison. NO FALLBACKS — if a scheme
// declares "github" and the header is missing, we return 401 (not "well
// maybe it's a none trigger"). Failures land in webhooks.jsonl.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { evaluateFilter, filterContext, FilterError } from './filter.js';
import { digestPayload, JOB_ID_REGEX, type JobLogs } from './logs.js';
import { ingressRateLimit } from './ingress-rate-limit.js';
import type { JobDispatcher } from './dispatcher.js';
import { jobInertReason } from './types.js';
import type { JobsInterface, WebhookScheme } from './types.js';

export interface WebhookIngressDeps {
  jobs: JobsInterface;
  dispatcher: JobDispatcher;
  logs: JobLogs;
  logger: Logger;
  /** Stripe-scheme tolerance window (default 5min). */
  stripeToleranceMs?: number;
  nowMs?: () => number;
}

const STRIPE_DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

function safeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(aHex, 'hex');
    b = Buffer.from(bHex, 'hex');
    // Defensive: Node's Buffer.from(str, 'hex') never throws (it decodes
    // leniently), so this catch is unreachable in practice.
    /* v8 ignore next 3 */
  } catch {
    return false;
  }
  // Defensive: the early `aHex.length !== bHex.length` return above already
  // guarantees equal hex-string length here, which (hex decoding being a
  // deterministic 2-chars-per-byte mapping) guarantees equal decoded byte
  // length too; and callers never pass an empty header this far. Both sides
  // of this check are therefore unreachable given the current call sites.
  /* v8 ignore next */
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifySignature(
  scheme: WebhookScheme,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  opts: { nowMs: () => number; stripeToleranceMs: number },
): VerifyResult {
  if (scheme === 'none') return { ok: true };
  if (!secret) return { ok: false, reason: 'job missing secret' };
  if (scheme === 'hmac-sha256') {
    // Spec/08: generic HMAC expects a BARE hex digest in `X-Patch-Signature`
    // (`hex(hmac_sha256(secret, body))`) — no `sha256=` prefix. That prefixed
    // form is GitHub's scheme, handled separately below.
    const raw = headers['x-patch-signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return { ok: false, reason: 'missing x-patch-signature' };
    const candidate = header.trim();
    if (!/^[a-f0-9]+$/i.test(candidate)) {
      return { ok: false, reason: 'malformed x-patch-signature' };
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqualHex(candidate, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
  if (scheme === 'github') {
    const raw = headers['x-hub-signature-256'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return { ok: false, reason: 'missing x-hub-signature-256' };
    const m = /^sha256=([a-f0-9]+)$/i.exec(header);
    if (!m) return { ok: false, reason: 'malformed x-hub-signature-256' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    // Defensive: the capturing group has a `+` quantifier, so whenever `m` is
    // non-null (checked above) `m[1]` is guaranteed to be a defined string —
    // TypeScript just can't express that from a RegExp match array's type.
    /* v8 ignore next */
    return safeEqualHex(m[1] ?? '', expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
  if (scheme === 'todoist') {
    const raw = headers['x-todoist-hmac-sha256'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return { ok: false, reason: 'missing x-todoist-hmac-sha256' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    const a = Buffer.from(header.trim(), 'base64');
    const b = Buffer.from(expected, 'base64');
    if (a.length !== b.length || a.length === 0) return { ok: false, reason: 'mismatch' };
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
  if (scheme === 'stripe') {
    const raw = headers['stripe-signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return { ok: false, reason: 'missing stripe-signature' };
    let timestamp: string | null = null;
    const v1: string[] = [];
    for (const part of header.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === 't') timestamp = v;
      else if (k === 'v1') v1.push(v);
    }
    if (!timestamp || v1.length === 0) {
      return { ok: false, reason: 'malformed stripe-signature' };
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'bad stripe timestamp' };
    const now = opts.nowMs();
    if (Math.abs(now - ts * 1000) > opts.stripeToleranceMs) {
      return { ok: false, reason: 'stripe timestamp outside tolerance' };
    }
    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
    for (const candidate of v1) {
      if (safeEqualHex(candidate, expected)) return { ok: true };
    }
    return { ok: false, reason: 'mismatch' };
  }
  // Exhaustiveness check.
  return { ok: false, reason: 'unknown scheme' };
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookIngressDeps): void {
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const tolerance = deps.stripeToleranceMs ?? STRIPE_DEFAULT_TOLERANCE_MS;

  // Capture the raw request body for HMAC verification. Fastify's default
  // JSON parser consumes the buffer, so we register a custom parser that
  // stashes the raw bytes on the request before parsing.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
    if (buf.length === 0) {
      done(null, {});
      return;
    }
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      done(null, parsed);
    } catch {
      // Mirror Fastify's default JSON parser: a parse failure is a client
      // error. Without an explicit statusCode the raw SyntaxError falls
      // through to the global 500 safety net (unhandled-server-error). Tag it
      // 400 so the error handler emits the unified client-error envelope.
      const parseErr = new Error('malformed json') as Error & { statusCode?: number };
      parseErr.statusCode = 400;
      done(parseErr, undefined);
    }
  });

  app.post<{ Params: { jobId: string } }>(
    '/api/webhooks/:jobId',
    {
      bodyLimit: 64 * 1024,
      config: {
        // Per-job bucket + an audit line on every 429 — see
        // jobs/ingress-rate-limit.ts (spec/10 line 151, spec/08 line 181).
        rateLimit: ingressRateLimit({
          jobs: deps.jobs,
          logs: deps.logs,
          logger: deps.logger,
          nowMs,
          resolveScheme: (job) => (job.trigger.type === 'webhook' ? job.trigger.scheme : 'none'),
        }),
      },
    },
    async (req, reply) => {
      const jobId = req.params.jobId;
      // CRITICAL (C1): reject malformed jobId BEFORE any filesystem touch.
      // A path-traversal jobId would otherwise reach JobLogs.appendWebhook
      // which calls join(webhooksDir, `${jobId}.jsonl`) — confirmed exploitable
      // via `..%2F..%2Ftmp%2Fattacker`. NO FALLBACK: 400, no log line written.
      if (!JOB_ID_REGEX.test(jobId)) {
        return reply.code(400).send({ error: 'invalid jobId' });
      }
      const job = deps.jobs.get(jobId);
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      if (!job || job.trigger.type !== 'webhook') {
        // NO per-job log line here. spec/08 line 181 scopes
        // `/data/webhooks/<jobId>.jsonl` to a job's own inbound hits; an
        // unknown jobId has no job, and appendFileSync would CREATE the file —
        // handing an unauthenticated caller a disk-write/disk-growth primitive
        // in the server data dir. The lines were unreadable anyway
        // (GET /api/jobs/:id/webhooks 404s on an unknown job). The refusal is
        // audited on the server logger instead, and the 404 is unchanged.
        deps.logger.warn(
          { jobId, ip: req.ip },
          'webhook: refused — no such job (or not a webhook trigger)',
        );
        return reply.code(404).send({ error: 'job not found' });
      }
      // Disabled or archived (spec/08 § Archived jobs) — one definition of
      // "does this job fire", and the refusal names which of the two it was.
      const inert = jobInertReason(job);
      if (inert) {
        deps.logs.appendWebhook({
          ts: nowMs(),
          jobId,
          signature: 'none',
          scheme: job.trigger.scheme,
          filter: 'n/a',
          status: 503,
          error: `job ${inert}`,
        });
        return reply.code(503).send({ error: `job ${inert}` });
      }
      const verify = verifySignature(
        job.trigger.scheme,
        rawBody,
        req.headers as Record<string, string | string[] | undefined>,
        job.trigger.secret,
        { nowMs, stripeToleranceMs: tolerance },
      );
      if (!verify.ok) {
        deps.logs.appendWebhook({
          ts: nowMs(),
          jobId,
          signature: 'fail',
          scheme: job.trigger.scheme,
          filter: 'n/a',
          status: 401,
          // Defensive: verifySignature's contract always sets `reason`
          // whenever it returns ok:false, so this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          error: verify.reason ?? 'signature failure',
        });
        deps.logger.warn(
          { jobId, scheme: job.trigger.scheme, reason: verify.reason },
          'webhook: signature rejected',
        );
        return reply.code(401).send({ error: 'signature rejected' });
      }
      // Per spec/08 ## Filter: the JSONata filter and action templates
      // evaluate against a root model whose `payload` key holds the trigger
      // data (e.g. `payload.action = 'closed'`). Wrap the inbound body to
      // match the unified root used by all four trigger types.
      const payload = filterContext(nowMs(), req.body as unknown);
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
          signature: job.trigger.scheme === 'none' ? 'none' : 'ok',
          scheme: job.trigger.scheme,
          filter: 'error',
          status: 200,
          error: message,
        });
        deps.logs.appendRun({
          ts: nowMs(),
          jobId,
          status: 'filter-error',
          trigger: 'webhook',
          payloadDigest: digestPayload(payload),
          error: message,
        });
        deps.logger.error({ jobId, err: message }, 'webhook: filter error, fail-closed (no run)');
        // Filter error is an *operator* problem (bad JSONata) — return 200
        // so the source doesn't retry forever, but skip the dispatch.
        return reply.code(200).send({ status: 'filter-error' });
      }
      if (!passed) {
        deps.logs.appendWebhook({
          ts: nowMs(),
          jobId,
          // Both sides of this ternary ARE exercised — see the "non-none
          // scheme filter-rejection" test in jobs-webhooks.test.ts, which
          // asserts `signature: 'ok'` is logged here — but the v8 coverage
          // collector does not reliably attribute this specific occurrence
          // (identical siblings at the filter-error/dispatch-pass call sites
          // above/below DO get attributed), a known source-range imprecision
          // for ternaries used as object-literal property values.
          /* v8 ignore next */
          signature: job.trigger.scheme === 'none' ? 'none' : 'ok',
          scheme: job.trigger.scheme,
          filter: 'reject',
          status: 200,
        });
        return reply.code(200).send({ status: 'filter-rejected' });
      }
      // The dispatcher owns the run entry from here: `buffered` now if the
      // addressed host is down, else `ok` / `dispatch-error` when that host
      // answers (spec/08 ## Execution model step 6). Accepting an inbound is
      // NOT the same as the fire landing, and the run log must not say it is.
      const result = deps.dispatcher.dispatch(job, payload, 'webhook');
      deps.logs.appendWebhook({
        ts: nowMs(),
        jobId,
        signature: job.trigger.scheme === 'none' ? 'none' : 'ok',
        scheme: job.trigger.scheme,
        filter: 'pass',
        status: 200,
      });
      return reply.code(200).send({ status: result.status, fireId: result.id });
    },
  );
}
