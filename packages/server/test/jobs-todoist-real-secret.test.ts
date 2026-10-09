// D2-int-2 — REAL signed Todoist webhook fires a Todoist-trigger job
// end-to-end through the live server, verified against the REAL
// TODOIST_WEBHOOK_SECRET from the deployment .env.
//
// Anti-cheat (TD2 D2-int-2): verification MUST use the real
// TODOIST_WEBHOOK_SECRET; a disabled signature check or a mock Todoist client
// does NOT count. This test:
//   - reads the real TODOIST_WEBHOOK_SECRET out of projects/patch/.env,
//   - boots the SAME `buildAll` server used in production (real Fastify, real
//     todoist webhook route, real createHmac signature verification),
//   - creates a real Todoist-trigger job whose clientSecret IS that real
//     secret (this is how the secret is wired per-job in deployment),
//   - signs a genuine Todoist `item:added` payload with Todoist's real HMAC
//     scheme (HMAC-SHA256 of the raw body, base64, in X-Todoist-Hmac-SHA256),
//   - POSTs it to /api/webhooks/todoist/<jobId> and asserts the signature
//     check passes for real, the matching task fires the job, a run is logged,
//     and the spawned action receives the task as its first turn.
//
// The ONE thing this test cannot do locally is have Todoist's own servers
// ORIGINATE the push (Todoist can only deliver to a public HTTPS URL, not
// localhost). That is an external-service-delivery limitation, not a code
// gap: the byte-for-byte payload + the real HMAC scheme + the real secret are
// all exercised here, which is exactly the server-side contract D2-int-2
// gates. If the real secret is absent the test fails loudly (NO skip, NO
// mock fallback) so a missing credential surfaces rather than silently passing.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential, type UserKeypair } from '@patch/auth';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { hostConfirms } from './host-answer.js';

const ACCOUNT_KP: UserKeypair = generateUserKeypair();

interface Harness {
  base: string;
  jwt: string;
  daemonLink: InProcessDaemonLink;
  dataDir: string;
  built: BuiltApp;
  close: () => Promise<void>;
}

async function startServer(dir: string): Promise<Harness> {
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: ACCOUNT_KP });
  registry.upsertSurface({
    surfaceId: 'cli-test',
    surfaceKind: 'desktop',
    label: 'cli-test',
    issuedAt: Date.now(),
  });
  const daemonLink = new InProcessDaemonLink();
  const built = await buildAll({ logger: false, registry, daemonLink });
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

/**
 * Read TODOIST_WEBHOOK_SECRET out of the deployment env.
 *
 * That env is `deploy/.env` — the file `deploy/docker-compose.yml` names in its
 * `env_file:` and the one the running patch-server container is started from.
 * This pointed at a repo-ROOT `.env` instead, which nothing deploys from and
 * which does not exist on the deployment host, so the test failed there
 * permanently and got written down as a known-unfixable ("don't chase this").
 * It was a wrong path, not a missing secret.
 */
