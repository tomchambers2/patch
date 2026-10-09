// Test fixture: mint a valid surface-bound EdDSA-JWT against the test stack.
//
// Resolves B-24-2 — until this script existed, every audio-WSS test was
// forced into reject-path-only coverage because there was no fixture/CLI
// that produced a fully-bootstrapped surface JWT. With this script,
// web/desktop/mobile/device surfaces can all be exercised end-to-end:
//   1) generate (or reuse) a user keypair persisted alongside registry.json
//   2) bootstrap the singleton account in /data/registry.json if absent
//   3) mint a surface-bound EdDSA-JWT signed by the user private key
//   4) upsert the surface into the registry
//
// The minted JWT is a real surface credential — accepted by `POST
// /api/voice/token` (which the host's audio WSS then verifies via the
// shared HMAC `PATCH_INTERNAL_TOKEN`). Reusable for any surface kind.
//
// Invocation:
//   pnpm --filter @patch/server fixtures:mint-surface-jwt \
//     --account dev-tom --surface mock-device-1 --kind device
//
// NO FALLBACKS: invalid arguments crash; missing data dir crashes; the
// script never silently picks a default for required fields.
//
// IMPORTANT: this script writes a private key seed to disk
// (`<dataDir>/.user-keypair.json`). It is for the DOCKER TEST STACK ONLY —
// production user identities live in the user's Claude OAuth bundle.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateUserKeypair,
  loadUserIdentity,
  mintSurfaceCredential,
  type SurfaceKind,
  type UserKeypair,
} from '@patch/auth';
import { Registry } from '../registry.js';

const AUDIO_KINDS = ['web', 'desktop', 'mobile', 'device'] as const;
type AudioKind = (typeof AUDIO_KINDS)[number];

interface CliArgs {
  account: string;
  surface: string;
  kind: AudioKind;
  ttl: number;
  output: string | null;
  dataDir: string;
}

