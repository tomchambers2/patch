// REST routes for job CRUD. JWT-authed (same scheme as other /api routes).
//
// Rate limiting follows spec/10-auth.md ## What's trusted vs untrusted:
//   line 151 "Webhook callers (Todoist) | Untrusted. Rate-limit ..."
//   line 152 "Phone/web clients | Trusted via server-issued credential."
// The READ routes here are reached only with a verified, non-revoked surface
// credential, i.e. by a trusted client, and a Jobs view polling its runs
// drawer legitimately exceeds a 30/min bucket — it was 429ing against itself.
// They are therefore not rate-limited. The MUTATING routes keep the 30/min
// per-IP bucket (`rl`); the untrusted webhook ingress routes keep theirs (see
// jobs/ingress-rate-limit.ts).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import rrulePkg from 'rrule';
import { verifySurfaceCredential } from '@patch/auth';
import { describeRecurrence } from '@patch/wire';
import type { WireEvent } from '@patch/wire';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import type { DaemonLink } from '../daemon-link.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from '../host-addressing.js';
import { JobCreateBody, JobPatchBody, type JobsInterface } from './types.js';
import { JobLogs } from './logs.js';
import { JOB_ID_REGEX } from './logs.js';
import { JobValidationError } from './validate.js';
import type { JobDispatcher } from './dispatcher.js';

const { RRule } = rrulePkg;

async function requireAuth(req: FastifyRequest, registry: Registry): Promise<void> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
}

export interface JobRoutesDeps {
  logger: Logger;
  registry: Registry;
  jobs: JobsInterface;
  /** Used to validate `action.message.chatId` at create/patch time (DX-M3). */
  chatRegistry?: ChatRegistry;
  /** Used by /api/jobs/:id/runs and /webhooks (DX-M4). */
  jobLogs?: JobLogs;
  /**
   * The concurrency gate's live counts for a job (spec/08 ## Concurrency).
   * Read on both the list and the single-job route so the Jobs view can
   * show a job's backlog per row without a request each. Absent in test wiring
   * that has no dispatcher; the counts are then simply not reported.
   */
  jobCounts?: (jobId: string) => { inFlight: number; queued: number };
  /**
   * Fires a job's action immediately, once, outside its normal trigger
   * (spec/08 ## Manual run). Powers `POST /api/jobs/:id/run`. Absent in test
   * wiring that has no dispatcher — the route then reports 503 rather than
   * silently no-op'ing.
   */
  dispatcher?: JobDispatcher;
  /** Clock override for the manual-run payload timestamp (tests). */
  nowMs?: () => number;
  /**
   * Backs `POST /api/jobs/recurrence/translate` (spec/08 § Recurrence — the
   * job editor's natural-language schedule input): round-trips a
   * `patch.recurrence.translate.request` to the named host, the same way
   * `GET /api/models` round-trips `patch.models.request` (chat-routes.ts).
   * Absent in test wiring that has no daemon-link — the route then reports
   * 503 rather than hanging.
   */
  daemonLink?: DaemonLink;
  /** Generates the request id for the translate round-trip. */
  idGenerator?: () => string;
  /** Override for tests — production default is 25s (the one-shot allows up to 20s). */
  recurrenceTranslateTimeoutMs?: number;
}

/**
 * Attach the gate's live counts to a job as it goes out. These are runtime
 * state, not part of the stored job — `JobPatchBody` is strict and would
 * refuse them coming back, so clients build explicit patch bodies.
 */
function withCounts(
  job: import('./types.js').Job,
  counts: JobRoutesDeps['jobCounts'],
): import('./types.js').JobWithCounts {
  if (!counts) return job;
  return { ...job, ...counts(job.id) };
}

/**
 * A row of the LIST response: the job, its live counts, and its most recent
 * fire. The latest run is runtime state like the counts, and it rides on the
 * list rather than on `GET /api/jobs/:id` because the list is the one place
 * that needs it per row. The single-job response is spec'd as `JobWithCounts`
 * and `JobWithCounts` is `.strict()`, so it stays exactly that.
 */
function asListEntry(
  job: import('./types.js').Job,
  deps: JobRoutesDeps,
): import('./types.js').JobListEntry {
  const withGates = withCounts(job, deps.jobCounts);
  if (!deps.jobLogs) return withGates;
  const run = deps.jobLogs.readLatestRun(job.id);
  if (run === null) return { ...withGates, latestRun: null };
  return {
    ...withGates,
    latestRun: {
      ts: run.ts,
      status: run.status,
      ...(run.action?.chatId === undefined ? {} : { chatId: run.action.chatId }),
    },
  };
}

