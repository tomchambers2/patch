// Group D2 — Triggers & jobs END-TO-END against a RUNNING server.
//
// This boots the real `buildAll` server (same entry as `pnpm --filter
// @patch/server dev`), has it LISTEN on a real TCP port, and drives every
// trigger type, the JSONata filter, both action types, all four action
// combos, both log streams, CRUD over BOTH surfaces (REST + the MCP/UDS
// rpc-bridge over the daemon-link), and offline buffering/flush.
//
// Dispatched actions are captured on the InProcessDaemonLink.sent array —
// these are the EXACT wire frames the host receives over WS in production
// (chat.spawn_request / chat.input). The cron path is fired via the real
// CronScheduler.fireForTesting hook (deterministic; a 1-minute expr would
// otherwise mean waiting up to 60s of wall-clock).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, type UserKeypair } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '../src/jobs/types.js';
import { hostConfirms } from './host-answer.js';

const ACCOUNT_KP: UserKeypair = generateUserKeypair();

/** Every fire prefaces its first user-turn with the job's autonomy prompt
 * (spec/08 § Autonomy prompt) — `DEFAULT_JOB_AUTONOMY_PROMPT` unless the job
 * overrides it. */
function withDefaultAutonomyPrompt(body: string): string {
  return `${DEFAULT_JOB_AUTONOMY_PROMPT}\n\n${body}`;
}

interface Harness {
  base: string;
  jwt: string;
  daemonLink: InProcessDaemonLink;
  dataDir: string;
  built: BuiltApp;
  close: () => Promise<void>;
}

