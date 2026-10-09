// Provision the docker-compose.test.yml stack: bootstrap the account and run
// the real host QR registration round-trip against the running containers.
//
// Per spec/10 the server is the credential authority: it generates the account
// keypair and mints all credentials. This script only needs to BOOTSTRAP the
// account; the real host container then self-registers (it POSTs
// register/start + register/complete itself and long-polls register/await for
// its server-minted daemonKey — see packages/daemon/src/registration.ts). Once
// the account exists, the host's registration round-trip completes and it
// connects inbound to /ws — exactly the production flow, minus the human surface.
//
// Run after `docker compose -f docker-compose.test.yml up --build -d`:
//   pnpm --filter @patch/server exec tsx scripts/provision-test-stack.ts

import { generateUserKeypair } from '@patch/auth';

const BASE = process.env.PATCH_E2E_BASE ?? 'http://localhost:13000';

async function postJson(
  path: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  // public key. Generate a device keypair for this bootstrap surface.
  const device = generateUserKeypair();
  process.stdout.write(
    `\n=== provisioner: bootstrap device pub ${device.publicKey.slice(0, 12)}…\n`,
  );

  const acct = await postJson('/api/auth/account', {
    clientType: 'surface-cli',
    devicePublicKey: device.publicKey,
    label: 'test-stack-provisioner',
  });
  if (acct.status !== 200)
    throw new Error(`account bootstrap failed: ${acct.status} ${JSON.stringify(acct.body)}`);
  process.stdout.write('=== provisioner: account bootstrapped + first surface enrolled ✓\n');

  // The real host container self-registers once the account exists: it POSTs
  // register/start + register/complete and long-polls register/await for its
  // server-minted daemonKey, then connects inbound to /ws. We just wait for it.
  await waitFor('host healthz green', async () => {
    const res = await fetch(`${BASE}/api/daemon/healthz`);
    return res.status === 200;
  });
  process.stdout.write('=== provisioner: /api/daemon/healthz GREEN — host connected inbound ✓\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stdout.write(`\n!!! PROVISION FAILED: ${(err as Error).message}\n`);
    process.exit(1);
  });
