// Todoist as an ordinary webhook: `{type:'webhook', scheme:'todoist', secret}`.
//
// spec/08 § Webhook › schemes. Todoist is not a trigger type of its own — it is
// a webhook job whose scheme verifies Todoist's base64 `X-Todoist-Hmac-SHA256`
// against the secret the user put into the job. Uses a fake secret.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { verifySignature } from '../src/jobs/webhooks.js';

const SECRET = 'fake-todoist-client-secret';
const opts = { nowMs: () => 1_700_000_000_000, stripeToleranceMs: 300_000 };
const sign = (raw: string, secret = SECRET): string =>
  createHmac('sha256', secret).update(raw).digest('base64');

describe('verifySignature: todoist scheme', () => {
  const body = Buffer.from('{"event_name":"item:added"}');
  it('accepts the base64 HMAC in x-todoist-hmac-sha256', () => {
    expect(
      verifySignature(
        'todoist',
        body,
        { 'x-todoist-hmac-sha256': sign(body.toString()) },
        SECRET,
        opts,
      ),
    ).toEqual({ ok: true });
  });
  it('rejects a missing header, a wrong signature and a missing secret', () => {
    expect(verifySignature('todoist', body, {}, SECRET, opts)).toEqual({
      ok: false,
      reason: 'missing x-todoist-hmac-sha256',
    });
    expect(
      verifySignature(
        'todoist',
        body,
        { 'x-todoist-hmac-sha256': sign(body.toString(), 'other') },
        SECRET,
        opts,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature('todoist', body, {}, undefined, opts).ok).toBe(false);
  });
});

describe('todoist-scheme webhook jobs', () => {
  let dir: string;
  let prevSecret: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-todoist-scheme-'));
    prevSecret = process.env['TODOIST_WEBHOOK_SECRET'];
    delete process.env['TODOIST_WEBHOOK_SECRET'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevSecret !== undefined) process.env['TODOIST_WEBHOOK_SECRET'] = prevSecret;
  });

  const BODY = JSON.stringify({ event_name: 'item:added', event_data: { id: '1' } });
  const action = { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' } as const;

  async function setup() {
    const built = await buildAll({
      logger: false,
      registry: Registry.load(dir),
      daemonLink: new InProcessDaemonLink(),
    });
    return built;
  }
  const post = (built: Awaited<ReturnType<typeof setup>>, url: string, sig: string | undefined) =>
    built.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        ...(sig === undefined ? {} : { 'x-todoist-hmac-sha256': sig }),
      },
      payload: BODY,
    });

  it('fires through its own per-job URL, verified against the job secret', async () => {
    const built = await setup();
    try {
      const job = built.jobs.create({
        name: 't',
        trigger: { type: 'webhook', scheme: 'todoist', secret: SECRET },
        action,
      });
      expect((await post(built, `/api/webhooks/${job.id}`, sign(BODY, 'bad'))).statusCode).toBe(
        401,
      );
      const ok = await post(built, `/api/webhooks/${job.id}`, sign(BODY));
      expect(ok.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('the shared Todoist callback URL fans out to every todoist-scheme webhook job that verifies, with no server env secret', async () => {
    const built = await setup();
    try {
      const a = built.jobs.create({
        name: 'a',
        trigger: { type: 'webhook', scheme: 'todoist', secret: SECRET },
        action,
      });
      const b = built.jobs.create({
        name: 'b',
        trigger: { type: 'webhook', scheme: 'todoist', secret: SECRET },
        filter: 'false',
        action,
      });
      const other = built.jobs.create({
        name: 'other-app',
        trigger: { type: 'webhook', scheme: 'todoist', secret: 'different' },
        action,
      });
      const res = await post(built, '/api/webhooks/todoist', sign(BODY));
      expect(res.statusCode).toBe(200);
      const results = (res.json() as { results: Array<{ jobId: string; status: string }> }).results;
      expect(results.map((r) => r.jobId).sort()).toEqual([a.id, b.id].sort());
      expect(results.find((r) => r.jobId === b.id)?.status).toBe('filter-rejected');
      expect(results.find((r) => r.jobId === other.id)).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('the shared URL answers 401 when nothing verifies', async () => {
    const built = await setup();
    try {
      built.jobs.create({
        name: 'a',
        trigger: { type: 'webhook', scheme: 'todoist', secret: SECRET },
        action,
      });
      expect((await post(built, '/api/webhooks/todoist', sign(BODY, 'bad'))).statusCode).toBe(401);
      expect((await post(built, '/api/webhooks/todoist', undefined)).statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });
});
