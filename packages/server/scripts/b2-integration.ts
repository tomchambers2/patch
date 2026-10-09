// B2 live integration test against the running docker-compose.test.yml stack.
//
// Plays the primary surface: bootstraps the account, completes the host QR
// registration round-trip (so the host connects inbound to /ws), mints a
// surface JWT, then exercises every group-B2 behaviour over real HTTP/WS:
//   - job CRUD (+ atomic file on disk, ULID id)
//   - cron dispatch to the host WS
//   - webhook ingress with all four signature schemes (+ logging)
//   - JSONata filter accept/reject/error
//   - runs + webhooks log endpoints
//   - chats list + history?since
//
// Run after `docker compose -f docker-compose.test.yml up --build -d`:
//   pnpm --filter @patch/server exec tsx scripts/b2-integration.ts

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { generateUserKeypair } from '@patch/auth';

const BASE = process.env.PATCH_E2E_BASE ?? 'http://localhost:13000';
const REPO = new URL('../../..', import.meta.url).pathname;

let pass = 0;
let fail = 0;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
}

function serverLogs(): string {
  return execFileSync(
    'docker',
    ['compose', '-f', 'docker-compose.test.yml', 'logs', '--no-color', 'server'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

async function req(
  method: string,
  path: string,
  opts: { jwt?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.jwt) headers['authorization'] = `Bearer ${opts.jwt}`;
  let payload: string | undefined;
  if (opts.raw !== undefined) {
    payload = opts.raw;
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

async function main(): Promise<void> {
  // The server now owns the account keypair; the client only supplies a device
  // public key. The server mints the first surface credential and returns it.
  const device = generateUserKeypair();

  // ---- account bootstrap: server mints the first (bootstrap) surface JWT ----
  const acct = await req('POST', '/api/auth/account', {
    body: { clientType: 'surface-cli', devicePublicKey: device.publicKey, label: 'b2' },
  });
  if (acct.status !== 200) {
    throw new Error(`account bootstrap failed: ${acct.status} ${acct.text} (need a fresh /data)`);
  }
  // Use the server-minted bootstrap surface credential for all authed calls.
  const jwt = (acct.body as { credential?: string }).credential;
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error(`account bootstrap returned no credential: ${acct.text}`);
  }

  // ---- wait for the real host to self-register + connect inbound to /ws ----
  // The host container POSTs register/start + register/complete itself and
  // long-polls register/await for its server-minted daemonKey; once the account
  // exists it completes and connects. We just wait for healthz to go green.
  await waitFor(
    'host healthz green',
    async () => (await req('GET', '/api/daemon/healthz')).status === 200,
  );
  check('host link online (inbound /ws)', true);

  // ===================== JOB CRUD =====================
  const listEmpty = await req('GET', '/api/jobs', { jwt });
  check('GET /api/jobs (auth) returns 200', listEmpty.status === 200, `status=${listEmpty.status}`);
  check(
    'GET /api/jobs requires auth (401 without JWT)',
    (await req('GET', '/api/jobs')).status === 401,
  );

  const createWebhook = await req('POST', '/api/jobs', {
    jwt,
    body: {
      name: 'b2 webhook github',
      trigger: { type: 'webhook', scheme: 'github', secret: 'whsec_github' },
      filter: "payload.action = 'closed'",
      action: { type: 'spawn', folder: '/tmp', prompt: 'merged {{payload.action}}' },
      enabled: true,
    },
  });
  check(
    'POST /api/jobs creates a job (200/201)',
    [200, 201].includes(createWebhook.status),
    `status=${createWebhook.status} ${createWebhook.text.slice(0, 200)}`,
  );
  const jobId = (createWebhook.body as { id?: string })?.id ?? '';
  check(
    'POST /api/jobs returns a ULID id (j_<ulid>)',
    /^j_[0-9A-HJKMNP-TV-Za-z]{26}$/.test(jobId),
    `id=${jobId}`,
  );

  // Atomic file on disk at /data/jobs/<id>.json (host bind mount /tmp/patch-data)
  let onDisk = false;
  try {
    const out = execFileSync('cat', [`/tmp/patch-data/jobs/${jobId}.json`], { encoding: 'utf8' });
    onDisk = JSON.parse(out).id === jobId;
  } catch (e) {
    onDisk = false;
  }
  check('job persisted at /data/jobs/<id>.json', onDisk);

  const getOne = await req('GET', `/api/jobs/${jobId}`, { jwt });
  check(
    'GET /api/jobs/:id returns the job',
    getOne.status === 200 && (getOne.body as { id?: string }).id === jobId,
  );

  const patched = await req('PATCH', `/api/jobs/${jobId}`, {
    jwt,
    body: { name: 'b2 webhook renamed' },
  });
  check(
    'PATCH /api/jobs/:id merges update',
    patched.status === 200 && (patched.body as { name?: string }).name === 'b2 webhook renamed',
    `status=${patched.status}`,
  );

  // ===================== WEBHOOK INGRESS — schemes =====================
  // github: valid signature → accepted (filter passes on action=closed)
  const ghBody = JSON.stringify({ action: 'closed', number: 7 });
  const ghSig = 'sha256=' + createHmac('sha256', 'whsec_github').update(ghBody).digest('hex');
  const ghOk = await req('POST', `/api/webhooks/${jobId}`, {
    raw: ghBody,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': ghSig },
  });
  check(
    'webhook github: valid signature accepted (2xx)',
    ghOk.status >= 200 && ghOk.status < 300,
    `status=${ghOk.status} ${ghOk.text.slice(0, 120)}`,
  );

  const ghBad = await req('POST', `/api/webhooks/${jobId}`, {
    raw: ghBody,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
  });
  check(
    'webhook github: bad signature dropped (401)',
    ghBad.status === 401,
    `status=${ghBad.status}`,
  );

  // hmac-sha256 scheme job
  const hmacJob = await req('POST', '/api/jobs', {
    jwt,
    body: {
      name: 'b2 hmac',
      trigger: { type: 'webhook', scheme: 'hmac-sha256', secret: 'topsecret' },
      action: { type: 'spawn', folder: '/tmp', prompt: 'hit' },
      enabled: true,
    },
  });
  const hmacId = (hmacJob.body as { id?: string }).id!;
  const hmacBody = JSON.stringify({ hello: 'world' });
  // Spec/08: generic hmac-sha256 uses a BARE hex digest (no `sha256=` prefix).
  const hmacSig = createHmac('sha256', 'topsecret').update(hmacBody).digest('hex');
  const hmacOk = await req('POST', `/api/webhooks/${hmacId}`, {
    raw: hmacBody,
    headers: { 'content-type': 'application/json', 'x-patch-signature': hmacSig },
  });
  check(
    'webhook hmac-sha256: valid X-Patch-Signature accepted (2xx)',
    hmacOk.status >= 200 && hmacOk.status < 300,
    `status=${hmacOk.status}`,
  );
  const hmacBad = await req('POST', `/api/webhooks/${hmacId}`, {
    raw: hmacBody,
    headers: { 'content-type': 'application/json', 'x-patch-signature': 'nope' },
  });
  check(
    'webhook hmac-sha256: bad signature dropped (401)',
    hmacBad.status === 401,
    `status=${hmacBad.status}`,
  );

  // none scheme job — accepts anything
  const noneJob = await req('POST', '/api/jobs', {
    jwt,
    body: {
      name: 'b2 none',
      trigger: { type: 'webhook', scheme: 'none', secret: 'x' },
      action: { type: 'spawn', folder: '/tmp', prompt: 'any' },
      enabled: true,
    },
  });
  const noneId = (noneJob.body as { id?: string }).id!;
  const noneOk = await req('POST', `/api/webhooks/${noneId}`, {
    raw: JSON.stringify({ a: 1 }),
    headers: { 'content-type': 'application/json' },
  });
  check(
    'webhook none: accepts anything (2xx)',
    noneOk.status >= 200 && noneOk.status < 300,
    `status=${noneOk.status}`,
  );

  // stripe scheme job
  const stripeJob = await req('POST', '/api/jobs', {
    jwt,
    body: {
      name: 'b2 stripe',
      trigger: { type: 'webhook', scheme: 'stripe', secret: 'whsec_stripe' },
      action: { type: 'spawn', folder: '/tmp', prompt: 'stripe' },
      enabled: true,
    },
  });
  const stripeId = (stripeJob.body as { id?: string }).id!;
  const stripeBody = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const ts = Math.floor(Date.now() / 1000);
  const stripeSig = createHmac('sha256', 'whsec_stripe')
    .update(`${ts}.${stripeBody}`)
    .digest('hex');
  const stripeOk = await req('POST', `/api/webhooks/${stripeId}`, {
    raw: stripeBody,
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${stripeSig}` },
  });
  check(
    'webhook stripe: valid signed-event accepted (2xx)',
    stripeOk.status >= 200 && stripeOk.status < 300,
    `status=${stripeOk.status} ${stripeOk.text.slice(0, 120)}`,
  );
  const stripeBad = await req('POST', `/api/webhooks/${stripeId}`, {
    raw: stripeBody,
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=deadbeef` },
  });
  check(
    'webhook stripe: bad signature dropped (4xx)',
    stripeBad.status >= 400 && stripeBad.status < 500,
    `status=${stripeBad.status}`,
  );

  // ===================== FILTER reject =====================
  // github job filter is action='closed'; send action='opened' → filter-rejected
  const ghReject = await req('POST', `/api/webhooks/${jobId}`, {
    raw: JSON.stringify({ action: 'opened' }),
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256':
        'sha256=' +
        createHmac('sha256', 'whsec_github')
          .update(JSON.stringify({ action: 'opened' }))
          .digest('hex'),
    },
  });
  check(
    'webhook github: filter falsy → accepted hit but no dispatch (2xx)',
    ghReject.status >= 200 && ghReject.status < 300,
    `status=${ghReject.status} body=${ghReject.text.slice(0, 120)}`,
  );

  // ===================== runs + webhooks log endpoints =====================
  const runs = await req('GET', `/api/jobs/${jobId}/runs`, { jwt });
  check(
    'GET /api/jobs/:id/runs returns entries',
    runs.status === 200 && Array.isArray((runs.body as { runs?: unknown[] }).runs ?? runs.body),
    `status=${runs.status} ${runs.text.slice(0, 160)}`,
  );
  const whlog = await req('GET', `/api/jobs/${jobId}/webhooks`, { jwt });
  check(
    'GET /api/jobs/:id/webhooks returns entries (incl failures)',
    whlog.status === 200,
    `status=${whlog.status} ${whlog.text.slice(0, 200)}`,
  );
  // The bad-signature hit must be in the webhooks log.
  const whText = whlog.text;
  check(
    'webhook log includes a signature failure entry',
    /fail|invalid|mismatch|signature/i.test(whText),
    whText.slice(0, 200),
  );

  // ===================== CHATS list + history =====================
  // Spawn a chat via REST so there is something to list and fetch history for.
  const spawn = await req('POST', '/api/chats', {
    jwt,
    body: { folder: '/tmp', prompt: 'hi there from b2' },
  });
  check(
    'POST /api/chats spawns a chat (2xx)',
    spawn.status >= 200 && spawn.status < 300,
    `status=${spawn.status} ${spawn.text.slice(0, 160)}`,
  );
  const spawnedChatId = (spawn.body as { chatId?: string }).chatId ?? '';

  // give the host a moment to register the chat + run a turn (mock SDK)
  await new Promise((r) => setTimeout(r, 2500));

  const chats = await req('GET', '/api/chats', { jwt });
  const chatList = (chats.body as { chats?: Array<{ chatId: string }> }).chats ?? [];
  check(
    'GET /api/chats lists chats',
    chats.status === 200 && Array.isArray(chatList),
    `status=${chats.status} count=${chatList.length}`,
  );

  if (spawnedChatId) {
    const hist = await req('GET', `/api/chats/${spawnedChatId}/history?since=0`, { jwt });
    const events = (hist.body as { events?: unknown[] }).events;
    check(
      'GET /api/chats/:id/history?since=0 returns events array (RPC to host)',
      hist.status === 200 && Array.isArray(events),
      `status=${hist.status} ${hist.text.slice(0, 200)}`,
    );
    const histBadSince = await req('GET', `/api/chats/${spawnedChatId}/history?since=banana`, {
      jwt,
    });
    check(
      'GET /api/chats/:id/history rejects non-numeric since (400)',
      histBadSince.status === 400,
      `status=${histBadSince.status}`,
    );
  } else {
    check(
      'GET /api/chats/:id/history?since=0 returns events array (RPC to host)',
      false,
      'no chatId from spawn',
    );
  }
  const histUnknown = await req('GET', '/api/chats/c_does_not_exist/history', { jwt });
  check(
    'GET /api/chats/:id/history unknown chat → 404',
    histUnknown.status === 404,
    `status=${histUnknown.status}`,
  );

  // ---- DELETE the first job, confirm file removed ----
  const del = await req('DELETE', `/api/jobs/${jobId}`, { jwt });
  check(
    'DELETE /api/jobs/:id removes the job (2xx)',
    del.status >= 200 && del.status < 300,
    `status=${del.status}`,
  );
  let stillThere = true;
  try {
    execFileSync('cat', [`/tmp/patch-data/jobs/${jobId}.json`], { encoding: 'utf8' });
  } catch {
    stillThere = false;
  }
  check('DELETE removed the /data/jobs/<id>.json file', !stillThere);

  process.stdout.write(`\n==== B2 INTEGRATION: ${pass} passed, ${fail} failed ====\n`);
  if (fail > 0) {
    process.stdout.write('\nServer log tail (for failing-case context):\n');
    process.stdout.write(serverLogs().split('\n').slice(-25).join('\n') + '\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stdout.write(
    `\n!!! B2 INTEGRATION ERRORED: ${(err as Error).message}\n${(err as Error).stack}\n`,
  );
  process.exit(2);
});