/** Validate action.message.chatId against the in-process ChatRegistry (DX-M3). */
function validateActionChatId(
  data: { action?: unknown },
  registry: ChatRegistry | undefined,
):
  | { ok: true }
  | { ok: false; transient: true }
  | { ok: false; transient: false; issue: z.ZodIssue } {
  const action = data.action as { type?: string; chatId?: string } | undefined;
  if (!action || action.type !== 'message') return { ok: true };
  // Defensive: every call site passes zod-validated JobCreateBody/
  // JobPatchBody data, where a `message` action's `chatId` is already
  // required to be a non-empty string — this only guards the `unknown`
  // cast above, not a real runtime possibility.
  /* v8 ignore next */
  if (typeof action.chatId !== 'string') return { ok: true };
  // If we don't have a registry to consult (test wiring), skip — the BLOCKER
  // path always wires one through buildAll.
  if (!registry) return { ok: true };
  // If the registry hasn't been seeded yet AND has zero entries, refuse to
  // validate — better to fail closed than silently accept a typo. This is
  // the MAJOR-M3 race-window note: the daemon-link seeds chats on first
  // connect; until that completes, action.chatId must reject. Once it
  // contains anything we trust the gate.
  if (registry.size() === 0) {
    // Transient, not a client error: the daemon-link seeds chats on first
    // connect. Callers map this to a retryable 503 rather than a 400 — the
    // request isn't malformed, the server just isn't ready yet.
    return { ok: false, transient: true };
  }
  if (!registry.get(action.chatId)) {
    return {
      ok: false,
      transient: false,
      issue: {
        code: z.ZodIssueCode.custom,
        path: ['action', 'chatId'],
        message: `action.chatId not found: ${action.chatId}`,
      },
    };
  }
  return { ok: true };
}

