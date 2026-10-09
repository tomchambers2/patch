// Dev/test fixture: register a host WITHOUT the QR flow.
//
// Companion to mint-surface-jwt.ts. The web dev-auth harness mints a `web`
// surface credential; this script does the host half so the special threads
// (Manager/Speakers) actually appear in the running app:
//   1) read the SAME user keypair the surface fixture persisted
//      (<dataDir>/.user-keypair.json) so the daemonKey is signed by the same
//      account the server's registry was bootstrapped with
//   2) bootstrap the singleton account in <dataDir>/registry.json if absent
//   3) mint a long-lived daemon-key EdDSA-JWT (signed by the user private key)
//   4) record it in the registry via setDaemonKey — REQUIRED: the server's WS
//      hello gate rejects a host whose daemonId has no DaemonKeyRecord
//   5) write the daemonKey to <patchHome>/daemon.key so the host picks it up
//      on boot instead of falling into the QR registration flow
//
// IMPORTANT ordering: run this BEFORE the server boots. The server loads
// registry.json into memory once at startup, so setDaemonKey must already be
// on disk when it starts (same constraint as the account bootstrap).
//
// NO FALLBACKS: missing keypair / data dir / args crash loudly.
//
// Invocation:
//   pnpm --filter @patch/server fixtures:mint-daemon-key \
//     --data-dir /path/.dev-data --patch-home /path/.dev-data/home \
//     --daemon-id dev-daemon-1 --label local-dev

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadUserIdentity, mintDaemonKey } from '@patch/auth';
import { Registry } from '../registry.js';

const KEYPAIR_FILE = '.user-keypair.json';

interface StoredKeypair {
  accountLabel: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

function fail(msg: string): never {
  process.stderr.write(`mint-daemon-key: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  dataDir: string;
  patchHome: string | null;
  daemonId: string;
  label: string;
} {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fail(`flag --${key} requires a value`);
    args.set(key, next);
    i++;
  }
  const dataDir = args.get('data-dir') ?? process.env.PATCH_DATA_DIR;
  if (!dataDir) fail('--data-dir <path> or PATCH_DATA_DIR env is required (NO FALLBACK)');
  if (!existsSync(dataDir!)) fail(`data dir does not exist: ${dataDir} (NO FALLBACK)`);
  if (!statSync(dataDir!).isDirectory()) fail(`data dir is not a directory: ${dataDir}`);
  return {
    dataDir: dataDir!,
    patchHome: args.get('patch-home') ?? null,
    daemonId: args.get('daemon-id') ?? 'dev-daemon-1',
    label: args.get('label') ?? 'local-dev',
  };
}

function loadKeypair(dataDir: string): StoredKeypair {
  const path = join(dataDir, KEYPAIR_FILE);
  if (!existsSync(path)) {
    fail(
      `no keypair at ${path} — run fixtures:mint-surface-jwt first so the account keypair exists`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredKeypair;
  // Re-derive to verify integrity — loadUserIdentity throws on a bad seed.
  const reloaded = loadUserIdentity(parsed.privateKey);
  if (reloaded.publicKey !== parsed.publicKey) fail(`keypair file ${path} corrupted`);
  return parsed;
}

/** Atomic write to <patchHome>/daemon.key with mode 0600. */
function writeDaemonKeyFile(patchHome: string, credential: string): string {
  const path = join(patchHome, 'daemon.key');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, credential, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const keypair = loadKeypair(args.dataDir);

  const registry = Registry.load(args.dataDir);
  // Dev/test fixture: seed the registry with this script's own keypair so it
  // can mint a daemonKey. Idempotent across re-runs.
  if (registry.getAccount() === null) {
    registry.bootstrapAccount({ keypair });
  }

  const daemonKey = await mintDaemonKey({
    userPrivateKey: keypair.privateKey,
    daemonId: args.daemonId,
    label: args.label,
  });

  // REQUIRED so the server's WS hello gate accepts this host.
  registry.setDaemonKey({
    daemonId: args.daemonId,
    publicKey: keypair.publicKey,
    issuedAt: Date.now(),
  });

  let daemonKeyPath: string | null = null;
  if (args.patchHome) {
    daemonKeyPath = writeDaemonKeyFile(args.patchHome, daemonKey);
  }

  process.stdout.write(
    JSON.stringify(
      {
        daemonId: args.daemonId,
        label: args.label,
        accountPublicKey: keypair.publicKey,
        daemonKeyPath,
        daemonKey,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err: Error) => fail(err.stack ?? err.message));
