// Group 9B: webhook ingress signature verification + filter + dispatch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { verifySignature } from '../src/jobs/webhooks.js';
import type { WebhookScheme } from '../src/jobs/types.js';

describe('verifySignature (direct unit coverage of every scheme/branch)', () => {
  const opts = { nowMs: () => 1_700_000_000_000, stripeToleranceMs: 5 * 60 * 1000 };

  it('scheme=none always ok, regardless of secret', () => {
    expect(verifySignature('none', Buffer.from('x'), {}, undefined, opts)).toEqual({ ok: true });
  });

  it('any non-none scheme without a secret configured fails closed', () => {
    expect(verifySignature('hmac-sha256', Buffer.from('x'), {}, undefined, opts)).toEqual({
      ok: false,
      reason: 'job missing secret',
    });
  });

  describe('hmac-sha256', () => {
    const secret = 'topsecret';
    const body = Buffer.from('{"a":1}');
    const good = createHmac('sha256', secret).update(body).digest('hex');

    it('missing header', () => {
      expect(verifySignature('hmac-sha256', body, {}, secret, opts)).toEqual({
        ok: false,
        reason: 'missing x-patch-signature',
      });
    });

    it('array-valued header takes the first entry', () => {
      expect(
        verifySignature(
          'hmac-sha256',
          body,
          { 'x-patch-signature': [good, 'other'] },
          secret,
          opts,
        ),
      ).toEqual({ ok: true });
    });

    it('malformed (non-hex) header', () => {
      expect(
        verifySignature('hmac-sha256', body, { 'x-patch-signature': 'not-hex!!' }, secret, opts),
      ).toEqual({ ok: false, reason: 'malformed x-patch-signature' });
    });

    it('valid signature', () => {
      expect(
        verifySignature('hmac-sha256', body, { 'x-patch-signature': good }, secret, opts),
      ).toEqual({ ok: true });
    });

    it('mismatched signature', () => {
      expect(
        verifySignature(
          'hmac-sha256',
          body,
          { 'x-patch-signature': '00'.repeat(32) },
          secret,
          opts,
        ),
      ).toEqual({ ok: false, reason: 'mismatch' });
    });

    it('well-formed hex but the wrong length still mismatches (short-circuits on length)', () => {
      expect(
        verifySignature('hmac-sha256', body, { 'x-patch-signature': 'ab' }, secret, opts),
      ).toEqual({ ok: false, reason: 'mismatch' });
    });
  });

  describe('github', () => {
    const secret = 'ghsecret';
    const body = Buffer.from('{"action":"closed"}');
    const good = createHmac('sha256', secret).update(body).digest('hex');

    it('missing header', () => {
      expect(verifySignature('github', body, {}, secret, opts)).toEqual({
        ok: false,
        reason: 'missing x-hub-signature-256',
      });
    });

    it('array-valued header takes the first entry', () => {
      expect(
        verifySignature(
          'github',
          body,
          { 'x-hub-signature-256': [`sha256=${good}`, 'other'] },
          secret,
          opts,
        ),
      ).toEqual({ ok: true });
    });

    it('malformed header (missing sha256= prefix)', () => {
      expect(
        verifySignature('github', body, { 'x-hub-signature-256': good }, secret, opts),
      ).toEqual({ ok: false, reason: 'malformed x-hub-signature-256' });
    });

    it('valid signature', () => {
      expect(
        verifySignature('github', body, { 'x-hub-signature-256': `sha256=${good}` }, secret, opts),
      ).toEqual({ ok: true });
    });

    it('mismatched signature', () => {
      expect(
        verifySignature(
          'github',
          body,
          { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
          secret,
          opts,
        ),
      ).toEqual({ ok: false, reason: 'mismatch' });
    });
  });

  describe('stripe', () => {
    const secret = 'whsec_x';
    const body = Buffer.from('{"id":"evt_1"}');
    const ts = String(Math.floor(opts.nowMs() / 1000));
    const good = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

    it('missing header', () => {
      expect(verifySignature('stripe', body, {}, secret, opts)).toEqual({
        ok: false,
        reason: 'missing stripe-signature',
      });
    });

    it('array-valued header takes the first entry', () => {
      expect(
        verifySignature(
          'stripe',
          body,
          { 'stripe-signature': [`t=${ts},v1=${good}`, 'other'] },
          secret,
          opts,
        ),
      ).toEqual({ ok: true });
    });

    it('malformed header — no t= or v1= components at all', () => {
      expect(
        verifySignature('stripe', body, { 'stripe-signature': 'garbage-no-equals' }, secret, opts),
      ).toEqual({ ok: false, reason: 'malformed stripe-signature' });
    });

    it('malformed header — has t= but no v1=', () => {
      expect(
        verifySignature('stripe', body, { 'stripe-signature': `t=${ts}` }, secret, opts),
      ).toEqual({ ok: false, reason: 'malformed stripe-signature' });
    });

    it('malformed header — has v1= but no t=', () => {
      expect(
        verifySignature('stripe', body, { 'stripe-signature': `v1=${good}` }, secret, opts),
      ).toEqual({ ok: false, reason: 'malformed stripe-signature' });
    });

    it('non-numeric timestamp', () => {
      expect(
        verifySignature(
          'stripe',
          body,
          { 'stripe-signature': `t=not-a-number,v1=${good}` },
          secret,
          opts,
        ),
      ).toEqual({ ok: false, reason: 'bad stripe timestamp' });
    });

    it('timestamp outside tolerance', () => {
      const oldTs = '1000000000';
      const oldSig = createHmac('sha256', secret).update(`${oldTs}.${body}`).digest('hex');
      expect(
        verifySignature(
          'stripe',
          body,
          { 'stripe-signature': `t=${oldTs},v1=${oldSig}` },
          secret,
          opts,
        ),
      ).toEqual({ ok: false, reason: 'stripe timestamp outside tolerance' });
    });

    it('valid signature (single v1)', () => {
      expect(
        verifySignature('stripe', body, { 'stripe-signature': `t=${ts},v1=${good}` }, secret, opts),
      ).toEqual({ ok: true });
    });

    it('valid signature among MULTIPLE v1 candidates (key rotation)', () => {
      expect(
        verifySignature(
          'stripe',
          body,
          { 'stripe-signature': `t=${ts},v1=deadbeef,v1=${good}` },
          secret,
          opts,
        ),
      ).toEqual({ ok: true });
    });

    it('no v1 candidate matches', () => {
      expect(
        verifySignature(
          'stripe',
          body,
          { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` },
          secret,
          opts,
        ),
      ).toEqual({ ok: false, reason: 'mismatch' });
    });
  });

  it('an unknown/future scheme falls through the exhaustiveness check', () => {
    expect(
      verifySignature('carrier-pigeon' as WebhookScheme, Buffer.from('x'), {}, 'secret', opts),
    ).toEqual({ ok: false, reason: 'unknown scheme' });
  });
});

describe('webhook ingress', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({
      logger: false,
      registry,
      daemonLink: link,
    });
    return { built, link };
  }

  it('returns 401 when github signature header is missing', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'gh',
        trigger: { type: 'webhook', scheme: 'github', secret: 'sekret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        payload: { hello: 'world' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('accepts a valid github signature, runs filter, dispatches', async () => {
    const { built, link } = await setup();
    try {
      const job = built.jobs.create({
        name: 'gh',
        trigger: { type: 'webhook', scheme: 'github', secret: 'sekret' },
        filter: 'payload.action = "closed"',
        action: { type: 'message', chatId: 'c_manager', prompt: 'PR {{payload.action}}' },
      });
      const body = JSON.stringify({ action: 'closed', pull_request: { merged: true } });
      const sig = `sha256=${createHmac('sha256', 'sekret').update(body).digest('hex')}`;
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const sent = link.sent.find((s) => s.event.type === 'chat.input');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.input') {
        expect(sent.event.message).toContain('PR closed');
        expect(sent.event.chatId).toBe('c_manager');
      }
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(log).filter).toBe('pass');
    } finally {
      await built.app.close();
    }
  });

  it('spec-style payload.* filter rejects a non-matching body (no dispatch)', async () => {
    const { built, link } = await setup();
    try {
      const job = built.jobs.create({
        name: 'gh',
        trigger: { type: 'webhook', scheme: 'github', secret: 'sekret' },
        filter: 'payload.action = "closed"',
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'PR {{payload.action}}' },
      });
      const body = JSON.stringify({ action: 'opened', pull_request: { merged: false } });
      const sig = `sha256=${createHmac('sha256', 'sekret').update(body).digest('hex')}`;
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('filter-rejected');
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(log).filter).toBe('reject');
    } finally {
      await built.app.close();
    }
  });

  it('rejects bad github signature with 401, logs failure', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'gh',
        trigger: { type: 'webhook', scheme: 'github', secret: 'sekret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256':
            'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
        payload: '{}',
      });
      expect(res.statusCode).toBe(401);
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      const entry = JSON.parse(log.split('\n')[0]!);
      expect(entry.signature).toBe('fail');
    } finally {
      await built.app.close();
    }
  });

  it('custom hmac-sha256 valid + invalid', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'cu',
        trigger: { type: 'webhook', scheme: 'hmac-sha256', secret: 'topsecret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const body = '{"a":1}';
      // Spec/08: bare hex digest, NO `sha256=` prefix.
      const goodSig = createHmac('sha256', 'topsecret').update(body).digest('hex');
      const ok = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-patch-signature': goodSig },
        payload: body,
      });
      expect(ok.statusCode).toBe(200);
      const bad = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-patch-signature': '00' },
        payload: body,
      });
      expect(bad.statusCode).toBe(401);
      // A `sha256=`-prefixed value (GitHub's format) must be REJECTED as
      // malformed for the generic hmac-sha256 scheme.
      const prefixed = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'x-patch-signature': `sha256=${goodSig}`,
        },
        payload: body,
      });
      expect(prefixed.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('stripe valid + invalid + outside tolerance', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'st',
        trigger: { type: 'webhook', scheme: 'stripe', secret: 'whsec_x' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const body = '{"id":"evt_1"}';
      // Use a fresh timestamp so the default 5min tolerance is satisfied.
      const tsSeconds = Math.floor(Date.now() / 1000);
      const ts = String(tsSeconds);
      const expected = createHmac('sha256', 'whsec_x').update(`${ts}.${body}`).digest('hex');
      const ok = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${ts},v1=${expected}`,
        },
        payload: body,
      });
      expect(ok.statusCode).toBe(200);
      // Bad sig
      const bad = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}`,
        },
        payload: body,
      });
      expect(bad.statusCode).toBe(401);
      // Outside tolerance — ts from 2023 is way beyond 5min.
      const oldTs = '1700000000';
      const oldExpected = createHmac('sha256', 'whsec_x').update(`${oldTs}.${body}`).digest('hex');
      const old = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${oldTs},v1=${oldExpected}`,
        },
        payload: body,
      });
      expect(old.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('scheme=none accepts any request and logs signature=none', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'open',
        trigger: { type: 'webhook', scheme: 'none' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('falls back to an empty rawBody when the custom JSON parser did not run (non-JSON content-type)', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'no-json-parser',
        trigger: { type: 'webhook', scheme: 'none' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'text/plain' },
        payload: 'not json, never touches the custom parser',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('a non-none scheme filter-error also logs signature=ok (not none)', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'gh-filter-throws',
        trigger: { type: 'webhook', scheme: 'github', secret: 'sekret' },
        filter: '$assert(false, "boom")',
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const body = '{}';
      const sig = `sha256=${createHmac('sha256', 'sekret').update(body).digest('hex')}`;
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('filter-error');
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(log).signature).toBe('ok');
    } finally {
      await built.app.close();
    }
  });

  it('a non-none scheme filter-rejection also logs signature=ok (not none)', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'gh-filter-rejects',
        trigger: { type: 'webhook', scheme: 'github', secret: 'sekret' },
        filter: 'payload.action = "never"',
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const body = '{"action":"opened"}';
      const sig = `sha256=${createHmac('sha256', 'sekret').update(body).digest('hex')}`;
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('filter-rejected');
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(log).signature).toBe('ok');
    } finally {
      await built.app.close();
    }
  });

  it('a buffered dispatch (host offline) is reflected in the run log status', async () => {
    const { built, link } = await setup();
    try {
      link.setStatus('offline');
      const job = built.jobs.create({
        name: 'offline-dispatch',
        trigger: { type: 'webhook', scheme: 'none' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('buffered');
      const runLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(runLog).status).toBe('buffered');
    } finally {
      await built.app.close();
    }
  });

  it('disabled job → 503', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'd',
        trigger: { type: 'webhook', scheme: 'none' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      built.jobs.disable(job.id);
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await built.app.close();
    }
  });

  it('filter sees a plain `now` field (spec/08 § Filter) — a date-bounded condition works on a payload-bearing trigger too', async () => {
    const { built, link } = await setup();
    try {
      const job = built.jobs.create({
        name: 'starts-in-the-past-so-fires',
        trigger: { type: 'webhook', scheme: 'none' },
        filter: 'now >= "2000-01-01T00:00:00.000Z"',
        action: { type: 'message', chatId: 'c_manager', prompt: 'hi' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect(link.sent.find((s) => s.event.type === 'chat.input')).toBeDefined();
    } finally {
      await built.app.close();
    }
  });

  it('runtime JSONata error fail-closed → 200 status:filter-error, no dispatch', async () => {
    const { built, link } = await setup();
    try {
      // A filter that COMPILES (so it passes create-time validation) but
      // THROWS at evaluation time. This is the fire-time filter-error path:
      // parse-time-broken filters are now rejected at create time (the single
      // semantic gate in JobStore), so the only way to reach this branch is a
      // valid expression that errors against the payload.
      const job = built.jobs.create({
        name: 'bf',
        trigger: { type: 'webhook', scheme: 'none' },
        filter: '$assert(false, "boom")',
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('filter-error');
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('rejects a malformed jobId with 400 BEFORE touching the filesystem (path traversal guard)', async () => {
    const { built } = await setup();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/webhooks/..%2F..%2Ftmp%2Fattacker',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid jobId');
    } finally {
      await built.app.close();
    }
  });

  it('returns 404 and MINTS NO per-job log file when the jobId does not exist', async () => {
    // spec/08 line 181 scopes /data/webhooks/<jobId>.jsonl to a job's own
    // inbound hits. Appending here would create a file in the server data dir
    // for any unauthenticated caller's made-up (but well-formed) jobId — an
    // unauthenticated disk-write primitive whose lines are unreadable anyway
    // (GET /api/jobs/:id/webhooks 404s on an unknown job).
    const { built } = await setup();
    try {
      const id = 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(404);
      expect(existsSync(join(dir, 'webhooks', `${id}.jsonl`))).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('returns 404 when the job exists but is not a webhook trigger', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'not-webhook',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('an empty JSON body (content-length 0) is accepted as {}', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'empty-body',
        trigger: { type: 'webhook', scheme: 'none' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('a malformed JSON body is rejected with 400 (mirrors Fastify default parser behaviour)', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'bad-json',
        trigger: { type: 'webhook', scheme: 'none' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: '{not valid json',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  // spec/10 § The authority of a turn: every trigger ingress is an entry point
  // to the host user's full authority, so verification happens BEFORE anything
  // is dispatched — never after. A rejected inbound must produce no run at all,
  // and must still be readable back in the inbound log.
  describe('a rejected inbound dispatches nothing and still leaves an audit line', () => {
    it('an unknown job id: nothing sent to any host, and the hit is logged', async () => {
      const { built, link } = await setup();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/webhooks/j_01JZZZZZZZZZZZZZZZZZZZZZZZ',
          headers: { 'content-type': 'application/json' },
          payload: { anything: true },
        });
        expect(res.statusCode).toBe(404);
        // The decisive assertion: NOTHING reached a host. An unknown id that
        // still spawned would be an unauthenticated turn with sudo on the box.
        // The settings import a host gets on connect is not work.
        expect(link.sent.filter((s) => !s.event.type.startsWith('settings.'))).toHaveLength(0);
      } finally {
        await built.app.close();
      }
    });

    it('a signature that does not verify: nothing dispatched, and the failure is in the webhook log', async () => {
      const { built, link } = await setup();
      try {
        const job = built.jobs.create({
          name: 'gh-audit',
          trigger: { type: 'webhook', scheme: 'github', secret: 'shh' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
        });
        const res = await built.app.inject({
          method: 'POST',
          url: `/api/webhooks/${job.id}`,
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${'00'.repeat(32)}`,
          },
          payload: { pushed: true },
        });
        expect(res.statusCode).toBe(401);
        // The settings import a host gets on connect is not work.
        expect(link.sent.filter((s) => !s.event.type.startsWith('settings.'))).toHaveLength(0);

        // Readable back: the firehose log records the rejection WITH its reason,
        // so a person can see why an integration went quiet.
        const logPath = join(dir, 'webhooks', `${job.id}.jsonl`);
        const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1] as string) as {
          status: number;
          signature: string;
          error?: string;
        };
        expect(last.status).toBe(401);
        expect(last.signature).toBe('fail');
        expect(String(last.error)).toContain('mismatch');

        // And no RUN was recorded, because no run happened.
        expect(existsSync(join(dir, 'runs', `${job.id}.jsonl`))).toBe(false);
      } finally {
        await built.app.close();
      }
    });
  });
});
