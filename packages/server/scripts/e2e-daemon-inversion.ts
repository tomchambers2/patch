// Live end-to-end proof of the host↔server auth inversion (spec/10).
//
// Spawns the REAL server and REAL host as child processes, runs the genuine
// QR registration round-trip (simulating the primary surface that holds the
// user master key), then asserts:
//   1. /api/daemon/healthz goes green (host authenticated INBOUND via /ws).
//   2. The host log shows it authenticated with auth.ok.
//   3. A surface connecting to /ws receives daemon.online (separate host
//      connection record + fan-out).
//   4. Revoking the host terminates its live socket → healthz goes red.
//
// Run: pnpm --filter @patch/server exec tsx scripts/e2e-daemon-inversion.ts
//
// NO FALLBACKS: every step throws loudly on failure.

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';
import { generateUserKeypair } from '@patch/auth';

const SERVER_PORT = 3100;
const BASE = `http://localhost:${SERVER_PORT}`;
const WS_URL = `ws://localhost:${SERVER_PORT}/ws`;
const HOME = '/tmp/patch-e2e-home';
const DATA = '/tmp/patch-e2e-data';
const REPO = new URL('../../..', import.meta.url).pathname;

const procs: ChildProcess[] = [];
let daemonLog = '';

function log(msg: string): void {
  process.stdout.write(`\n=== ${msg}\n`);
}

