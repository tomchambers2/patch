// B2 live: cron firing + dispatch, and offline buffering to /data/pending.
// Run against the running docker-compose.test.yml stack AFTER b2-integration
// has bootstrapped the account (or with a fresh /data; this bootstraps too).

import { execFileSync } from 'node:child_process';
import { generateUserKeypair } from '@patch/auth';

const BASE = process.env.PATCH_E2E_BASE ?? 'http://localhost:13000';
const REPO = new URL('../../..', import.meta.url).pathname;
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
}
function compose(args: string[]): void {
  execFileSync('docker', ['compose', '-f', 'docker-compose.test.yml', ...args], {
    cwd: REPO,
    encoding: 'utf8',
  });
}
async function req(
  method: string,
  path: string,
  opts: { jwt?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.jwt) headers['authorization'] = `Bearer ${opts.jwt}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let body: any;
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
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`TIMEOUT: ${label}`);
}

async function waitForDaemonOnline(): Promise<void> {
  // The real host container self-registers (POSTs register/start +
  // register/complete itself and long-polls register/await for its
  // server-minted daemonKey) once the account exists, then connects inbound to
  // /ws. After a stop/start it re-registers itself the same way. We only wait
  // for healthz to go green.
  await waitFor(
    'host healthz green',
    async () => (await req('GET', '/api/daemon/healthz')).status === 200,
    60_000,
  );
}

async function main(): Promise<void> {
  // The server now owns the account keypair; the client supplies a device
  // public key and the server mints the bootstrap surface credential.
  const device = generateUserKeypair();
  const acct = await req('POST', '/api/auth/account', {
    body: { clientType: 'surface-cli', devicePublicKey: device.publicKey, label: 'b2-cron' },
  });
  if (acct.status !== 200) throw new Error(`account bootstrap failed: ${acct.status} ${acct.text}`);
  const jwt = (acct.body as { credential?: string }).credential;
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error(`account bootstrap returned no credential: ${acct.text}`);
  }
  await waitForDaemonOnline();

  // ---- CRON: every-minute job, confirm it fires + logs a run ----
  const cron = await req('POST', '/api/jobs', {
    jwt,
    body: {
      name: 'b2 cron every minute',
      trigger: { type: 'cron', expression: '* * * * *' },
      action: { type: 'spawn', folder: '/tmp', prompt: 'cron fired at {{payload.firedAt}}' },
      enabled: true,
    },
  });
  check(
    'POST cron job (200/201)',
    [200, 201].includes(cron.status),
    `status=${cron.status} ${cron.text.slice(0, 160)}`,
  );
  const cronId = cron.body.id as string;

  // Wait up to ~80s for the next minute boundary tick → a run entry. Capture
  // the run inside the poll to avoid a re-fetch race.
  let firstRun: any;
  await waitFor(
    'cron fire (run logged)',
    async () => {
      const r = await req('GET', `/api/jobs/${cronId}/runs`, { jwt });
      const runs = (r.body.runs ?? r.body) as any[];
      if (Array.isArray(runs) && runs.length > 0) {
        firstRun = runs.find((x) => x.trigger === 'cron') ?? runs[0];
        return true;
      }
      return false;
    },
    80_000,
  );
  check(
    'cron job fired at UTC minute boundary and logged a run',
    Boolean(firstRun),
    `run=${JSON.stringify(firstRun)}`,
  );
  // Confirm the run dispatched to the host (status ok, not buffered) while online.
  check(
    'cron run dispatched to host (status ok)',
    firstRun?.status === 'ok',
    `run=${JSON.stringify(firstRun)}`,
  );
  check(
    'cron payload digest present (firedAt payload)',
    typeof firstRun?.payloadDigest === 'string',
    `digest=${firstRun?.payloadDigest}`,
  );
  // disable the every-minute job so it stops firing during the offline test.
  await req('POST', `/api/jobs/${cronId}/disable`, { jwt }).catch(() =>
    req('PATCH', `/api/jobs/${cronId}`, { jwt, body: { enabled: false } }),
  );

  // ---- OFFLINE BUFFERING: stop host, fire a webhook, expect /data/pending ----
  const noneJob = await req('POST', '/api/jobs', {
    jwt,
    body: {
      name: 'b2 offline none',
      trigger: { type: 'webhook', scheme: 'none', secret: 'x' },
      action: { type: 'spawn', folder: '/tmp', prompt: 'offline buffered' },
      enabled: true,
    },
  });
  const noneId = noneJob.body.id as string;

  compose(['stop', 'daemon']);
  await waitFor(
    'host offline',
    async () => (await req('GET', '/api/daemon/healthz')).status === 503,
  );

  const fire = await req('POST', `/api/webhooks/${noneId}`, { body: { ping: 1 } });
  check(
    'webhook fired while host offline returns buffered (2xx)',
    fire.status >= 200 && fire.status < 300,
    `status=${fire.status} ${fire.text.slice(0, 120)}`,
  );
  check(
    'dispatch reported status=buffered',
    fire.body?.status === 'buffered',
    `body=${fire.text.slice(0, 160)}`,
  );

  // Confirm a /data/pending/<jobId>-<fireId>.jsonl file exists on the bind mount.
  let pendingFile = '';
  try {
    const ls = execFileSync('ls', ['/tmp/patch-data/pending'], { encoding: 'utf8' });
    pendingFile = ls.split('\n').find((f) => f.startsWith(`${noneId}-`)) ?? '';
  } catch {
    pendingFile = '';
  }
  check(
    'offline action buffered to /data/pending/<jobId>-<fireId>.jsonl',
    pendingFile.length > 0,
    `file=${pendingFile}`,
  );

  // ---- FLUSH ON RECONNECT: restart host, pending file should drain ----
  compose(['start', 'daemon']);
  // The restarted host re-registers itself (server mints a fresh daemonKey)
  // and reconnects inbound to /ws. Wait for the link to come back.
  await waitForDaemonOnline();
  let drained = false;
  await waitFor(
    'pending flushed on reconnect',
    async () => {
      try {
        const ls = execFileSync('ls', ['/tmp/patch-data/pending'], { encoding: 'utf8' });
        drained = !ls.split('\n').some((f) => f.startsWith(`${noneId}-`));
      } catch {
        drained = true;
      }
      return drained;
    },
    30_000,
  ).catch(() => undefined);
  check('pending buffer flushed to host on reconnect', drained);

  process.stdout.write(`\n==== B2 CRON+OFFLINE: ${pass} passed, ${fail} failed ====\n`);
  if (fail > 0) process.exit(1);
}
main().catch((err) => {
  process.stdout.write(`\n!!! ERRORED: ${(err as Error).message}\n`);
  process.exit(2);
});
