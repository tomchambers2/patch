// The machine's own identity: a stable `daemonId` and an Ed25519 keypair.
//
// spec/10-auth.md § Host registration — "the host on the new host submits
// the nonce and its public key". The keypair is minted once, on the machine, and
// kept beside the host's other secrets under the host user's own `~/.patch`.
//
// It is what makes re-running the installer idempotent (spec/10 § Host
// registration: "re-running the installer on a host that is already registered
// re-uses its stored daemonKey rather than creating a duplicate host"): the
// daemonId is read back from this file rather than minted afresh, so a second
// install on the same machine is the same machine.
//
// NO FALLBACK: a malformed identity file is an error, not a reason to mint a new
// identity — silently re-minting would register the machine twice.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateUserKeypair, loadUserIdentity } from '@patch/auth';
import { ulid } from 'ulid';
import { z } from 'zod';

const DaemonIdentityFile = z
  .object({
    daemonId: z.string().min(1),
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

export type DaemonIdentity = z.infer<typeof DaemonIdentityFile>;

export function daemonIdentityPath(patchHome: string): string {
  return join(patchHome, 'daemon-identity.json');
}

/** Read the identity if this machine already has one. */
export function readDaemonIdentity(patchHome: string): DaemonIdentity | undefined {
  const path = daemonIdentityPath(patchHome);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = DaemonIdentityFile.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `host identity at ${path} is malformed: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
    );
  }
  // The public key must actually belong to the private key, or the machine
  // would register a key it cannot prove it holds.
  const derived = loadUserIdentity(parsed.data.privateKey);
  if (derived.publicKey !== parsed.data.publicKey) {
    throw new Error(`host identity at ${path}: publicKey does not match privateKey`);
  }
  return parsed.data;
}

/**
 * The machine's identity, minted on first call and stable thereafter.
 * Written 0600 beside `daemon.key` / `local.key`.
 */
export function loadOrCreateDaemonIdentity(
  patchHome: string,
  opts: { now?: () => Date } = {},
): DaemonIdentity {
  const existing = readDaemonIdentity(patchHome);
  if (existing) return existing;

  const keypair = generateUserKeypair();
  const identity: DaemonIdentity = {
    daemonId: ulid(),
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  const path = daemonIdentityPath(patchHome);
  mkdirSync(patchHome, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return identity;
}