function fail(msg: string): never {
  process.stderr.write(`mint-surface-jwt: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      fail(`flag --${key} requires a value`);
    }
    args.set(key, next);
    i++;
  }

  const account = args.get('account');
  const surface = args.get('surface');
  const kind = args.get('kind');
  if (!account) fail('--account <id> is required');
  if (!surface) fail('--surface <id> is required');
  if (!kind) fail('--kind <web|desktop|mobile|device> is required');
  if (!(AUDIO_KINDS as readonly string[]).includes(kind)) {
    fail(`--kind must be one of ${AUDIO_KINDS.join('|')} (got: ${kind})`);
  }

  const ttlRaw = args.get('ttl');
  let ttl = 3600;
  if (ttlRaw !== undefined) {
    const n = Number(ttlRaw);
    if (!Number.isInteger(n) || n <= 0) fail(`--ttl must be a positive integer (got: ${ttlRaw})`);
    ttl = n;
  }

  const dataDir = args.get('data-dir') ?? process.env.PATCH_DATA_DIR;
  if (!dataDir) {
    fail('--data-dir <path> or PATCH_DATA_DIR env is required (NO FALLBACK)');
  }
  if (!existsSync(dataDir)) {
    // Match the docker-compose layout: /data is created by tmpfs; for
    // out-of-container tests the caller mkdtemps it. We refuse to create.
    fail(`data dir does not exist: ${dataDir} (NO FALLBACK — refusing to create)`);
  }
  if (!statSync(dataDir).isDirectory()) {
    fail(`data dir is not a directory: ${dataDir}`);
  }

  return {
    account: account!,
    surface: surface!,
    kind: kind as AudioKind,
    ttl,
    output: args.get('output') ?? null,
    dataDir: dataDir!,
  };
}

/**
 * Map the audio-plane surface kind (`web|desktop|mobile|device`) to the
 * EdDSA-JWT/registry surface kind (`web|desktop|mobile|voice-device`).
 * The audio WSS understands `device`; the auth registry/JWT use the older
 * `voice-device` label. Both refer to the same hardware surface.
 */
function toSurfaceKind(audio: AudioKind): SurfaceKind {
  return audio === 'device' ? 'voice-device' : audio;
}

const KEYPAIR_FILE = '.user-keypair.json';

interface StoredKeypair {
  accountLabel: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

function loadOrCreateKeypair(dataDir: string, accountLabel: string): UserKeypair {
  const path = join(dataDir, KEYPAIR_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as StoredKeypair;
    if (parsed.accountLabel !== accountLabel) {
      fail(
        `keypair at ${path} is bound to account="${parsed.accountLabel}", refusing to mint for account="${accountLabel}"`,
      );
    }
    // Re-derive to verify integrity — loadUserIdentity throws on bad seed.
    const reloaded = loadUserIdentity(parsed.privateKey);
    if (reloaded.publicKey !== parsed.publicKey) {
      fail(`keypair file ${path} corrupted (publicKey mismatch)`);
    }
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  }
  // First-time setup. Atomic write.
  const kp = generateUserKeypair();
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const stored: StoredKeypair = {
    accountLabel,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    createdAt: Date.now(),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
  // Atomic publish via rename — readers see the keypair only after the
  // rename completes, never a partial write.
  renameSync(tmp, path);
  return kp;
}

export interface MintFixtureResult {
  /** The minted EdDSA-JWT surface credential. */
  credential: string;
  /** Account public key (acts as accountId). */
  accountPublicKey: string;
  /** Echo of the surfaceId. */
  surfaceId: string;
  /** Echo of the resolved registry surface kind. */
  surfaceKind: SurfaceKind;
  /** Path to the persisted user-keypair file. */
  keypairFile: string;
}

/**
 * Programmatic entry point — exported so the integration test can call the
 * exact same code-path the CLI runs (no shelling out from inside vitest).
 */
export async function mintSurfaceFixture(args: {
  account: string;
  surface: string;
  kind: AudioKind;
  ttlSeconds?: number;
  dataDir: string;
}): Promise<MintFixtureResult> {
  if (!(AUDIO_KINDS as readonly string[]).includes(args.kind)) {
    throw new Error(`invalid kind: ${args.kind}`);
  }
  const surfaceKind = toSurfaceKind(args.kind);
  const keypair = loadOrCreateKeypair(args.dataDir, args.account);
  const registry = Registry.load(args.dataDir);
  // Dev/test fixture: seed the registry with this script's own keypair so it
  // can mint credentials. Idempotent across re-runs (bootstrap throws once set).
  if (registry.getAccount() === null) {
    registry.bootstrapAccount({ keypair });
  }
  const ttl = args.ttlSeconds ?? 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const credential = await mintSurfaceCredential({
    userPrivateKey: keypair.privateKey,
    surfaceId: args.surface,
    surfaceKind,
    label: `${args.kind}:${args.surface}`,
    expiresAt: nowSec + ttl,
    now: nowSec,
  });
  registry.upsertSurface({
    surfaceId: args.surface,
    surfaceKind,
    label: `${args.kind}:${args.surface}`,
    issuedAt: nowSec,
  });
  return {
    credential,
    accountPublicKey: keypair.publicKey,
    surfaceId: args.surface,
    surfaceKind,
    keypairFile: join(args.dataDir, KEYPAIR_FILE),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await mintSurfaceFixture({
    account: args.account,
    surface: args.surface,
    kind: args.kind,
    ttlSeconds: args.ttl,
    dataDir: args.dataDir,
  });
  const out = JSON.stringify(
    {
      credential: result.credential,
      accountPublicKey: result.accountPublicKey,
      surfaceId: result.surfaceId,
      surfaceKind: result.surfaceKind,
      audioKind: args.kind,
      ttlSeconds: args.ttl,
      keypairFile: result.keypairFile,
    },
    null,
    2,
  );
  if (args.output) {
    writeFileSync(args.output, out + '\n', 'utf8');
    process.stderr.write(`mint-surface-jwt: wrote credential to ${args.output}\n`);
  } else {
    process.stdout.write(out + '\n');
  }
}

// Entrypoint guard: only run main() when invoked as a script (tsx / node),
// not when imported by the integration test.
const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('mint-surface-jwt.ts') ||
    process.argv[1].endsWith('mint-surface-jwt.js'));
if (invokedAsScript) {
  main().catch((err: Error) => {
    fail(err.stack ?? err.message);
  });
}
