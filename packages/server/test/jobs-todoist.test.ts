// Unit-level coverage for jobs/todoist.ts's route logic (POST
// /api/webhooks/todoist/:jobId). Uses a FAKE clientSecret (no real Todoist
// credential) — the real-secret e2e path lives in
// jobs-todoist-real-secret.test.ts and is owned by a different area.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { hostConfirms } from './host-answer.js';

describe('todoist webhook ingress', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-todoist-'));
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

  it('rejects a malformed jobId with 400, no filesystem touch', async () => {
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

  it('returns 404 and MINTS NO per-job log file when the jobId does not exist', async () => {
    // Same guard as the generic ingress route — see jobs/webhooks.ts.
    const { built } = await setup();
    try {
      const id = 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${id}`,
        payload: { event_name: 'item:added' },
      });
      expect(res.statusCode).toBe(404);
      expect(existsSync(join(dir, 'webhooks', `${id}.jsonl`))).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('returns 404 when the job exists but is not a todoist trigger', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'not-todoist',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        payload: { event_name: 'item:added' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('returns 503 when the job is disabled', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'todoist-disabled',
        trigger: { type: 'todoist', clientSecret: 'fake-secret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      built.jobs.disable(job.id);
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        payload: { event_name: 'item:added' },
      });
      expect(res.statusCode).toBe(503);
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      const entry = JSON.parse(log.split('\n')[0]!);
      expect(entry.status).toBe(503);
      expect(entry.error).toBe('job disabled');
    } finally {
      await built.app.close();
    }
  });

  it('returns 401 when the todoist trigger has no clientSecret configured', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'no-secret',
        trigger: { type: 'todoist' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        payload: { event_name: 'item:added' },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('job missing clientSecret');
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(log).error).toBe('job missing clientSecret');
    } finally {
      await built.app.close();
    }
  });

  it('returns 401 when the signature header is missing', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'missing-sig',
        trigger: { type: 'todoist', clientSecret: 'fake-secret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ event_name: 'item:added' }),
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('missing x-todoist-hmac-sha256');
    } finally {
      await built.app.close();
    }
  });

  it('returns 401 and logs a warning when the signature does not match', async () => {
    const { built } = await setup();
    try {
      const job = built.jobs.create({
        name: 'bad-sig',
        trigger: { type: 'todoist', clientSecret: 'fake-secret' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'x-todoist-hmac-sha256': Buffer.from('totally-wrong').toString('base64'),
        },
        payload: JSON.stringify({ event_name: 'item:added' }),
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: string }).error).toBe('signature rejected');
      const log = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(log).signature).toBe('fail');
    } finally {
      await built.app.close();
    }
  });

  it('falls back to an empty rawBody when the custom JSON parser did not run (non-JSON content-type)', async () => {
    const { built } = await setup();
    try {
      const secret = 'fake-secret';
      const job = built.jobs.create({
        name: 'no-json-parser',
        trigger: { type: 'todoist', clientSecret: secret },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      // content-type text/plain never hits the custom JSON parser registered
      // in webhooks.ts (shared app-level parser, keyed on application/json),
      // so `req.rawBody` is never set and the route falls back to an empty
      // buffer — sign against THAT so the signature still verifies.
      const sig = createHmac('sha256', secret).update(Buffer.alloc(0)).digest('base64');
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: { 'content-type': 'text/plain', 'x-todoist-hmac-sha256': sig },
        payload: 'ignored, not parsed as json',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('accepts a valid signature, filter passes, dispatches the action', async () => {
    const { built, link } = await setup();
    try {
      const secret = 'fake-secret';
      const job = built.jobs.create({
        name: 'todoist-ok',
        trigger: { type: 'todoist', clientSecret: secret },
        filter: 'payload.event_name = "item:added"',
        action: {
          type: 'message',
          chatId: 'c_todo',
          prompt: 'new task: {{payload.event_data.content}}',
        },
      });
      const body = JSON.stringify({
        event_name: 'item:added',
        event_data: { content: 'buy milk' },
      });
      const sig = createHmac('sha256', secret).update(body).digest('base64');
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: {
          'content-type': 'application/json',
          'x-todoist-hmac-sha256': sig,
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const parsed = res.json() as { status: string; fireId: string };
      expect(parsed.status).toBe('sent');
      expect(parsed.fireId).toBeTruthy();
      const sent = link.sent.find((s) => s.event.type === 'chat.input');
      expect(sent).toBeDefined();
      if (sent && sent.event.type === 'chat.input') {
        expect(sent.event.message).toContain('new task: buy milk');
        expect(sent.event.chatId).toBe('c_todo');
      }
      const webhookLog = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(webhookLog).filter).toBe('pass');
      // The run is written from the host's own answer (spec/08 step 6).
      hostConfirms(link);
      const runLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
      const runEntry = JSON.parse(runLog);
      expect(runEntry.status).toBe('ok');
      expect(runEntry.trigger).toBe('todoist');
      expect(runEntry.action.type).toBe('message');
      expect(runEntry.action.chatId).toBe('c_todo');
    } finally {
      await built.app.close();
    }
  });

  it('a spawn action logs its folder alongside the run', async () => {
    const { built, link } = await setup();
    try {
      const secret = 'fake-secret';
      const job = built.jobs.create({
        name: 'todoist-spawn',
        trigger: { type: 'todoist', clientSecret: secret },
        action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
      });
      const body = JSON.stringify({ event_name: 'item:added' });
      const sig = createHmac('sha256', secret).update(body).digest('base64');
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeDefined();
      // The run is written from the host's own answer (spec/08 step 6).
      hostConfirms(link);
      const runLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
      const runEntry = JSON.parse(runLog);
      expect(runEntry.action.folder).toBe('/work');
    } finally {
      await built.app.close();
    }
  });

  it('filter rejection logs filter-rejected and does not dispatch', async () => {
    const { built, link } = await setup();
    try {
      const secret = 'fake-secret';
      const job = built.jobs.create({
        name: 'todoist-reject',
        trigger: { type: 'todoist', clientSecret: secret },
        filter: 'payload.event_name = "item:completed"',
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const body = JSON.stringify({ event_name: 'item:added' });
      const sig = createHmac('sha256', secret).update(body).digest('base64');
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('filter-rejected');
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
      // The run is written from the host's own answer (spec/08 step 6).
      hostConfirms(link);
      const runLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(runLog).status).toBe('filter-rejected');
    } finally {
      await built.app.close();
    }
  });

  it('runtime JSONata error fails closed: filter-error, no dispatch, 200 response', async () => {
    const { built, link } = await setup();
    try {
      const secret = 'fake-secret';
      const job = built.jobs.create({
        name: 'todoist-filter-throws',
        trigger: { type: 'todoist', clientSecret: secret },
        // Compiles at create time but THROWS at evaluation — the only way to
        // reach the fire-time filter-error path (parse-time-broken filters
        // are rejected at create time by the store's semantic gate).
        filter: '$assert(false, "boom")',
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const body = JSON.stringify({ event_name: 'item:added' });
      const sig = createHmac('sha256', secret).update(body).digest('base64');
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('filter-error');
      expect(link.sent.find((s) => s.event.type === 'chat.spawn_request')).toBeUndefined();
      const webhookLog = readFileSync(join(dir, 'webhooks', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(webhookLog).filter).toBe('error');
      // The run is written from the host's own answer (spec/08 step 6).
      hostConfirms(link);
      const runLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
      const runEntry = JSON.parse(runLog);
      expect(runEntry.status).toBe('filter-error');
      expect(runEntry.error).toContain('boom');
    } finally {
      await built.app.close();
    }
  });

  it('a buffered dispatch (host offline) is reflected in the response + run log', async () => {
    const { built, link } = await setup();
    try {
      link.setStatus('offline');
      const secret = 'fake-secret';
      const job = built.jobs.create({
        name: 'todoist-offline',
        trigger: { type: 'todoist', clientSecret: secret },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'go' },
      });
      const body = JSON.stringify({ event_name: 'item:added' });
      const sig = createHmac('sha256', secret).update(body).digest('base64');
      const res = await built.app.inject({
        method: 'POST',
        url: `/api/webhooks/todoist/${job.id}`,
        headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': sig },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('buffered');
      // The run is written from the host's own answer (spec/08 step 6).
      hostConfirms(link);
      const runLog = readFileSync(join(dir, 'runs', `${job.id}.jsonl`), 'utf8').trim();
      expect(JSON.parse(runLog).status).toBe('buffered');
    } finally {
      await built.app.close();
    }
  });
});