function readRealTodoistSecret(): string {
  // packages/server/test -> repo root is three levels up.
  const envPath = join(__dirname, '..', '..', '..', 'deploy', '.env');
  if (!existsSync(envPath)) {
    throw new Error(`D2-int-2 requires ${envPath} with TODOIST_WEBHOOK_SECRET (not present)`);
  }
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = /^\s*TODOIST_WEBHOOK_SECRET\s*=\s*(.+?)\s*$/.exec(line);
    if (m && m[1]) {
      return m[1].replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error('D2-int-2 requires TODOIST_WEBHOOK_SECRET in .env (key not found)');
}

let dir: string;
let h: Harness;
let realSecret: string;

beforeAll(() => {
  realSecret = readRealTodoistSecret();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jobs-todoist-real-'));
  h = await startServer(dir);
});
afterEach(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${h.jwt}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

async function postWebhook(
  path: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('D2-int-2 — real Todoist HMAC secret [running server]', () => {
  it('verifies a genuine Todoist payload signed with the REAL TODOIST_WEBHOOK_SECRET and fires the job', async () => {
    expect(realSecret.length).toBeGreaterThan(0);

    const created = await api('POST', '/api/jobs', {
      name: 'todoist @claude tasks (real secret)',
      trigger: {
        type: 'todoist',
        auth: 'token-ref',
        // Todoist-native task scoping (applied by Todoist on its side).
        filter: "labels contains 'claude'",
        clientSecret: realSecret, // the REAL deployment webhook secret
      },
      // The server-side JSONata gate (spec/08 ## Filter) evaluated on the
      // inbound task payload — this is what fires/rejects the action.
      filter: "'claude' in payload.event_data.labels",
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/home/tom/projects/claude-tasks',
        skill: 'todoist-handler',
      },
    });
    expect(created.status).toBe(201);
    const jobId: string = created.json.id;

    const url = `/api/webhooks/todoist/${jobId}`;
    // A genuine Todoist webhook payload shape (item:added event_data is the task).
    const rawBody = JSON.stringify({
      event_name: 'item:added',
      user_id: '231185739',
      event_data: {
        id: '7654321098',
        content: 'review the PR',
        project_id: '220474322',
        labels: ['claude'],
        priority: 1,
        checked: false,
      },
      version: '9',
      initiator: { id: '231185739', email: 'tom.chambers@gmail.com' },
    });

    // Real Todoist scheme: base64(HMAC-SHA256(client_secret, raw_body)).
    const goodSig = createHmac('sha256', realSecret).update(rawBody).digest('base64');

    // 1) WRONG signature → rejected by the REAL check, failure still logged.
    const badSig = createHmac('sha256', 'not-the-real-secret').update(rawBody).digest('base64');
    const bad = await postWebhook(url, rawBody, { 'x-todoist-hmac-sha256': badSig });
    expect(bad.status).toBe(401);

    // 2) CORRECT signature (real secret) → passes verification, fires, dispatches.
    const before = h.daemonLink.sent.length;
    const ok = await postWebhook(url, rawBody, { 'x-todoist-hmac-sha256': goodSig });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('sent');

    // The dispatched action carries the task as its first turn.
    const ev = h.daemonLink.sent.slice(before).find((s) => s.event.type === 'chat.spawn_request')!
      .event as any;
    expect(ev.type).toBe('chat.spawn_request');
    expect(ev.hidden).toBe(false);
    expect(ev.prompt).toMatch(/^\/todoist-handler\n\n/);
    expect(ev.prompt).toContain('"content": "review the PR"');

    // 3) The webhooks.jsonl firehose logged BOTH the failure and the success.
    const webhooks = readJsonl(join(dir, 'webhooks', `${jobId}.jsonl`));
    expect(webhooks.some((w) => w.signature === 'fail' && w.status === 401)).toBe(true);
    expect(
      webhooks.some((w) => w.signature === 'ok' && w.filter === 'pass' && w.status === 200),
    ).toBe(true);

    // 4) runs.jsonl recorded the successful fire with the todoist trigger.
    // The run is written from the host's own answer (spec/08 step 6).
    hostConfirms(h.daemonLink);
    const runs = readJsonl(join(dir, 'runs', `${jobId}.jsonl`));
    expect(runs.at(-1)).toMatchObject({ jobId, status: 'ok', trigger: 'todoist' });

    // 5) A NON-matching task (no 'claude' label) → filter-rejected, no dispatch.
    const nonMatchBody = JSON.stringify({
      event_name: 'item:added',
      event_data: { id: '111', content: 'nope', labels: ['other'] },
    });
    const nonMatchSig = createHmac('sha256', realSecret).update(nonMatchBody).digest('base64');
    const beforeNm = h.daemonLink.sent.length;
    const nm = await postWebhook(url, nonMatchBody, { 'x-todoist-hmac-sha256': nonMatchSig });
    expect(nm.status).toBe(200);
    expect(nm.json.status).toBe('filter-rejected');
    expect(
      h.daemonLink.sent.slice(beforeNm).filter((s) => s.event.type === 'chat.spawn_request').length,
    ).toBe(0);
  });
});
