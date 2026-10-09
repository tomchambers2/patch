// One-time migration: give a legacy account its server-side private key.
//
// Accounts bootstrapped before the server became the credential authority
// (spec/10-auth) persisted only `userPublicKey`; the first surface kept the
// private key locally (e.g. the CLI's `~/.patch/identity.key`). The current
// server signs every surface/daemon credential with the account PRIVATE key,
// so `registry.json` now requires `account.userPrivateKey` — and the server
// cannot derive it from the public key. `Registry.load()` therefore refuses to
// boot a legacy registry (with an actionable error pointing here).
//
// This migrator injects the recovered private key into the account record,
// AFTER verifying it derives to the account's existing `userPublicKey` (so a
// wrong key can never be written). It is lossless: the accountId/publicKey are
// unchanged, so all chats, threads, surfaces, and the host key stay bound.
//
// Invocation:
//   pnpm --filter @patch/server migrate:account-key \
//     --data-dir ~/.patch-server/data --key-file ~/.patch/identity.key
//   # or pass the raw base64url seed directly:
//   pnpm --filter @patch/server migrate:account-key --data-dir <dir> --key <b64url>
//
// NO FALLBACKS: missing/invalid args crash; a key that doesn't match the
// account public key is refused; an already-migrated registry is a no-op.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadUserIdentity } from '@patch/auth';

function fail(msg: string): never {
  process.stderr.write(`migrate-account-key: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { dataDir: string; key: string } {
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
  if (!dataDir) fail('--data-dir <path> or PATCH_DATA_DIR is required');
  if (!existsSync(dataDir)) fail(`data dir does not exist: ${dataDir}`);

  // The account private key: either inline (--key) or read from a file
  // (--key-file). The file may be a raw base64url seed (e.g. the CLI's
  // `identity.key`) OR a `.user-keypair.json` object with a `privateKey` field.
  let key = args.get('key') ?? null;
  const keyFile = args.get('key-file');
  if (!key && keyFile) {
    if (!existsSync(keyFile)) fail(`key file does not exist: ${keyFile}`);
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { privateKey?: unknown };
      if (typeof parsed.privateKey !== 'string') {
        fail(`key file ${keyFile} is JSON but has no string "privateKey" field`);
      }
      key = parsed.privateKey;
    } else {
      key = raw;
    }
  }
  if (!key) fail('--key <b64url> or --key-file <path> is required');

  return { dataDir, key };
}

export interface MigrateResult {
  status: 'migrated' | 'already-current';
  accountId: string;
  userPublicKey: string;
  registryPath: string;
  backupPath?: string;
}

export function migrateAccountKey(opts: { dataDir: string; key: string }): MigrateResult {
  const registryPath = join(opts.dataDir, 'registry.json');
  if (!existsSync(registryPath)) fail(`no registry.json at ${registryPath}`);

  const rawObj = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    account?: { accountId?: string; userPublicKey?: string; userPrivateKey?: string } | null;
  };
  const account = rawObj.account;
  if (!account || typeof account !== 'object')
    fail('registry has no bootstrapped account — nothing to migrate');
  if (typeof account.userPublicKey !== 'string') fail('account has no userPublicKey');

  // Verify the supplied key derives to the account's public key BEFORE writing.
  // loadUserIdentity throws on a malformed seed.
  const derived = loadUserIdentity(opts.key);
  if (derived.publicKey !== account.userPublicKey) {
    fail(
      `supplied key derives to ${derived.publicKey} but the account's userPublicKey is ${account.userPublicKey} — refusing to write a mismatched key`,
    );
  }

  // Idempotent: already has the (correct) key → no-op.
  if (account.userPrivateKey === opts.key) {
    return {
      status: 'already-current',
      accountId: account.accountId ?? account.userPublicKey,
      userPublicKey: account.userPublicKey,
      registryPath,
    };
  }
  if (typeof account.userPrivateKey === 'string' && account.userPrivateKey.length > 0) {
    fail(
      'account already has a DIFFERENT userPrivateKey — refusing to overwrite (investigate manually)',
    );
  }

  // Back up, then inject the key and write atomically (temp + fsync + rename).
  const backupPath = `${registryPath}.bak-premigrate`;
  copyFileSync(registryPath, backupPath);
  account.userPrivateKey = opts.key;
  const tmp = `${registryPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(rawObj, null, 2), 'utf8');
  const fd = openSync(tmp, 'r');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, registryPath);

  return {
    status: 'migrated',
    accountId: account.accountId ?? account.userPublicKey,
    userPublicKey: account.userPublicKey,
    registryPath,
    backupPath,
  };
}

function main(): void {
  const { dataDir, key } = parseArgs(process.argv.slice(2));
  const result = migrateAccountKey({ dataDir, key });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status === 'migrated') {
    process.stderr.write(
      `migrate-account-key: injected userPrivateKey for account ${result.userPublicKey} (backup: ${result.backupPath})\n`,
    );
  } else {
    process.stderr.write(`migrate-account-key: account already current — no change\n`);
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('migrate-account-key.ts') ||
    process.argv[1].endsWith('migrate-account-key.js'));
if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    fail((err as Error).stack ?? (err as Error).message);
  }
}