export function registerJobRoutes(app: FastifyInstance, deps: JobRoutesDeps): void {
  const rl = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/jobs', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    return reply.code(200).send({ jobs: deps.jobs.list().map((j) => asListEntry(j, deps)) });
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const job = deps.jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return reply.code(200).send(withCounts(job, deps.jobCounts));
  });

  app.post('/api/jobs', rl, async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const parsed = JobCreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const chatGate = validateActionChatId(parsed.data, deps.chatRegistry);
    if (!chatGate.ok) {
      if (chatGate.transient) {
        return reply.code(503).header('retry-after', '2').send({
          error: 'chat registry not seeded yet — the host link is still coming up; retry shortly',
        });
      }
      return reply.code(400).send({ error: 'invalid body', issues: [chatGate.issue] });
    }
    let job;
    try {
      // The store is the single semantic gate (cron / JSONata) shared with the
      // host UDS surface — see jobs/validate.ts.
      job = deps.jobs.create(parsed.data);
    } catch (err) {
      if (err instanceof JobValidationError) {
        return reply.code(400).send({
          error: 'invalid body',
          issues: [
            {
              code: z.ZodIssueCode.custom,
              path: err.field.split('.'),
              message: err.message,
            },
          ],
        });
      }
      throw err;
    }
    deps.logger.info(
      { jobId: job.id, name: job.name, trigger: job.trigger.type, action: job.action.type },
      'jobs: created',
    );
    return reply.code(201).send(job);
  });

  app.patch<{ Params: { id: string } }>('/api/jobs/:id', rl, async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    if (!deps.jobs.get(req.params.id)) {
      return reply.code(404).send({ error: 'job not found' });
    }
    const parsed = JobPatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const chatGate = validateActionChatId(parsed.data, deps.chatRegistry);
    if (!chatGate.ok) {
      if (chatGate.transient) {
        return reply.code(503).header('retry-after', '2').send({
          error: 'chat registry not seeded yet — the host link is still coming up; retry shortly',
        });
      }
      return reply.code(400).send({ error: 'invalid body', issues: [chatGate.issue] });
    }
    let job;
    try {
      job = deps.jobs.patch(req.params.id, parsed.data);
    } catch (err) {
      if (err instanceof JobValidationError) {
        return reply.code(400).send({
          error: 'invalid body',
          issues: [
            {
              code: z.ZodIssueCode.custom,
              path: err.field.split('.'),
              message: err.message,
            },
          ],
        });
      }
      throw err;
    }
    return reply.code(200).send(job);
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', rl, async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const ok = deps.jobs.delete(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'job not found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/enable', rl, async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    if (!deps.jobs.get(req.params.id)) {
      return reply.code(404).send({ error: 'job not found' });
    }
    return reply.code(200).send(deps.jobs.enable(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/disable', rl, async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    if (!deps.jobs.get(req.params.id)) {
      return reply.code(404).send({ error: 'job not found' });
    }
    return reply.code(200).send(deps.jobs.disable(req.params.id));
  });

  // Manual run (spec/08 ## Manual run): fires the job's action once, right
  // now, for trying it out while building/editing without waiting for its
  // real trigger or enabling it first. Reuses the dispatcher's single firing
  // path — indistinguishable from a real fire once sent, except `trigger:
  // 'manual'` on the run entry the dispatcher itself writes.
  app.post<{ Params: { id: string } }>('/api/jobs/:id/run', rl, async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const saved = deps.jobs.get(req.params.id);
    if (!saved) return reply.code(404).send({ error: 'job not found' });
    // Optional `{ draft }`: a patch body fired in place of the saved job,
    // without saving it (spec/08 § Manual run). No body runs the saved job.
    let job = saved;
    const rawBody = req.body as { draft?: unknown } | undefined | null;
    if (rawBody && rawBody.draft !== undefined) {
      const parsed = JobPatchBody.safeParse(rawBody.draft);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      const chatGate = validateActionChatId(parsed.data, deps.chatRegistry);
      if (!chatGate.ok) {
        return reply.code(chatGate.transient ? 503 : 400).send({
          error: chatGate.transient ? 'chat registry not seeded yet' : 'invalid body',
          ...(chatGate.transient ? {} : { issues: [chatGate.issue] }),
        });
      }
      try {
        job = deps.jobs.preview(saved.id, parsed.data);
      } catch (err) {
        if (err instanceof JobValidationError) {
          return reply.code(400).send({
            error: 'invalid body',
            issues: [
              { code: z.ZodIssueCode.custom, path: err.field.split('.'), message: err.message },
            ],
          });
        }
        throw err;
      }
    }
    if (!deps.dispatcher) return reply.code(503).send({ error: 'dispatcher not configured' });
    // Same payload shape a cron fire carries (spec/08 ## Manual run), so an
    // action's mustache template renders the same way it would from a real
    // cron tick. No filter evaluation and no `enabled` check — a manual run
    // is the user directly asking "do the action", not simulating an inbound
    // event a filter should judge, and testing before enabling is the point.
    const nowMs = deps.nowMs ?? ((): number => Date.now());
    const payload = { payload: { firedAt: new Date(nowMs()).toISOString() } };
    try {
      const result = deps.dispatcher.dispatch(job, payload, 'manual');
      return reply.code(200).send({ status: result.status, fireId: result.id });
    } catch (err) {
      deps.logger.error(
        { jobId: job.id, err: (err as Error).message },
        'jobs: manual run dispatch threw',
      );
      return reply.code(502).send({ error: 'dispatch failed', message: (err as Error).message });
    }
  });

  // Group 10 MAJOR (DX-M4): job runs + webhook ingress logs.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/jobs/:id/runs',
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return (
          reply
            // Defensive: requireAuth always throws via its internal generic() helper,
            // which always sets statusCode=401 explicitly — this fallback is unreachable
            // given the current implementation.
            /* v8 ignore next */
            .code((e as Error & { statusCode?: number }).statusCode ?? 401)
            .send({ error: (e as Error).message })
        );
      }
      if (!JOB_ID_REGEX.test(req.params.id)) {
        return reply.code(400).send({ error: 'invalid jobId' });
      }
      // Existence check: a deleted/never-existed job must 404, consistent with
      // the sibling GET/PATCH/DELETE/enable routes above — a client must not
      // mistake a nonexistent job for an empty-but-real one (TH1 H1-d2-3).
      if (!deps.jobs.get(req.params.id)) {
        return reply.code(404).send({ error: 'job not found' });
      }
      if (!deps.jobLogs) return reply.code(503).send({ error: 'job logs not configured' });
      const rawLimit = req.query?.limit;
      const limit = rawLimit ? Math.min(200, Math.max(1, Number(rawLimit) || 50)) : 50;
      return reply.code(200).send({ runs: deps.jobLogs.readRuns(req.params.id, limit) });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/jobs/:id/webhooks',
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return (
          reply
            // Defensive: requireAuth always throws via its internal generic() helper,
            // which always sets statusCode=401 explicitly — this fallback is unreachable
            // given the current implementation.
            /* v8 ignore next */
            .code((e as Error & { statusCode?: number }).statusCode ?? 401)
            .send({ error: (e as Error).message })
        );
      }
      if (!JOB_ID_REGEX.test(req.params.id)) {
        return reply.code(400).send({ error: 'invalid jobId' });
      }
      // Existence check: a deleted/never-existed job must 404, consistent with
      // the sibling GET/PATCH/DELETE/enable routes above — a client must not
      // mistake a nonexistent job for an empty-but-real one (TH1 H1-d2-3).
      if (!deps.jobs.get(req.params.id)) {
        return reply.code(404).send({ error: 'job not found' });
      }
      if (!deps.jobLogs) return reply.code(503).send({ error: 'job logs not configured' });
      const rawLimit = req.query?.limit;
      const limit = rawLimit ? Math.min(200, Math.max(1, Number(rawLimit) || 50)) : 50;
      return reply.code(200).send({ webhooks: deps.jobLogs.readWebhooks(req.params.id, limit) });
    },
  );

  // The concurrency gate's queue for one job (spec/08 ## Concurrency), listed
  // rather than counted: `GET /api/jobs/:id` already reports the two numbers,
  // and a job sitting on a backlog needs to show WHAT is waiting.
  app.get<{ Params: { id: string } }>('/api/jobs/:id/queue', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic() helper,
          // which always sets statusCode=401 explicitly — this fallback is unreachable
          // given the current implementation.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    if (!JOB_ID_REGEX.test(req.params.id)) {
      return reply.code(400).send({ error: 'invalid jobId' });
    }
    // Existence check: a deleted/never-existed job must 404, consistent with
    // the sibling GET/PATCH/DELETE/enable routes above — a client must not
    // mistake a nonexistent job for an empty-but-real one (TH1 H1-d2-3).
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      return reply.code(404).send({ error: 'job not found' });
    }
    if (!deps.dispatcher) return reply.code(503).send({ error: 'dispatcher not configured' });
    const view = deps.dispatcher.queue(req.params.id);
    return reply.code(200).send({
      // The gate only learns a job's limit when that job first fires under it,
      // so a server that has not dispatched this one since boot holds none.
      // The stored job answers for it then — a limited job must never read as
      // unlimited just because it is idle.
      concurrency: view.concurrency ?? job.concurrency ?? null,
      inFlight: view.inFlight,
      queued: view.queued,
    });
  });

  // ---- POST /api/jobs/recurrence/translate ----
  // The recurrence trigger's natural-language schedule input (spec/08
  // § Recurrence): round-trips `patch.recurrence.translate.request` to the
  // named host, exactly as `GET /api/models` round-trips
  // `patch.models.request` (chat-routes.ts) — pending-map + timeout, no
  // second implementation of that pattern.
  const RECURRENCE_TRANSLATE_TIMEOUT_MS = deps.recurrenceTranslateTimeoutMs ?? 25_000;
  const recurrenceTranslatePending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.recurrence.translate.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  if (deps.daemonLink) {
    deps.daemonLink.onEvent((event: WireEvent) => {
      if (event.type !== 'patch.recurrence.translate.response') return;
      const waiter = recurrenceTranslatePending.get(event.requestId);
      if (!waiter) return;
      recurrenceTranslatePending.delete(event.requestId);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    });
  }
  const RecurrenceTranslateBody = z
    .object({ daemonId: z.string().min(1), phrase: z.string().min(1) })
    .strict();
  app.post('/api/jobs/recurrence/translate', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // Defensive: requireAuth always throws via its internal generic()
          // helper, which always sets statusCode=401 explicitly.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const parsed = RecurrenceTranslateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const { daemonId, phrase } = parsed.data;
    const unknownHost = checkRegisteredHost(deps.registry, daemonId);
    if (unknownHost) {
      return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
    }
    const daemonLink = deps.daemonLink;
    const idGenerator = deps.idGenerator;
    if (!daemonLink || !idGenerator) {
      return reply.code(503).send({ error: 'daemon-link not configured' });
    }
    const requestId = idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.recurrence.translate.response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        recurrenceTranslatePending.delete(requestId);
        resolveP('timeout');
      }, RECURRENCE_TRANSLATE_TIMEOUT_MS);
      recurrenceTranslatePending.set(requestId, { resolve: resolveP, timeout });
      daemonLink.send(daemonId, {
        type: 'patch.recurrence.translate.request',
        requestId,
        daemonId,
        phrase,
      });
    });
    if (result === 'timeout') {
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      return reply.code(422).send({
        error: 'translation_failed',
        message: result.error ?? 'could not translate that phrase',
      });
    }
    const rrule = result.rrule;
    if (rrule === undefined) {
      // Defensive: PatchRecurrenceTranslateResponseEvent's contract is that
      // ok:true always carries rrule — unreachable given the host's own
      // implementation (recurrenceTranslate.ts / handleRecurrenceTranslateRequest).
      /* v8 ignore next 3 */
      return reply.code(502).send({ error: 'host returned no rrule' });
    }
    // NO FALLBACK: re-validate AND re-describe whatever the host claims —
    // never trust a model's raw output as a saved schedule. Either check
    // failing is a translation failure, not a job the user never actually
    // confirmed in plain English (spec/08 § Recurrence).
    try {
      RRule.fromString(rrule);
    } catch (err) {
      return reply.code(422).send({
        error: 'translation_failed',
        message: `model produced an invalid RRULE: ${(err as Error).message}`,
      });
    }
    const description = describeRecurrence(rrule);
    if (description === '') {
      return reply.code(422).send({
        error: 'translation_failed',
        message: 'could not confirm that schedule in plain English — try rephrasing',
      });
    }
    return reply.code(200).send({ rrule, description });
  });
}