async function startServer(
  dir: string,
  extra: Partial<Parameters<typeof buildAll>[0]> = {},
): Promise<Harness> {
  const registry = Registry.load(dir);
  // A second boot against the same data dir is a RESTART, and the account is
  // already persisted — bootstrapping again would (rightly) be refused.
  if (registry.getAccount() === null) registry.bootstrapAccount({ keypair: ACCOUNT_KP });
  // Register a surface so the JWT verifies and isn't revoked.
  registry.upsertSurface({
    surfaceId: 'cli-test',
    surfaceKind: 'desktop',
    label: 'cli-test',
    issuedAt: Date.now(),
  });
  const daemonLink = new InProcessDaemonLink();
  const built = await buildAll({ logger: false, registry, daemonLink, ...extra });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  const jwt = await mintSurfaceCredential({
    userPrivateKey: ACCOUNT_KP.privateKey,
    surfaceId: 'cli-test',
    surfaceKind: 'desktop',
    label: 'cli-test',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    base: `http://127.0.0.1:${addr.port}`,
    jwt,
    daemonLink,
    dataDir: dir,
    built,
    close: async () => {
      built.wsHub.shutdown();
      built.callOrchestrator.shutdown();
      await built.app.close();
    },
  };
}

async function api(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${h.jwt}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

/** POST a raw webhook (no auth, custom headers, raw body). */
async function postWebhook(
  h: Harness,
  path: string,
  rawBody: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
  let json: any = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

/** Seed the chat-registry with a chatId so message-action validation passes. */
function seedChat(h: Harness, chatId: string): void {
  h.daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '/seed' } as WireEvent);
}

/**
 * Drive the MCP/UDS path: emit a patch.jobs.request inbound (as the host's
 * RemoteJobsStore would over WS), then read the server's patch.jobs.response
 * back off daemonLink.sent (where InProcessDaemonLink.send records the frame
 * the server pushed upstream — the same bytes the host would read over WS).
 */
async function jobsRpc(
  h: Harness,
  op: string,
  payload: { jobId?: string; body?: unknown; limit?: number } = {},
): Promise<{ ok: boolean; result?: any; error?: any }> {
  const requestId = `rpc-${Math.random().toString(36).slice(2)}`;
  h.daemonLink.emit({
    type: 'patch.jobs.request',
    requestId,
    op,
    ...(payload.jobId !== undefined ? { jobId: payload.jobId } : {}),
    ...(payload.body !== undefined ? { body: payload.body } : {}),
    ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
  } as WireEvent);
  // The rpc-bridge replies synchronously via daemonLink.send.
  const reply = h.daemonLink.sent.find(
    (s) => s.event.type === 'patch.jobs.response' && (s.event as any).requestId === requestId,
  );
  if (!reply) throw new Error(`no patch.jobs.response for ${op} (${requestId})`);
  const e = reply.event as any;
  return { ok: e.ok, result: e.result, error: e.error };
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

let dir: string;
let h: Harness;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jobs-e2e-'));
  h = await startServer(dir);
});
afterEach(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('jobs E2E [running server]', () => {
  // --- Cron trigger ---------------------------------------------------------
  it('cron trigger: REST-created, scheduler fires, spawns chat with {firedAt} payload', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'cron-spawn',
      trigger: { type: 'cron', expression: '* * * * *' },
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'fired at {{payload.firedAt}}',
      },
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id;
    expect(jobId).toMatch(/^j_/);
    // Stored expression is the raw 5-field UTC expr (never coerced to a TZ).
    expect(created.json.trigger.expression).toBe('* * * * *');

    const before = h.daemonLink.sent.length;
    await h.built.cronScheduler.fireForTesting(jobId);
    const spawn = h.daemonLink.sent
      .slice(before)
      .find((s) => s.event.type === 'chat.spawn_request');
    expect(spawn).toBeDefined();
    const ev = spawn!.event as any;
    expect(ev.folder).toBe('/work');
    // Prompt mustache-substituted the firedAt ISO timestamp.
    expect(ev.prompt.startsWith(DEFAULT_JOB_AUTONOMY_PROMPT)).toBe(true);
    expect(ev.prompt).toMatch(/fired at \d{4}-\d{2}-\d{2}T/);
    // Spawned job chats open in the ACTIVE inbox unless the action sets
    // `startHidden` (spec/08 ## Action).
    expect(ev.hidden).toBe(false);

    // The run is written from the host's own answer (spec/08 step 6).

    hostConfirms(h.daemonLink);

    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.at(-1)).toMatchObject({ jobId, status: 'ok', trigger: 'cron' });
    expect(runs.at(-1).action).toMatchObject({ type: 'spawn', daemonId: 'd1', folder: '/work' });
  });

  // --- Permission mode (spec/08 § Action) -----------------------------------
  // Driven through the real REST surface, because the whole point of the field
  // is that a client can store it: `POST /api/jobs` has to accept it, the store
  // has to persist it, `GET` has to hand it back, and the fire has to carry it.
  it('permission mode: REST round-trips action.permissionMode and the fire carries it', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'careful-job',
      trigger: { type: 'cron', expression: '* * * * *' },
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'go',
        permissionMode: 'plan',
      },
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id;
    expect(created.json.action.permissionMode).toBe('plan');
    const fetched = await api(h, 'GET', `/api/jobs/${jobId}`);
    expect(fetched.json.action.permissionMode).toBe('plan');

    const before = h.daemonLink.sent.length;
    await h.built.cronScheduler.fireForTesting(jobId);
    const spawn = h.daemonLink.sent
      .slice(before)
      .find((s) => s.event.type === 'chat.spawn_request');
    expect(spawn).toBeDefined();
    expect((spawn!.event as any).permissionMode).toBe('plan');
    hostConfirms(h.daemonLink);
  });

  it('permission mode: a job that stores none fires under auto, not the host default', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'plain-job',
      trigger: { type: 'cron', expression: '* * * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    expect(created.status).toBe(201);
    expect(created.json.action).not.toHaveProperty('permissionMode');

    const before = h.daemonLink.sent.length;
    await h.built.cronScheduler.fireForTesting(created.json.id);
    const spawn = h.daemonLink.sent
      .slice(before)
      .find((s) => s.event.type === 'chat.spawn_request');
    // Sent explicitly. An ABSENT field would resolve through whatever default
    // that host carries, which is the thing a job must never do.
    expect((spawn!.event as any).permissionMode).toBe('auto');
    hostConfirms(h.daemonLink);
  });

  it('permission mode: a mode outside the enum is refused at the API', async () => {
    const res = await api(h, 'POST', '/api/jobs', {
      name: 'bad-mode',
      trigger: { type: 'cron', expression: '* * * * *' },
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'go',
        permissionMode: 'dontAsk',
      },
    });
    expect(res.status).toBe(400);
  });

  // --- Automations sidebar group (spec/14 § Sidebar) -------------------------
  it('automations: a spawn-fired chat is tagged with its jobId and surfaces under ?automations=only, dually with ?hidden=only', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'automation-tag',
      trigger: { type: 'cron', expression: '* * * * *' },
      // `startHidden` so the chat really is hidden — this test is about a chat
      // being in Automations AND Hidden at once.
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go', startHidden: true },
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id;

    // A chat the user started, untouched by any job — must NOT show up.
    h.daemonLink.emit({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'user-chat-1',
      folder: '/x',
    });

    await h.built.cronScheduler.fireForTesting(jobId);
    const spawnReq = h.daemonLink.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(spawnReq).toBeDefined();
    const spawnedChatId = (spawnReq!.event as { chatId: string }).chatId;

    // The chatId→jobId link is recorded at dispatch time — BEFORE the host
    // confirms (spec/08 § Action: "Recorded now, not once the host
    // confirms") — so the row is already tagged the instant the mirror
    // creates it off the host's own `chat.spawned` answer.
    hostConfirms(h.daemonLink);

    const automations = await api(h, 'GET', '/api/chats?automations=only');
    expect(automations.status).toBe(200);
    const ids = automations.json.chats.map((c: any) => c.chatId);
    expect(ids).toContain(spawnedChatId);
    expect(ids).not.toContain('user-chat-1');
    const row = automations.json.chats.find((c: any) => c.chatId === spawnedChatId);
    expect(row.jobId).toBe(jobId);

    // The host reports the hidden state it actually applied via its next
    // chat.state (chat.spawned itself carries no status — spec/03 § Control).
    h.daemonLink.emit({
      type: 'chat.state',
      chatId: spawnedChatId,
      permissionMode: 'bypassPermissions',
      activity: 'idle',
      lastUpdated: Date.now(),
      status: 'active',
      hidden: true,
      pinned: false,
      folder: '/work',
    });

    // Dual membership (spec/14 § Chat lifecycle): a `startHidden` spawn-fired chat
    // is hidden AND still shows up in ?automations=only — Automations is an
    // additional view, not a chat mover.
    const hidden = await api(h, 'GET', '/api/chats?hidden=only');
    expect(hidden.json.chats.map((c: any) => c.chatId)).toContain(spawnedChatId);

    // Still tagged after the chat.state round-trip — jobId is carried
    // forward, never re-derived from the wire event (spec/14 § Sidebar).
    const automationsAfter = await api(h, 'GET', '/api/chats?automations=only');
    const rowAfter = automationsAfter.json.chats.find((c: any) => c.chatId === spawnedChatId);
    expect(rowAfter.jobId).toBe(jobId);

    // Section counts (spec/04 § Section counts) over the SAME dual-membership
    // fixture: the sidebar's collapsed Automations badge must match the rows
    // this chat actually appears in. Worth pinning here rather than only in
    // chat-routes.test.ts, because this is the one fixture with a genuinely
    // job-linked chat — a `jobId` reaches a row through the dispatcher's
    // chat-links map, which a hand-seeded registry never exercises. The same
    // chat is counted under BOTH automations and hidden, which is the whole
    // point of Automations being an additional view rather than a mover.
    const counts = await api(h, 'GET', '/api/chats/counts');
    expect(counts.status).toBe(200);
    expect(counts.json.automations).toBe(automationsAfter.json.chats.length);
    expect(counts.json.automations).toBe(1);
    expect(counts.json.hidden).toBe(hidden.json.chats.length);
  });

  // --- Concurrency ----------------------------------------------------------
  it('concurrency: the limit is stored, the second fire waits, and both routes report the counts', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'serialised',
      concurrency: 1,
      trigger: { type: 'cron', expression: '* * * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id;
    expect(created.json.concurrency).toBe(1);

    const before = h.daemonLink.sent.length;
    await h.built.cronScheduler.fireForTesting(jobId);
    await h.built.cronScheduler.fireForTesting(jobId);
    // Only the first fire reached the host; the second is behind the limit.
    const spawns = h.daemonLink.sent
      .slice(before)
      .filter((s) => s.event.type === 'chat.spawn_request');
    expect(spawns).toHaveLength(1);

    // The wait is in the job's own history, and in both read routes.
    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.filter((r) => r.status === 'queued')).toHaveLength(1);
    const get = await api(h, 'GET', `/api/jobs/${jobId}`);
    expect(get.json).toMatchObject({ inFlight: 1, queued: 1 });
    const list = await api(h, 'GET', '/api/jobs');
    expect(list.json.jobs.find((j: any) => j.id === jobId)).toMatchObject({
      inFlight: 1,
      queued: 1,
    });

    // Removing the limit is an explicit null, and it takes effect.
    const cleared = await api(h, 'PATCH', `/api/jobs/${jobId}`, { concurrency: null });
    expect(cleared.json.concurrency).toBeUndefined();
  });

  it('queueing: REST stores a queue mode, queues the second fire, refuses bad combinations', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'queued-by-mode',
      queueing: { mode: 'queue', concurrency: 1 },
      trigger: { type: 'cron', expression: '* * * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    expect(created.status).toBe(201);
    expect(created.json.queueing).toEqual({ mode: 'queue', concurrency: 1 });
    const jobId = created.json.id;
    await h.built.cronScheduler.fireForTesting(jobId);
    await h.built.cronScheduler.fireForTesting(jobId);
    const get = await api(h, 'GET', `/api/jobs/${jobId}`);
    expect(get.json).toMatchObject({ inFlight: 1, queued: 1 });

    const both = await api(h, 'PATCH', `/api/jobs/${jobId}`, { concurrency: 2 });
    expect(both.status).toBe(400);
    const append = await api(h, 'PATCH', `/api/jobs/${jobId}`, { queueing: { mode: 'append' } });
    expect(append.status).toBe(400);
    const bad = await api(h, 'PATCH', `/api/jobs/${jobId}`, { queueing: { mode: 'nope' } });
    expect(bad.status).toBe(400);
    const cleared = await api(h, 'PATCH', `/api/jobs/${jobId}`, { queueing: null });
    expect(cleared.json.queueing).toBeUndefined();
  });

  // Deploying IS a restart, and this pipeline deploys while its own jobs are
  // in flight — so the limit has to hold across one. The unit test stubs the
  // chat mirror; this one uses the REAL one, which is empty on boot, which is
  // exactly what made the queue drain on prod.
  it('concurrency: a restart does not drain the queue on top of a still-running chat', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'serialised-across-restart',
      concurrency: 1,
      trigger: { type: 'cron', expression: '* * * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    });
    const jobId = created.json.id;

    await h.built.cronScheduler.fireForTesting(jobId);
    await h.built.cronScheduler.fireForTesting(jobId);
    const heldChat = (
      h.daemonLink.sent.find((s) => s.event.type === 'chat.spawn_request')!.event as any
    ).chatId as string;
    expect((await api(h, 'GET', `/api/jobs/${jobId}`)).json).toMatchObject({
      inFlight: 1,
      queued: 1,
    });

    // The chat is genuinely working when the server goes down.
    h.daemonLink.emit({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: heldChat,
      folder: '/work',
    } as WireEvent);
    h.daemonLink.emit({
      type: 'chat.state',
      chatId: heldChat,
      activity: 'running',
      lastUpdated: 1,
      permissionMode: 'bypassPermissions',
    } as WireEvent);
    await h.close();

    // Restart against the same data dir. Nothing seeds the chat mirror, so
    // the restored slot's chat is unresolvable at reconcile time.
    h = await startServer(dir);
    expect((await api(h, 'GET', `/api/jobs/${jobId}`)).json).toMatchObject({
      inFlight: 1,
      queued: 1,
    });
    expect(h.daemonLink.sent.filter((s) => s.event.type === 'chat.spawn_request')).toHaveLength(0);

    // The queue moves only when that chat actually finishes.
    h.daemonLink.emit({
      type: 'chat.state',
      chatId: heldChat,
      activity: 'running',
      lastUpdated: 2,
      permissionMode: 'bypassPermissions',
    } as WireEvent);
    h.daemonLink.emit({
      type: 'chat.state',
      chatId: heldChat,
      activity: 'idle',
      lastUpdated: 3,
      permissionMode: 'bypassPermissions',
    } as WireEvent);
    expect(h.daemonLink.sent.filter((s) => s.event.type === 'chat.spawn_request')).toHaveLength(1);
    expect((await api(h, 'GET', `/api/jobs/${jobId}`)).json).toMatchObject({
      inFlight: 1,
      queued: 0,
    });
  });

  // --- Webhook HMAC schemes -------------------------------------------------
  it('webhook scheme=hmac-sha256: valid sig dispatches, bad sig 401, both logged', async () => {
    const secret = 'supersecretkey';
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'hook',
      trigger: { type: 'webhook', scheme: 'hmac-sha256', secret },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'hit' },
    });
    const jobId = created.json.id;
    const url = `/api/webhooks/${jobId}`;
    const rawBody = JSON.stringify({ hello: 'world' });

    // Bad signature → 401. Spec/08: generic hmac is BARE hex (no prefix).
    const bad = await postWebhook(h, url, rawBody, { 'x-patch-signature': 'deadbeef' });
    expect(bad.status).toBe(401);

    // Valid signature → 200 + dispatch. `X-Patch-Signature: hex(hmac_sha256(...))`.
    const sig = createHmac('sha256', secret).update(rawBody).digest('hex');
    const before = h.daemonLink.sent.length;
    const ok = await postWebhook(h, url, rawBody, { 'x-patch-signature': sig });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('sent');
    expect(h.daemonLink.sent.slice(before).some((s) => s.event.type === 'chat.spawn_request')).toBe(
      true,
    );

    // EVERY inbound hit (incl. the failure) is in webhooks.jsonl.
    const hooks = readJsonl(join(dir, 'webhooks', `${jobId}.jsonl`));
    expect(hooks.some((w) => w.status === 401 && w.signature === 'fail')).toBe(true);
    expect(hooks.some((w) => w.status === 200 && w.filter === 'pass')).toBe(true);
  });

  it('webhook scheme=github: X-Hub-Signature-256 verified', async () => {
    const secret = 'ghsecret';
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'gh',
      trigger: { type: 'webhook', scheme: 'github', secret },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'gh' },
    });
    const jobId = created.json.id;
    const rawBody = JSON.stringify({ action: 'closed' });
    const sig = createHmac('sha256', secret).update(rawBody).digest('hex');
    const res = await postWebhook(h, `/api/webhooks/${jobId}`, rawBody, {
      'x-hub-signature-256': `sha256=${sig}`,
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('sent');
  });

  it('webhook scheme=stripe: t=...,v1=... verified within tolerance', async () => {
    const secret = 'whsec_test';
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'stripe',
      trigger: { type: 'webhook', scheme: 'stripe', secret },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'stripe' },
    });
    const jobId = created.json.id;
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    const res = await postWebhook(h, `/api/webhooks/${jobId}`, rawBody, {
      'stripe-signature': `t=${t},v1=${v1}`,
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('sent');
  });

  it('webhook scheme=none: URL secrecy only, any body accepted', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'none',
      trigger: { type: 'webhook', scheme: 'none' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'none' },
    });
    const jobId = created.json.id;
    const res = await postWebhook(h, `/api/webhooks/${jobId}`, JSON.stringify({ x: 1 }));
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('sent');
  });

  // --- JSONata filter -------------------------------------------------------
  it('filter: matching payload fires; non-matching → filter-rejected (no run/dispatch)', async () => {
    const secret = 'fsecret';
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'filtered',
      trigger: { type: 'webhook', scheme: 'hmac-sha256', secret },
      filter: "payload.action = 'closed' and payload.merged = true",
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'merged' },
    });
    const jobId = created.json.id;
    const url = `/api/webhooks/${jobId}`;
    const sign = (raw: string): string => createHmac('sha256', secret).update(raw).digest('hex');

    // Matching → fires.
    const matchBody = JSON.stringify({ action: 'closed', merged: true });
    const before = h.daemonLink.sent.length;
    const m = await postWebhook(h, url, matchBody, { 'x-patch-signature': sign(matchBody) });
    expect(m.json.status).toBe('sent');
    expect(h.daemonLink.sent.length).toBe(before + 1);

    // Non-matching → rejected, no dispatch.
    const noBody = JSON.stringify({ action: 'opened', merged: false });
    const sentAtReject = h.daemonLink.sent.length;
    const r = await postWebhook(h, url, noBody, { 'x-patch-signature': sign(noBody) });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('filter-rejected');
    expect(h.daemonLink.sent.length).toBe(sentAtReject); // nothing dispatched

    // The run is written from the host's own answer (spec/08 step 6).

    hostConfirms(h.daemonLink);

    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.some((x) => x.status === 'ok')).toBe(true);
    // filter-rejected is logged to webhooks.jsonl (firehose), not as a run.
    const hooks = readJsonl(join(dir, 'webhooks', `${jobId}.jsonl`));
    expect(hooks.some((w) => w.filter === 'reject')).toBe(true);
  });

  it('filter: evaluation error → filter-error logged in runs, no dispatch', async () => {
    // A filter that references an undefined function errors at eval time.
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'ferr',
      trigger: { type: 'webhook', scheme: 'none' },
      filter: '$nonexistentFn(payload)',
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'x' },
    });
    const jobId = created.json.id;
    const before = h.daemonLink.sent.length;
    const res = await postWebhook(h, `/api/webhooks/${jobId}`, JSON.stringify({ a: 1 }));
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('filter-error');
    expect(h.daemonLink.sent.length).toBe(before); // no dispatch
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(h.daemonLink);
    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.some((x) => x.status === 'filter-error')).toBe(true);
  });

  // --- Four action combinations --------------------------------------------
  it('all four action combos produce the correct first user turn', async () => {
    seedChat(h, 'c_existing');
    const mkHook = async (action: unknown): Promise<string> => {
      const c = await api(h, 'POST', '/api/jobs', {
        name: 'combo',
        trigger: { type: 'webhook', scheme: 'none' },
        action,
      });
      expect(c.status).toBe(201);
      return c.json.id;
    };
    const fire = async (jobId: string, body: unknown): Promise<any> => {
      const before = h.daemonLink.sent.length;
      await postWebhook(h, `/api/webhooks/${jobId}`, JSON.stringify(body));
      return h.daemonLink.sent.slice(before).at(-1)!.event;
    };

    // spawn + skill → first turn is "/skill\n\n<json>"
    const j1 = await mkHook({ type: 'spawn', daemonId: 'd1', folder: '/w', skill: 'bus-watch' });
    const e1 = await fire(j1, { stop: 'X' });
    expect(e1.type).toBe('chat.spawn_request');
    const e1Prefix = `/bus-watch\n\n${DEFAULT_JOB_AUTONOMY_PROMPT}\n\n`;
    expect(e1.prompt.startsWith(`${e1Prefix}{`)).toBe(true);
    // The first turn is the filter's root object: `{ payload, now }` (spec/08 § Filter).
    expect(JSON.parse(e1.prompt.slice(e1Prefix.length))).toEqual({
      payload: { stop: 'X' },
      now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });

    // spawn + prompt → mustache substitution
    const j2 = await mkHook({
      type: 'spawn',
      daemonId: 'd1',
      folder: '/w',
      prompt: 'Hi {{payload.who}}',
    });
    const e2 = await fire(j2, { who: 'Tom' });
    expect(e2.type).toBe('chat.spawn_request');
    expect(e2.prompt).toContain(withDefaultAutonomyPrompt('Hi Tom'));

    // message + skill → chat.input with "/skill\n\n<json>"
    const j3 = await mkHook({ type: 'message', chatId: 'c_existing', skill: 'handler' });
    const e3 = await fire(j3, { task: 1 });
    expect(e3.type).toBe('chat.input');
    expect(e3.chatId).toBe('c_existing');
    expect(e3.message.startsWith(`/handler\n\n${DEFAULT_JOB_AUTONOMY_PROMPT}\n\n{`)).toBe(true);

    // message + prompt → chat.input with substituted prompt
    const j4 = await mkHook({
      type: 'message',
      chatId: 'c_existing',
      prompt: 'PR: {{payload.title}}',
    });
    const e4 = await fire(j4, { title: 'My PR' });
    expect(e4.type).toBe('chat.input');
    expect(e4.message).toContain(withDefaultAutonomyPrompt('PR: My PR'));
  });

  // Issue #41: every todoist hit lands in webhooks.jsonl (sig-fail + pass).
  it('todoist trigger: inbound hits logged to webhooks.jsonl', async () => {
    const clientSecret = 'todoist-cs3';
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'todo-hooklog',
      trigger: { type: 'todoist', clientSecret },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', skill: 'todoist-handler' },
    });
    const jobId = created.json.id;
    const url = `/api/webhooks/todoist/${jobId}`;
    const rawBody = JSON.stringify({ event_name: 'item:added', event_data: { id: '7' } });

    // Bad sig → logged as signature fail.
    await postWebhook(h, url, rawBody, { 'x-todoist-hmac-sha256': 'bm90Cg==' });
    // Good sig → logged as pass.
    const sig = createHmac('sha256', clientSecret).update(rawBody).digest('base64');
    await postWebhook(h, url, rawBody, { 'x-todoist-hmac-sha256': sig });

    const hooks = readJsonl(join(dir, 'webhooks', `${jobId}.jsonl`));
    expect(hooks.some((w) => w.scheme === 'todoist' && w.signature === 'fail')).toBe(true);
    expect(hooks.some((w) => w.scheme === 'todoist' && w.filter === 'pass')).toBe(true);
    const got = await api(h, 'GET', `/api/jobs/${jobId}/webhooks`);
    expect(got.json.webhooks.some((w: any) => w.scheme === 'todoist')).toBe(true);
  });

  // --- Logs: runs.jsonl shape ----------------------------------------------
  it('runs.jsonl records {ts,jobId,status,trigger,payloadDigest,action}', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'logshape',
      trigger: { type: 'webhook', scheme: 'none' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'x' },
    });
    const jobId = created.json.id;
    await postWebhook(h, `/api/webhooks/${jobId}`, JSON.stringify({ a: 1 }));
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(h.daemonLink);
    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    const last = runs.at(-1);
    expect(last).toMatchObject({ jobId, status: 'ok', trigger: 'webhook' });
    expect(typeof last.ts).toBe('number');
    expect(typeof last.payloadDigest).toBe('string');
    expect(last.action).toMatchObject({ type: 'spawn', daemonId: 'd1', folder: '/w' });

    // And it's served by GET /api/jobs/:id/runs.
    const got = await api(h, 'GET', `/api/jobs/${jobId}/runs`);
    expect(got.status).toBe(200);
    expect(got.json.runs.length).toBeGreaterThan(0);
  });

  // --- CRUD parity: REST + MCP/UDS rpc-bridge over the same store -----------
  it('REST CRUD and MCP rpc-bridge CRUD operate on the same /data/jobs store', async () => {
    // Create via MCP/UDS rpc-bridge.
    const created = await jobsRpc(h, 'create', {
      body: {
        name: 'rpc-made',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'hi' },
      },
    });
    expect(created.ok).toBe(true);
    const jobId = created.result.id;
    // File exists on disk.
    expect(existsSync(join(dir, 'jobs', `${jobId}.json`))).toBe(true);

    // Visible over REST list + get.
    const list = await api(h, 'GET', '/api/jobs');
    expect(list.json.jobs.some((j: any) => j.id === jobId)).toBe(true);
    const get = await api(h, 'GET', `/api/jobs/${jobId}`);
    expect(get.json.name).toBe('rpc-made');

    // Disable via REST → reflected in MCP get.
    await api(h, 'POST', `/api/jobs/${jobId}/disable`);
    const rpcGet = await jobsRpc(h, 'get', { jobId });
    expect(rpcGet.result.enabled).toBe(false);

    // Enable via MCP → reflected in REST.
    await jobsRpc(h, 'enable', { jobId });
    const reGet = await api(h, 'GET', `/api/jobs/${jobId}`);
    expect(reGet.json.enabled).toBe(true);

    // Update via REST.
    const patched = await api(h, 'PATCH', `/api/jobs/${jobId}`, { name: 'renamed' });
    expect(patched.json.name).toBe('renamed');

    // Delete via MCP → gone everywhere.
    const del = await jobsRpc(h, 'delete', { jobId });
    expect(del.ok).toBe(true);
    expect(existsSync(join(dir, 'jobs', `${jobId}.json`))).toBe(false);
    const after = await api(h, 'GET', `/api/jobs/${jobId}`);
    expect(after.status).toBe(404);
  });

  it('REST rejects invalid cron expression and invalid JSONata (fail loud, no fallback)', async () => {
    const badCron = await api(h, 'POST', '/api/jobs', {
      name: 'badcron',
      trigger: { type: 'cron', expression: 'not a cron' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'x' },
    });
    expect(badCron.status).toBe(400);

    const badFilter = await api(h, 'POST', '/api/jobs', {
      name: 'badfilter',
      trigger: { type: 'webhook', scheme: 'none' },
      filter: 'payload.( unbalanced',
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'x' },
    });
    expect(badFilter.status).toBe(400);
  });

  // --- Offline buffering + flush (D3 integration) --------------------------
  it('offline buffering: webhook while host offline → /data/pending; flush on reconnect', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'offline',
      trigger: { type: 'webhook', scheme: 'none' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'buffered' },
    });
    const jobId = created.json.id;

    // Host goes offline.
    h.daemonLink.setStatus('offline');
    const res = await postWebhook(h, `/api/webhooks/${jobId}`, JSON.stringify({ a: 1 }));
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('buffered');

    // Pending file written.
    const pendingDir = join(dir, 'pending');
    const pendingFiles = existsSync(pendingDir)
      ? readdirSync(pendingDir).filter((n) => n.startsWith(jobId))
      : [];
    expect(pendingFiles.length).toBe(1);
    // Run logged as buffered.
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(h.daemonLink);
    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.at(-1).status).toBe('buffered');

    // Host reconnects → flush dispatches the buffered action.
    // The settings import a host gets on connect is not work.
    // Frames the server sends every host as it attaches are not job work.
    const work = () =>
      h.daemonLink.sent.filter(
        (s) => !s.event.type.startsWith('settings.') && s.event.type !== 'server.queue_mode',
      );
    const before = work().length;
    h.daemonLink.setStatus('online');
    // flush is synchronous in JobDispatcher.onStatus handler.
    expect(work().length).toBe(before + 1);
    const flushed = work().at(-1)!.event as any;
    expect(flushed.type).toBe('chat.spawn_request');
    expect(flushed.prompt).toContain(withDefaultAutonomyPrompt('buffered'));
    // Pending dir drained.
    const remaining = readdirSync(pendingDir).filter((n) => n.startsWith(jobId));
    expect(remaining.length).toBe(0);
  });

  // --- Live wall-clock cron (REAL node-cron, no test hook) ------------------
  // The deterministic cron test above uses CronScheduler.fireForTesting. This
  // one proves the GENUINE scheduler path: a 5-field every-minute job is
  // registered with real node-cron (cron.schedule, timezone:UTC) and we wait
  // for the actual wall-clock tick to fire the action — no fireForTesting, no
  // registerTask hook. This is the spec/08 "create a cron job with a 1-minute
  // expression → verify it fires and spawns a chat" behaviour, exercised live.
  it('cron trigger: REAL node-cron every-minute job fires on a wall-clock tick', async () => {
    const created = await api(h, 'POST', '/api/jobs', {
      name: 'live-cron',
      trigger: { type: 'cron', expression: '* * * * *' },
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/live',
        prompt: 'tick {{payload.firedAt}}',
      },
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id;

    // The real scheduler must have registered a live node-cron task (NOT the
    // test hook) for this job.
    expect(h.built.cronScheduler.hasLiveTask(jobId)).toBe(true);

    const before = h.daemonLink.sent.length;
    // Wait up to ~65s for the genuine wall-clock tick to dispatch a spawn.
    const deadline = Date.now() + 65_000;
    let spawn: { event: WireEvent } | undefined;
    while (Date.now() < deadline) {
      spawn = h.daemonLink.sent.slice(before).find((s) => s.event.type === 'chat.spawn_request');
      if (spawn) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(spawn, 'real node-cron tick should have dispatched a spawn within 65s').toBeDefined();
    const ev = spawn!.event as any;
    expect(ev.folder).toBe('/live');
    expect(ev.prompt.startsWith(DEFAULT_JOB_AUTONOMY_PROMPT)).toBe(true);
    expect(ev.prompt).toMatch(/tick \d{4}-\d{2}-\d{2}T/);
    expect(ev.hidden).toBe(false);
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(h.daemonLink);
    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.at(-1)).toMatchObject({ jobId, status: 'ok', trigger: 'cron' });
  }, 70_000);
});
