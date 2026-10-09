// Shared, job-less Todoist ingress: POST /api/webhooks/todoist.
//
// spec/08-triggers-and-jobs.md § Todoist › Shared ingress. A Todoist app has
// exactly ONE callback URL, so per-job URLs cap the server at a single Todoist
// job. This endpoint verifies the HMAC once against TODOIST_WEBHOOK_SECRET and
// fans the event out to every enabled todoist-trigger job whose filter passes.
//
// Uses a FAKE secret (no real Todoist credential) — the real-secret path lives
// in jobs-todoist-real-secret.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { hostConfirms } from './host-answer.js';

const SECRET = 'fake-app-client-secret';
const URL = '/api/webhooks/todoist';

interface FanoutResult {
  jobId: string;
  status: string;
  fireId?: string;
}

describe('shared todoist webhook ingress', () => {
  let dir: string;
  let prevSecret: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-todoist-shared-'));
    prevSecret = process.env['TODOIST_WEBHOOK_SECRET'];
    process.env['TODOIST_WEBHOOK_SECRET'] = SECRET;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevSecret === undefined) delete process.env['TODOIST_WEBHOOK_SECRET'];
    else process.env['TODOIST_WEBHOOK_SECRET'] = prevSecret;
  });

  async function setup() {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    return { built, link };
  }

  /** A genuine-shaped Todoist item:added body plus its real HMAC. */
  function signed(body: unknown, secret = SECRET): { raw: string; sig: string } {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', secret).update(raw).digest('base64') };
  }

  function post(built: Awaited<ReturnType<typeof setup>>['built'], raw: string, sig?: string) {
    return built.app.inject({
      method: 'POST',
      url: URL,
      headers: {
        'content-type': 'application/json',
        ...(sig === undefined ? {} : { 'x-todoist-hmac-sha256': sig }),
      },
      payload: raw,
    });
  }

  function webhookLines(jobId: string): Array<Record<string, unknown>> {
    const p = join(dir, 'webhooks', `${jobId}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function runLines(jobId: string): Array<Record<string, unknown>> {
    const p = join(dir, 'runs', `${jobId}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const ADDED = {
    event_name: 'item:added',
    event_data: { id: '1', content: 'buy milk', labels: ['claude'] },
  };

  it('refuses loudly with 503 when TODOIST_WEBHOOK_SECRET is unset — never accepts unverified', async () => {
    // NO FALLBACK (spec/08 § Shared ingress): an unconfigured server must not
    // treat "no secret" as "no verification needed".
    delete process.env['TODOIST_WEBHOOK_SECRET'];
    const { built, link } = await setup();
    try {
      const job = built.jobs.create({
        name: 'todoist-unconfigured',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const { raw } = signed(ADDED);
      // Signed with nothing at all — and even a "correct" signature can't help,
      // because there is no configured secret to be correct against.
      const res = await post(built, raw, 'anything');
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toMatch(/TODOIST_WEBHOOK_SECRET/);
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
      // Unverified caller must not be able to mint a write into a job's log.
      expect(webhookLines(job.id)).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('returns 401 when the signature header is missing', async () => {
    const { built } = await setup();
    try {
      const { raw } = signed(ADDED);
      const res = await post(built, raw);
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('missing x-todoist-hmac-sha256');
    } finally {
      await built.app.close();
    }
  });

  it('returns 401 on a bad signature and writes NO per-job log line', async () => {
    const { built, link } = await setup();
    try {
      const job = built.jobs.create({
        name: 'todoist-badsig',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const { raw } = signed(ADDED, 'not-the-app-secret');
      const wrong = createHmac('sha256', 'not-the-app-secret').update(raw).digest('base64');
      const res = await post(built, raw, wrong);
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('signature rejected');
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
      expect(webhookLines(job.id)).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('fans ONE event out to EVERY matching job — both dispatch, both get their own logs', async () => {
    const { built, link } = await setup();
    try {
      const a = built.jobs.create({
        name: 'fanout-a',
        trigger: { type: 'todoist' },
        filter: "'claude' in payload.event_data.labels",
        action: { type: 'message', chatId: 'c_a', prompt: 'A: {{payload.event_data.content}}' },
      });
      const b = built.jobs.create({
        name: 'fanout-b',
        trigger: { type: 'todoist' },
        filter: 'payload.event_name = "item:added"',
        action: { type: 'message', chatId: 'c_b', prompt: 'B: {{payload.event_data.content}}' },
      });

      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);

      const results = (res.json() as { results: FanoutResult[] }).results;
      expect(results).toHaveLength(2);
      const byJob = new Map(results.map((r) => [r.jobId, r]));
      expect(byJob.get(a.id)?.status).toBe('sent');
      expect(byJob.get(b.id)?.status).toBe('sent');
      expect(byJob.get(a.id)?.fireId).toBeTruthy();
      expect(byJob.get(b.id)?.fireId).toBeTruthy();

      // Both actions really went out, each with its OWN templated prompt.
      const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(2);
      // Each message is prefaced with the job's (default) autonomy prompt
      // (spec/08 § Autonomy prompt), so match on the templated tail.
      const messages = inputs.map((s) =>
        s.event.type === 'chat.input' ? `${s.event.chatId}|${s.event.message}` : '',
      );
      expect(messages.some((m) => m.startsWith('c_a|') && m.includes('A: buy milk'))).toBe(true);
      expect(messages.some((m) => m.startsWith('c_b|') && m.includes('B: buy milk'))).toBe(true);

      // Per-job observability is unchanged: one pass line per job.
      for (const job of [a, b]) {
        const lines = webhookLines(job.id);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          jobId: job.id,
          signature: 'ok',
          scheme: 'todoist',
          filter: 'pass',
          status: 200,
        });
      }

      // And its own run entry (written from the host's answer — spec/08 step 6).
      hostConfirms(link);
      for (const job of [a, b]) {
        expect(runLines(job.id).at(-1)).toMatchObject({
          jobId: job.id,
          status: 'ok',
          trigger: 'todoist',
        });
      }
    } finally {
      await built.app.close();
    }
  });

  it('a non-matching job gets a filter-reject line and does NOT dispatch, while its matching sibling fires', async () => {
    const { built, link } = await setup();
    try {
      const hit = built.jobs.create({
        name: 'matcher',
        trigger: { type: 'todoist' },
        filter: 'payload.event_name = "item:added"',
        action: { type: 'message', chatId: 'c_hit', prompt: 'go' },
      });
      const miss = built.jobs.create({
        name: 'non-matcher',
        trigger: { type: 'todoist' },
        filter: 'payload.event_name = "item:completed"',
        action: { type: 'message', chatId: 'c_miss', prompt: 'go' },
      });

      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);

      const results = (res.json() as { results: FanoutResult[] }).results;
      const byJob = new Map(results.map((r) => [r.jobId, r]));
      expect(byJob.get(hit.id)?.status).toBe('sent');
      expect(byJob.get(miss.id)?.status).toBe('filter-rejected');

      const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.event.type === 'chat.input' && inputs[0].event.chatId).toBe('c_hit');

      expect(webhookLines(miss.id).at(-1)).toMatchObject({ filter: 'reject', status: 200 });
      expect(runLines(miss.id).at(-1)).toMatchObject({ status: 'filter-rejected' });
    } finally {
      await built.app.close();
    }
  });

  it('one job whose filter THROWS does not stop the others from firing', async () => {
    const { built, link } = await setup();
    try {
      const boom = built.jobs.create({
        name: 'filter-throws',
        trigger: { type: 'todoist' },
        // Compiles at create time, throws at evaluation.
        filter: '$assert(false, "boom")',
        action: { type: 'message', chatId: 'c_boom', prompt: 'go' },
      });
      const ok = built.jobs.create({
        name: 'still-fires',
        trigger: { type: 'todoist' },
        filter: 'payload.event_name = "item:added"',
        action: { type: 'message', chatId: 'c_ok', prompt: 'go' },
      });

      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);

      const byJob = new Map(
        (res.json() as { results: FanoutResult[] }).results.map((r) => [r.jobId, r]),
      );
      expect(byJob.get(boom.id)?.status).toBe('filter-error');
      expect(byJob.get(ok.id)?.status).toBe('sent');

      expect(webhookLines(boom.id).at(-1)).toMatchObject({ filter: 'error' });
      expect(runLines(boom.id).at(-1)).toMatchObject({ status: 'filter-error' });

      const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.event.type === 'chat.input' && inputs[0].event.chatId).toBe('c_ok');
    } finally {
      await built.app.close();
    }
  });

  it('skips disabled todoist jobs entirely — no dispatch, no log line', async () => {
    const { built, link } = await setup();
    try {
      const off = built.jobs.create({
        name: 'disabled',
        trigger: { type: 'todoist' },
        action: { type: 'message', chatId: 'c_off', prompt: 'go' },
      });
      built.jobs.disable(off.id);

      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { results: FanoutResult[] }).results).toEqual([]);
      expect(link.sent.filter((s) => s.event.type === 'chat.input')).toHaveLength(0);
      expect(webhookLines(off.id)).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  it('ignores jobs with a non-todoist trigger', async () => {
    const { built, link } = await setup();
    try {
      built.jobs.create({
        name: 'cron-job',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'message', chatId: 'c_cron', prompt: 'go' },
      });
      built.jobs.create({
        name: 'webhook-job',
        trigger: { type: 'webhook', path: 'gh', scheme: 'none' },
        action: { type: 'message', chatId: 'c_wh', prompt: 'go' },
      });

      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { results: FanoutResult[] }).results).toEqual([]);
      expect(link.sent.filter((s) => s.event.type === 'chat.input')).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('zero todoist jobs is a normal 200 with an empty result list', async () => {
    const { built, link } = await setup();
    try {
      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { results: FanoutResult[] }).results).toEqual([]);
      // The settings import a host gets on connect is not work.
      expect(link.sent.filter((s) => !s.event.type.startsWith('settings.'))).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('a job with no filter at all fires on every verified event', async () => {
    const { built, link } = await setup();
    try {
      const job = built.jobs.create({
        name: 'no-filter',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/work', skill: 'todoist-handler' },
      });
      const { raw, sig } = signed(ADDED);
      const res = await post(built, raw, sig);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { results: FanoutResult[] }).results).toMatchObject([
        { jobId: job.id, status: 'sent' },
      ]);
      const spawn = link.sent.find((s) => s.event.type === 'chat.spawn_request');
      expect(spawn).toBeDefined();
      if (spawn && spawn.event.type === 'chat.spawn_request') {
        // The skill form delivers `/<skill>\n\n<payload>` as the first turn.
        expect(spawn.event.prompt).toMatch(/^\/todoist-handler\n\n/);
        expect(spawn.event.prompt).toContain('"content": "buy milk"');
      }
    } finally {
      await built.app.close();
    }
  });

  it('the shared route does not shadow the legacy per-job route (both still work)', async () => {
    const { built, link } = await setup();
    try {
      // Legacy job: verified against its OWN clientSecret, which is NOT the app secret.
      const legacy = built.jobs.create({
        name: 'legacy-per-job',
        trigger: { type: 'todoist', clientSecret: 'its-own-secret' },
        action: { type: 'message', chatId: 'c_legacy', prompt: 'legacy' },
      });

      const { raw } = signed(ADDED);
      const legacySig = createHmac('sha256', 'its-own-secret').update(raw).digest('base64');
      const perJob = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${legacy.id}`,
        headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': legacySig },
        payload: raw,
      });
      expect(perJob.statusCode).toBe(200);
      expect((perJob.json() as { status: string }).status).toBe('sent');

      // The shared route is still reachable and verifies against the APP secret.
      const sharedSig = createHmac('sha256', SECRET).update(raw).digest('base64');
      const shared = await post(built, raw, sharedSig);
      expect(shared.statusCode).toBe(200);
      // The legacy job is a todoist job, so the shared route fans out to it too.
      expect((shared.json() as { results: FanoutResult[] }).results).toMatchObject([
        { jobId: legacy.id, status: 'sent' },
      ]);
      expect(link.sent.filter((s) => s.event.type === 'chat.input')).toHaveLength(2);
    } finally {
      await built.app.close();
    }
  });

  it('a malformed jobId still 400s on the per-job route (shared route did not swallow it)', async () => {
    const { built } = await setup();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/webhooks/todoist/not-a-valid-id',
        payload: { event_name: 'item:added' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});