function spawnService(
  filter: string,
  env: Record<string, string>,
  onStdout?: (s: string) => void,
): ChildProcess {
  // detached:true puts the child (and its tsx/node grandchildren) in its own
  // process group so cleanup() can SIGKILL the WHOLE group via -pid — otherwise
  // `pnpm → tsx → node` leaks the real server/daemon, leaving ports bound.
  const p = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  procs.push(p);
  const sink = (buf: Buffer): void => {
    const s = buf.toString('utf8');
    onStdout?.(s);
  };
  p.stdout!.on('data', sink);
  p.stderr!.on('data', sink);
  return p;
}

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function postJson(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function cleanup(): void {
  for (const p of procs) {
    if (p.pid === undefined) continue;
    try {
      // Negative pid → kill the whole process group (pnpm + tsx + node).
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      try {
        p.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }
}

async function main(): Promise<void> {
  // Fresh state.
  for (const d of [HOME, DATA]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }

  // The server now owns the account keypair; the client only supplies a device
  // public key. This is the device key for the bootstrap (primary) surface that
  // the server enrols + mints a credential for on /api/auth/account.
  const surfaceDevice = generateUserKeypair();
  log(`generated bootstrap surface device keypair (pub ${surfaceDevice.publicKey.slice(0, 12)}…)`);

  // 1. Start server.
  log('starting server');
  spawnService('@patch/server', {
    PORT: String(SERVER_PORT),
    HOST: '127.0.0.1',
    PATCH_DATA_DIR: DATA,
    PATCH_INTERNAL_TOKEN: 'e2e-internal-token-aaaaaaaaaaaa',
    LOG_LEVEL: 'info',
  });
  await waitFor('server /api/healthz', async () => (await getJson('/api/healthz')).status === 200);
  log('server healthy');

  // 2. Bootstrap the account. The SERVER generates the account keypair and
  //    mints this first (primary) surface's credential — we keep it for the WS
  //    connect + revoke steps below (no client-side minting anymore).
  const acct = await postJson('/api/auth/account', {
    clientType: 'surface-web',
    devicePublicKey: surfaceDevice.publicKey,
    label: 'e2e-surface',
  });
  if (acct.status !== 200)
    throw new Error(`account bootstrap failed: ${acct.status} ${JSON.stringify(acct.body)}`);
  const surfaceCred = (acct.body as { credential?: string }).credential;
  if (typeof surfaceCred !== 'string' || surfaceCred.length === 0)
    throw new Error(`account bootstrap returned no credential: ${JSON.stringify(acct.body)}`);
  log('account bootstrapped + first surface credential minted by server');

  // host liveness should be RED before the host connects.
  const preHealth = await getJson('/api/daemon/healthz');
  if (preHealth.status === 200)
    throw new Error('host healthz should be 503 before the host connects');
  log(`host healthz red pre-connect (status ${preHealth.status}) ✓`);

  // 3. Start the host with an EMPTY home → it must run registration.
  //    The SERVER is the credential authority: the host POSTs register/start
  //    + register/complete ITSELF and long-polls register/await for its
  //    server-minted daemonKey (packages/daemon/src/registration.ts). The test
  //    no longer plays a surface to mint/complete — once the account exists, the
  //    host self-registers and connects inbound to /ws.
  log('starting host (no daemon.key → registration mode)');
  spawnService(
    '@patch/daemon',
    {
      PATCH_HOME: HOME,
      PATCH_SERVER_URL: BASE,
      PATCH_SERVER_WS_URL: WS_URL,
      // This e2e is about the REGISTRATION handshake — who mints the host key,
      // and the host connecting inbound with it. It never runs a turn or a word
      // of audio, so the three backends below would otherwise demand credentials
      // and sidecars to stand up something the test never looks at.
      // mock-check:allow registration e2e; never runs a turn
      SDK_BACKEND: 'mock',
      // mock-check:allow registration e2e; never transcribes
      WHISPER_BACKEND: 'mock',
      // mock-check:allow registration e2e; never speaks
      KOKORO_BACKEND: 'mock',
      KOKORO_MODEL_PATH: '/tmp',
      PATCH_DAEMON_LOCAL_KEY: 'e2e-local-key-aaaa',
      PATCH_INTERNAL_TOKEN: 'e2e-internal-token-aaaaaaaaaaaa',
      LOG_LEVEL: 'info',
    },
    (s) => {
      daemonLog += s;
    },
  );

  // 4. Host self-registers, receives the server-minted key (await long-poll),
  //    writes it, connects, authes.
  await waitFor(
    'host /api/daemon/healthz green',
    async () => (await getJson('/api/daemon/healthz')).status === 200,
    30_000,
  );
  log('host healthz GREEN — host authenticated inbound via /ws ✓');

  await waitFor('host auth.ok in log', async () => /authenticated \(auth\.ok\)/.test(daemonLog));
  log('host log shows auth.ok ✓');

  // 7. A surface connects → must receive daemon.online (fan-out + separate
  //    record). Reuse the bootstrap surface credential the server minted above.
  const sawDaemonOnline = await new Promise<boolean>((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('surface did not receive daemon.online within 10s'));
    }, 10_000);
    let authed = false;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientType: 'surface-web',
          clientVersion: '0.0.0',
          auth: surfaceCred,
        }),
      );
    });
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString('utf8')) as { type: string };
      if (ev.type === 'auth.ok') authed = true;
      if (ev.type === 'daemon.online' && authed) {
        clearTimeout(t);
        ws.close();
        resolve(true);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  if (!sawDaemonOnline) throw new Error('surface never saw daemon.online');
  log('surface connected via EdDSA-JWT and received daemon.online ✓');

  // 8. Revoke the host → live socket terminated → healthz red. The host
  //    chose its own id during self-registration; recover it from its log.
  const daemonIdMatch = daemonLog.match(/"daemonId":"([0-9A-HJKMNP-TV-Z]+)"/);
  if (!daemonIdMatch) throw new Error('could not recover daemonId from host log for revoke');
  const daemonId = daemonIdMatch[1];
  const revoke = await postJson(
    '/api/auth/revoke',
    { id: daemonId },
    { authorization: `Bearer ${surfaceCred}` },
  );
  if (revoke.status !== 200)
    throw new Error(`revoke failed: ${revoke.status} ${JSON.stringify(revoke.body)}`);
  await waitFor(
    'host healthz red after revoke',
    async () => (await getJson('/api/daemon/healthz')).status !== 200,
    15_000,
  );
  log('host revoked → live socket terminated → healthz red ✓ (decommission)');

  log('ALL E2E ASSERTIONS PASSED ✅');
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    process.stdout.write(`\n!!! E2E FAILED: ${(err as Error).message}\n`);
    process.stdout.write(`\n----- last 2k of host log -----\n${daemonLog.slice(-2000)}\n`);
    cleanup();
    process.exit(1);
  });
