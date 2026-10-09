// The server administrator's way to pair a first device (spec/11 § Pairing the
// first device): ask the RUNNING server, over its loopback address, for a
// pairing code. The first call also makes the account, so a freshly installed
// server needs no other tool.
//
// The administrator is a surface like any other: it holds a credential of its
// own in `<data>/admin.credential`, minted when it made the account, and uses it
// to open each pairing window.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import { encodePairingUri } from '@patch/wire';

export interface PairAdminOptions {
  /** The running server, as this machine reaches it (`http://127.0.0.1:3000`). */
  baseUrl: string;
  dataDir: string;
  /**
   * Where the new device will reach the server (`https://patch.example.com`).
   * Absent, the server says how itself — its relay, if it has one.
   */
  publicUrl?: string;
}

export interface PairAdminResult {
  /** The `patch-pair://` code to show as a QR. */
  uri: string;
  nonce: string;
  expiresAt: number;
  /** True when this call made the account (the first run on a fresh server). */
  createdAccount: boolean;
}

const CREDENTIAL_FILE = 'admin.credential';

async function call<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

export async function pairNewSurface(opts: PairAdminOptions): Promise<PairAdminResult> {
  const file = join(opts.dataDir, CREDENTIAL_FILE);
  let credential: string;
  let createdAccount = false;
  if (existsSync(file)) {
    credential = readFileSync(file, 'utf8').trim();
  } else {
    const kp = generateUserKeypair();
    const made = await call<{ credential?: string; error?: string }>(
      opts.baseUrl,
      '/api/auth/account',
      { clientType: 'surface-cli', devicePublicKey: kp.publicKey, label: 'server-admin' },
    );
    if (made.status === 409) {
      throw new Error(
        'This server already has an owner, and it is not this machine. Pair a new device from one that is already linked (Settings → Devices → Link a device).',
      );
    }
    if (made.status !== 200 || !made.json.credential) {
      throw new Error(`making the account failed: ${made.status} ${JSON.stringify(made.json)}`);
    }
    credential = made.json.credential;
    // Written before anything else is asked of the server, so a failure after
    // this point can be repeated without a second account being refused.
    writeFileSync(file, credential, { mode: 0o600 });
    chmodSync(file, 0o600);
    createdAccount = true;
  }
  const started = await call<{ nonce?: string; expiresAt?: number; uri?: string; error?: string }>(
    opts.baseUrl,
    '/api/auth/pair/start',
    {},
    credential,
  );
  if (started.status === 401) {
    throw new Error(
      `The credential in ${file} is no longer accepted by the server (revoked, or from another server). Delete it and pair from a device that is already linked.`,
    );
  }
  if (started.status !== 200 || !started.json.nonce || started.json.expiresAt === undefined) {
    throw new Error(
      `opening a pairing window failed: ${started.status} ${JSON.stringify(started.json)}`,
    );
  }
  const uri = opts.publicUrl
    ? encodePairingUri({ nonce: started.json.nonce, server: opts.publicUrl })
    : started.json.uri;
  if (!uri) {
    throw new Error(
      'This server has no address to put in a pairing code: set PATCH_PUBLIC_URL (or PATCH_RELAY_URL) in server.env, or pass --url.',
    );
  }
  return {
    uri,
    nonce: started.json.nonce,
    expiresAt: started.json.expiresAt,
    createdAccount,
  };
}
