// TA3-13 / TA3-14: the untrusted webhook ingress rate limiter.
//
// spec/10-auth.md line 151 — "Webhook callers (Todoist) | Untrusted.
// Rate-limit, JSONata-filter, no code exec."
// spec/08-triggers-and-jobs.md line 181 — "/data/webhooks/<jobId>.jsonl — every
// inbound HTTP webhook hit ... including signature failures and filter
// rejections. The firehose."
//
// Two defects this file pins:
//   1. @fastify/rate-limit short-circuits before the route handler, so a
//      refused inbound left NO line in the per-job firehose.
//   2. The default keyGenerator is the source IP, so ONE bucket was shared by
//      every job on the route — bursting one job 429'd every other job.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobLogs } from '../src/jobs/logs.js';
import { INGRESS_RATE_LIMIT_MAX } from '../src/jobs/ingress-rate-limit.js';

describe('webhook ingress rate limiting', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-ingress-rl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    return { built, link };
  }

  function makeJob(built: Awaited<ReturnType<typeof setup>>['built'], name: string) {
    return built.jobs.create({
      name,
      // `filter: 'false'` — every accepted hit is logged then filter-rejected,
      // so the audit line count is exercised without dispatching anything.
      filter: 'false',
      trigger: { type: 'webhook', scheme: 'none' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
    });
  }

  const hit = (built: Awaited<ReturnType<typeof setup>>['built'], id: string) =>
    built.app.inject({
      method: 'POST',
      url: `/api/webhooks/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

  it('a refused (429) inbound still leaves an audit line in the per-job log', async () => {
    const { built } = await setup();
    try {
      const job = makeJob(built, 'rl-audited');
      const over = 5;
      const codes: number[] = [];
      for (let i = 0; i < INGRESS_RATE_LIMIT_MAX + over; i++) {
        codes.push((await hit(built, job.id)).statusCode);
      }
      expect(codes.filter((c) => c === 200)).toHaveLength(INGRESS_RATE_LIMIT_MAX);
      // Refused with 429 — NOT the 500 safety net. @fastify/rate-limit throws
      // whatever errorResponseBuilder returns, so it must carry a statusCode.
      expect(codes.filter((c) => c === 429)).toHaveLength(over);

      // Every HTTP hit — accepted and refused alike — is in the firehose.
      const entries = new JobLogs(dir).readWebhooks(job.id, 200);
      expect(entries).toHaveLength(INGRESS_RATE_LIMIT_MAX + over);
      const refused = entries.filter((e) => e.status === 429);
      expect(refused).toHaveLength(over);
      for (const e of refused) {
        expect(e.error).toMatch(/rate limited/);
        expect(e.filter).toBe('n/a');
      }
    } finally {
      await built.app.close();
    }
  });

  it('each job gets its OWN bucket — one noisy job cannot silence another', async () => {
    const { built } = await setup();
    try {
      const noisy = makeJob(built, 'rl-noisy');
      const quiet = makeJob(built, 'rl-quiet');
      for (let i = 0; i < INGRESS_RATE_LIMIT_MAX; i++) await hit(built, noisy.id);
      // The noisy job is now exhausted...
      expect((await hit(built, noisy.id)).statusCode).toBe(429);
      // ...and the brand-new, never-hit job is unaffected.
      expect((await hit(built, quiet.id)).statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('a 429 for an UNKNOWN jobId mints no file in the data dir', async () => {
    const { built } = await setup();
    try {
      const unknown = 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV';
      for (let i = 0; i < INGRESS_RATE_LIMIT_MAX + 3; i++) await hit(built, unknown);
      expect(existsSync(join(dir, 'webhooks', `${unknown}.jsonl`))).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  // The Todoist ingress routes share this policy (spec/08 § Todoist). The
  // limiter short-circuits BEFORE the route handler, so these hits need no
  // valid signature to consume the bucket — a 401'd hit still counts, which is
  // the point: an unauthenticated caller cannot burst the ingress for free.
  it('the per-job todoist route is rate limited, and its 429 is audited as scheme todoist', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'rl-todoist',
        trigger: { type: 'todoist', clientSecret: 'fake-secret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const todoistHit = () =>
        built.app.inject({
          method: 'POST',
          url: `/api/webhooks/todoist/${job.id}`,
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        });
      const codes: number[] = [];
      for (let i = 0; i < INGRESS_RATE_LIMIT_MAX + 3; i++)
        codes.push((await todoistHit()).statusCode);
      // Unsigned, so the accepted ones are 401s — but they consumed the bucket.
      expect(codes.filter((c) => c === 401)).toHaveLength(INGRESS_RATE_LIMIT_MAX);
      expect(codes.filter((c) => c === 429)).toHaveLength(3);

      const refused = new JobLogs(dir).readWebhooks(job.id, 200).filter((e) => e.status === 429);
      expect(refused).toHaveLength(3);
      for (const e of refused) expect(e.scheme).toBe('todoist');
    } finally {
      await built.app.close();
    }
  });

  it('the SHARED todoist route buckets per source IP and mints no per-job file on 429', async () => {
    // No `:jobId` on this route, so the key degrades to `|<ip>` and the 429
    // audit has no job to belong to — it goes to the server logger instead.
    const prev = process.env['TODOIST_WEBHOOK_SECRET'];
    process.env['TODOIST_WEBHOOK_SECRET'] = 'fake-app-secret';
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'rl-todoist-shared',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const sharedHit = () =>
        built.app.inject({
          method: 'POST',
          url: '/api/webhooks/todoist',
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        });
      const codes: number[] = [];
      for (let i = 0; i < INGRESS_RATE_LIMIT_MAX + 3; i++)
        codes.push((await sharedHit()).statusCode);
      expect(codes.filter((c) => c === 401)).toHaveLength(INGRESS_RATE_LIMIT_MAX);
      expect(codes.filter((c) => c === 429)).toHaveLength(3);
      // An unverified caller must not be able to write into any job's log.
      expect(existsSync(join(dir, 'webhooks', `${job.id}.jsonl`))).toBe(false);
    } finally {
      await built.app.close();
      if (prev === undefined) delete process.env['TODOIST_WEBHOOK_SECRET'];
      else process.env['TODOIST_WEBHOOK_SECRET'] = prev;
    }
  });
});
