// Claude Code OAuth loader + self-refresh.
//
// Per spec/10-auth.md "Claude OAuth — non-negotiable": patch reads the OAuth
// token Claude Code persists after `claude login`. We NEVER fall back to an API
// key, NEVER stub the shape. Missing → typed error. Malformed → typed error.
//
// The ONE write patch performs is a token REFRESH: when the stored access token
// has expired, patch exchanges the stored refresh token for a fresh one and
// writes the rotated credential back to the SAME store Claude Code reads
// (file / Keychain) so the SDK and patch never diverge. This is the durable fix
// for the daemon-token-expiry defect (the host passes the resolved token to
// the SDK as CLAUDE_CODE_OAUTH_TOKEN, which suppresses the SDK's own refresh, so
// without this patch every real query 401'd ~1h after boot). See
// refreshClaudeOAuth / persistClaudeOAuth below.
//
// WHERE THE TOKEN ACTUALLY LIVES (verified against live Claude Code 2.1.x):
// Claude Code stores the OAuth credential under the key `claudeAiOauth` in a
// platform-native store, NOT in `~/.claude.json` (that file holds account
// metadata under `oauthAccount` — email, uuids, plan — but NOT the access
// token). The real locations, in the order patch resolves them:
//
//   1. `CLAUDE_CODE_OAUTH_TOKEN` env — explicit override (headless / CI / when
//      an operator runs `claude setup-token`). If set, it IS the access token.
//   2. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` — the file
//      Claude Code writes on Linux (the production host) and on any
//      machine where Keychain isn't available. Path overridable for tests via
//      the `path` option / `CLAUDE_CREDENTIALS_PATH` env.
//   3. macOS Keychain generic password, service `Claude Code-credentials` →
//      `claudeAiOauth.accessToken` — the default on a developer Mac.
//
// The optional account email (shown in Settings) comes from `~/.claude.json`
// `oauthAccount.emailAddress` when available; its absence is NOT an error.
//
// The earlier draft read `oauthAccount.accessToken` from `~/.claude.json`. That
// field does not exist in current Claude Code, so the real SDK path could never
// authenticate — this loader is the fix.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { ClaudeOAuthMissingError, ClaudeOAuthMalformedError } from './errors.js';
import { ORGANIZATION_HEADER } from './claude-usage.js';

/**
 * Which physical store the credential came from. Needed so a refresh writes the
 * rotated token BACK to the same place Claude Code reads it from — otherwise the
 * SDK and patch would diverge on the next boot.
 */
export type ClaudeOAuthSourceKind = 'env' | 'file' | 'keychain' | 'store';

export interface ClaudeOAuthCredentials {
  /** OAuth access token consumed by the Claude Code SDK. */
  accessToken: string;
  /**
   * OAuth refresh token, when the source carried one (file / Keychain). Absent
   * for the `CLAUDE_CODE_OAUTH_TOKEN` env override (a bare access token with no
   * surrounding blob). When present the host can self-refresh on expiry.
   */
  refreshToken?: string;
  /**
   * Absolute expiry in epoch-ms, when the source carried one. Absent for the
   * env override. The host treats `Date.now() >= expiresAt - skew` as stale.
   */
  expiresAt?: number;
  /** Optional account email shown in Settings. */
  email?: string;
  /** Where the credentials were loaded from (env / file path / 'keychain'). */
  sourcePath: string;
  /** Coarse source kind, used to route a write-back refresh. */
  sourceKind: ClaudeOAuthSourceKind;
  /**
   * For `sourceKind: 'file'`, the absolute path to write a refreshed credential
   * back to. Absent for env/keychain.
   */
  filePath?: string;
  /**
   * For `sourceKind: 'store'`, which stored account this resolved to — the
   * `accountId` the caller asked for, or the store's active account when it
   * asked for none (spec/10-auth.md § Backend credentials — multiple
   * accounts). Absent for every other source kind, all of which are still
   * single-slot. `persistClaudeOAuth` writes a refresh back to THIS account,
   * not necessarily the active one.
   */
  accountId?: string;
}

/**
 * The OAuth token-rotation endpoint + public client id Claude Code uses for the
 * `claude login` flow. The host hits this with the stored refresh token to
 * mint a fresh access token when the current one has expired (spec/10-auth.md —
 * the host "is good" once authenticated; a token that silently expires after
 * ~1h must self-heal, NOT 401 every query nor fall back to an API key).
 */
export const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh once the token is within this skew of expiry (epoch-ms). */
export const CLAUDE_OAUTH_REFRESH_SKEW_MS = 60_000;

export interface LoadClaudeOAuthOptions {
  /**
   * Override path for the credentials JSON file (tests / headless hosts). When
   * absent, env `CLAUDE_CREDENTIALS_PATH` then `~/.claude/.credentials.json`.
   * This is the file holding `{ claudeAiOauth: { accessToken, ... } }`, NOT the
   * `~/.claude.json` account-metadata file.
   */
  path?: string;
  /**
   * Override path for PATCH's OWN credential store (tests / non-default homes).
   * When absent, env `PATCH_CLAUDE_STORE_PATH` then `~/.patch/claude-oauth.json`.
   */
  storePath?: string;
  /** Override env (test hook). */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the macOS Keychain reader (test hook). Returns the raw secret
   * string for service `Claude Code-credentials`, or undefined if absent.
   * Defaults to a `security find-generic-password` call on darwin only.
   */
  readKeychain?: () => string | undefined;
  /** Override platform detection (test hook). Defaults to `os.platform()`. */
  platform?: NodeJS.Platform;
  /**
   * When true (or env `CLAUDE_OAUTH_NO_KEYCHAIN=1`), never consult the macOS
   * Keychain — treat `CLAUDE_CREDENTIALS_PATH` / the credentials file as the
   * sole store, like the Linux production host. Used by the dev stack so the
   * Settings "disconnect" credential-clear genuinely flips connected→false
   * without the host Keychain re-satisfying the lookup.
   */
  noKeychain?: boolean;
  /**
   * Which stored account to resolve (spec/10-auth.md § Backend credentials —
   * multiple accounts). Only meaningful once patch's own store exists — the
   * legacy seed chain (env/file/Keychain) is always single-slot. Omitted means
   * the store's active/default account, the pre-multi-account behaviour.
   */
  accountId?: string;
}

/** True iff the Keychain is opted out via option or `CLAUDE_OAUTH_NO_KEYCHAIN`. */
function keychainDisabled(opts: { noKeychain?: boolean; env?: NodeJS.ProcessEnv }): boolean {
  if (opts.noKeychain) return true;
  const env = opts.env ?? process.env;
  return env['CLAUDE_OAUTH_NO_KEYCHAIN'] === '1';
}

/**
 * Resolve the credentials-file path patch reads when no env token and no
 * Keychain secret are present. Kept exported (and named the same) for callers
 * that want to report the location in error/Settings copy.
 */
export function resolveClaudeConfigPath(opts: LoadClaudeOAuthOptions = {}): string {
  if (opts.path) return opts.path;
  const env = opts.env ?? process.env;
  const fromEnv = env['CLAUDE_CREDENTIALS_PATH'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.claude', '.credentials.json');
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Default macOS Keychain reader. Returns undefined when the item is absent. */
function readKeychainDefault(): string | undefined {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    // Item not in the Keychain (exit 44) or `security` unavailable. Not an
    // error here — the caller decides whether the overall lookup failed.
    return undefined;
  }
}

/**
 * Default macOS Keychain writer — replaces the generic-password secret in place
 * (the `-U` upsert flag). Used to persist a refreshed credential back to the
 * same store Claude Code reads, so the SDK and patch never diverge.
 */
function writeKeychainDefault(secret: string): void {
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_SERVICE, '-w', secret],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

interface ParsedOAuthBlob {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Parse a `{ claudeAiOauth: { accessToken, refreshToken?, expiresAt?, ... } }`
 * blob. Throws `ClaudeOAuthMalformedError` (tagged with `sourceLabel`) when the
 * structure is wrong. NO FALLBACKS — a shape change surfaces immediately.
 */
function extractOAuthBlob(raw: string, sourceLabel: string): ParsedOAuthBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ClaudeOAuthMalformedError(
      sourceLabel,
      `JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ClaudeOAuthMalformedError(sourceLabel, 'top-level value is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const oauth = obj['claudeAiOauth'];
  if (typeof oauth !== 'object' || oauth === null) {
    throw new ClaudeOAuthMalformedError(
      sourceLabel,
      'missing required field `claudeAiOauth` (object)',
    );
  }
  const o = oauth as Record<string, unknown>;
  const accessToken = o['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ClaudeOAuthMalformedError(
      sourceLabel,
      'missing required field `claudeAiOauth.accessToken` (non-empty string)',
    );
  }
  const out: ParsedOAuthBlob = { accessToken };
  if (typeof o['refreshToken'] === 'string' && o['refreshToken'].length > 0) {
    out.refreshToken = o['refreshToken'];
  }
  if (typeof o['expiresAt'] === 'number' && Number.isFinite(o['expiresAt'])) {
    out.expiresAt = o['expiresAt'];
  }
  return out;
}

/** Best-effort account email from `~/.claude.json` `oauthAccount.emailAddress`. */
function loadAccountEmail(env: NodeJS.ProcessEnv): string | undefined {
  const configPath = env['CLAUDE_CONFIG_PATH'] ?? join(homedir(), '.claude.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const account = (parsed as Record<string, unknown>)['oauthAccount'];
    if (typeof account !== 'object' || account === null) return undefined;
    const email = (account as Record<string, unknown>)['emailAddress'];
    return typeof email === 'string' && email.length > 0 ? email : undefined;
  } catch {
    // Account metadata is decorative; a malformed ~/.claude.json must not break
    // auth (the token comes from a different source). Swallow only HERE.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Patch's own credential store (spec/10-auth.md § Claude subscription).
//
// Patch used to read the credential straight from wherever Claude Code left it —
// env, file or Keychain. That made the credential UNOWNED: on a container
// deployment it arrived as `CLAUDE_CODE_OAUTH_TOKEN`, which is resolution step 1
// and cannot be changed by a running process, so Settings' "disconnect" deleted
// files that either didn't exist or didn't matter and the host reported itself
// connected a moment later. Revoking meant editing a deploy env file and
// recreating a container.
//
// So patch keeps its own store, which it can read AND write. Those other sources
// become a one-time SEED. Once the store exists it is the only thing consulted.

/** Absolute path of patch's credential store. */
export function resolvePatchStorePath(opts: LoadClaudeOAuthOptions = {}): string {
  if (opts.storePath) return opts.storePath;
  const env = opts.env ?? process.env;
  const fromEnv = env['PATCH_CLAUDE_STORE_PATH'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.patch', 'claude-oauth.json');
}

/** The credential blob patch persists. */
export interface PatchStoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  /**
   * The Anthropic organisation this token authenticates as, captured at
   * validation from the `anthropic-organization-id` response header.
   *
   * It is the only identity a `claude setup-token` credential will give up —
   * `/api/oauth/profile` answers 403 `oauth_scope_insufficient` — and without
   * it two tokens for the SAME account are indistinguishable, which is exactly
   * how this host came to hold "Default" and "work" as two rows sharing one
   * pool of credit and one 5-hour limit. Absent on a credential stored before
   * this field existed, or one whose lookup could not be completed; absent
   * means "not known", never "different".
   */
  organizationId?: string;
}

/**
 * One named Claude account in patch's store (spec/10-auth.md § Backend
 * credentials — multiple accounts). `credential: null` means this SLOT is
 * disconnected — the account is still listed (its label survives, and Connect
 * can restore it) but nothing resolves against it. This is the per-account
 * version of the old store-level "emptied, never deleted" rule.
 */
export interface ClaudeStoredAccount {
  id: string;
  label: string;
  credential: PatchStoredCredential | null;
}

/**
 * The id migrated legacy single-credential stores use for their one account,
 * and the id a brand-new store's first account gets. Stable so a host that
 * has never seen multi-account support still resolves the same account after
 * an upgrade.
 */
export const DEFAULT_ACCOUNT_ID = 'default';

export interface PatchStoreContents {
  accounts: ClaudeStoredAccount[];
  /** Which account a chat that names none resolves to. `null` when there is none yet. */
  activeAccountId: string | null;
  /** Where the FIRST account's seed came from, for diagnostics. Absent when set explicitly. */
  seededFrom?: string;
}

/** Parse+validate one stored credential object. Shared by the legacy and multi-account shapes. */
function parseStoredCredential(value: unknown, path: string): PatchStoredCredential {
  if (typeof value !== 'object' || value === null) {
    throw new ClaudeOAuthMalformedError(path, 'credential not an object');
  }
  const c = value as Record<string, unknown>;
  if (typeof c['accessToken'] !== 'string' || c['accessToken'].length === 0) {
    throw new ClaudeOAuthMalformedError(path, 'credential.accessToken missing');
  }
  return {
    accessToken: c['accessToken'],
    ...(typeof c['refreshToken'] === 'string' ? { refreshToken: c['refreshToken'] } : {}),
    ...(typeof c['expiresAt'] === 'number' ? { expiresAt: c['expiresAt'] } : {}),
    ...(typeof c['email'] === 'string' ? { email: c['email'] } : {}),
    ...(typeof c['organizationId'] === 'string' ? { organizationId: c['organizationId'] } : {}),
  };
}

/**
 * The stored account that already holds this organisation, if any.
 *
 * `exceptId` skips the slot a re-connect is targeting, so replacing an
 * account's own token with a fresh one for the same organisation is not
 * reported as a duplicate — that is the ordinary case of a rotated token, not
 * the mistake this guards against.
 *
 * An unknown organisation (undefined) matches nothing: we refuse to claim two
 * credentials are the same account on the strength of both being unidentified.
 */
export function findAccountByOrganization(
  accounts: readonly ClaudeStoredAccount[],
  organizationId: string | undefined,
  exceptId?: string,
): ClaudeStoredAccount | undefined {
  if (organizationId === undefined) return undefined;
  return accounts.find((a) => a.id !== exceptId && a.credential?.organizationId === organizationId);
}

/**
 * Read the store. Returns `null` when the store does not exist — which is
 * different from a store holding zero connected accounts (disconnected). The
 * caller MUST keep those apart: absent means "seed me", empty means "the user
 * said no".
 *
 * Transparently migrates an on-disk store still in the pre-multi-account
 * shape (`{ credential, seededFrom }`) into a one-account list — no manual
 * migration step, and a host upgrading in place never loses its existing
 * connection. The migrated account gets the stable id `DEFAULT_ACCOUNT_ID`.
 */
export function readPatchStore(opts: LoadClaudeOAuthOptions = {}): PatchStoreContents | null {
  const path = resolvePatchStorePath(opts);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ClaudeOAuthMalformedError(path, `read failed: ${(err as Error).message}`);
  }
  if (raw.trim().length === 0) return { accounts: [], activeAccountId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeOAuthMalformedError(path, 'not valid JSON');
  }
  // Array.isArray matters: an array is `typeof 'object'`, so without it a corrupt
  // store would read as an empty store — indistinguishable from a deliberate
  // disconnect. The host reports a throw here as unauthenticated with the
  // reason attached, so this is loud AND recoverable via Settings → Connect.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClaudeOAuthMalformedError(path, 'not an object');
  }
  const obj = parsed as Record<string, unknown>;

  // New (multi-account) shape.
  if ('accounts' in obj) {
    const rawAccounts = obj['accounts'];
    if (!Array.isArray(rawAccounts)) {
      throw new ClaudeOAuthMalformedError(path, 'accounts is not an array');
    }
    const accounts: ClaudeStoredAccount[] = rawAccounts.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new ClaudeOAuthMalformedError(path, `accounts[${i}] is not an object`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e['id'] !== 'string' || e['id'].length === 0) {
        throw new ClaudeOAuthMalformedError(path, `accounts[${i}].id missing`);
      }
      if (typeof e['label'] !== 'string' || e['label'].length === 0) {
        throw new ClaudeOAuthMalformedError(path, `accounts[${i}].label missing`);
      }
      return {
        id: e['id'],
        label: e['label'],
        credential:
          e['credential'] === null || e['credential'] === undefined
            ? null
            : parseStoredCredential(e['credential'], path),
      };
    });
    const activeAccountId =
      typeof obj['activeAccountId'] === 'string' ? obj['activeAccountId'] : null;
    return {
      accounts,
      activeAccountId,
      ...(typeof obj['seededFrom'] === 'string' ? { seededFrom: obj['seededFrom'] } : {}),
    };
  }

  // Legacy (single-credential) shape — migrate on read.
  const cred = obj['credential'];
  if (cred === null || cred === undefined) return { accounts: [], activeAccountId: null };
  const credential = parseStoredCredential(cred, path);
  return {
    accounts: [{ id: DEFAULT_ACCOUNT_ID, label: 'Default', credential }],
    activeAccountId: DEFAULT_ACCOUNT_ID,
    ...(typeof obj['seededFrom'] === 'string' ? { seededFrom: obj['seededFrom'] } : {}),
  };
}

/**
 * Write the store atomically at mode 0600 — same permissions as the host key
 * that lives beside it. Creates the directory if needed.
 */
export function writePatchStore(
  contents: PatchStoreContents,
  opts: LoadClaudeOAuthOptions = {},
): void {
  const path = resolvePatchStorePath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(contents, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Record an explicit disconnect of ONE account — the named `accountId`, or the
 * active account when omitted (the original single-slot behaviour). The
 * account's credential is EMPTIED, never removed from the list, and the store
 * itself is never deleted: the same "disconnect empties, doesn't delete" rule
 * the store always had, now scoped to the account. A store with no accounts
 * yet (or naming an id it doesn't have) still ends up persisted as an empty
 * store, so a disconnect always leaves a real "no" on disk.
 */
export function disconnectPatchStore(opts: LoadClaudeOAuthOptions = {}, accountId?: string): void {
  const existing = readPatchStore(opts) ?? { accounts: [], activeAccountId: null };
  const targetId = accountId ?? existing.activeAccountId;
  const accounts =
    targetId === null
      ? existing.accounts
      : existing.accounts.map((a) => (a.id === targetId ? { ...a, credential: null } : a));
  writePatchStore(
    {
      accounts,
      activeAccountId: existing.activeAccountId,
      ...(existing.seededFrom ? { seededFrom: existing.seededFrom } : {}),
    },
    opts,
  );
}

/**
 * Set one account's credential explicitly (Settings → Connect). Targets the
 * named `accountId`, else the active account, else — on a store with no
 * accounts at all yet — creates the first one and makes it active. This is
 * the REPLACE operation (same slot, new token); `addPatchStoreAccount` below
 * is the ADD operation (always a new slot).
 */
export function connectPatchStore(
  credential: PatchStoredCredential,
  opts: LoadClaudeOAuthOptions = {},
  accountId?: string,
): void {
  const existing = readPatchStore(opts) ?? { accounts: [], activeAccountId: null };
  const targetId = accountId ?? existing.activeAccountId ?? DEFAULT_ACCOUNT_ID;
  const idx = existing.accounts.findIndex((a) => a.id === targetId);
  const accounts =
    idx >= 0
      ? existing.accounts.map((a, i) => (i === idx ? { ...a, credential } : a))
      : [...existing.accounts, { id: targetId, label: 'Default', credential }];
  writePatchStore(
    {
      accounts,
      activeAccountId: existing.activeAccountId ?? targetId,
      ...(existing.seededFrom ? { seededFrom: existing.seededFrom } : {}),
    },
    opts,
  );
}

/** Best-effort label for a newly-added account when the caller supplied none. */
function deriveAccountLabel(credential: PatchStoredCredential, existingCount: number): string {
  if (credential.email) return credential.email;
  return `Account ${existingCount + 1}`;
}

/**
 * Add a NEW named account (Settings → "add another account"). Always creates a
 * fresh slot — never replaces an existing one, unlike `connectPatchStore`.
 * Does not touch `activeAccountId` unless the store had none yet (an added
 * account never displaces the implicit default; per spec/10-auth.md there is
 * no "set active" control).
 */
export function addPatchStoreAccount(
  credential: PatchStoredCredential,
  opts: LoadClaudeOAuthOptions = {},
  label?: string,
): ClaudeStoredAccount {
  const existing = readPatchStore(opts) ?? { accounts: [], activeAccountId: null };
  const account: ClaudeStoredAccount = {
    id: randomUUID(),
    label: label ?? deriveAccountLabel(credential, existing.accounts.length),
    credential,
  };
  writePatchStore(
    {
      accounts: [...existing.accounts, account],
      activeAccountId: existing.activeAccountId ?? account.id,
      ...(existing.seededFrom ? { seededFrom: existing.seededFrom } : {}),
    },
    opts,
  );
  return account;
}

/**
 * Record which organisation a stored account's token belongs to.
 *
 * A backfill, mostly. Identity is captured when a token is pasted, but every
 * credential stored before that existed has none — including, on the host where
 * this was found, the two that were the same account. Without backfilling them
 * the duplicate guard and the shared-pool failover would both stay blind on
 * exactly the machine that needed them, until someone re-pasted both tokens by
 * hand.
 *
 * A no-op when the account is gone, has no credential, or already records this
 * organisation — so it can be called after every usage probe without churning
 * the file.
 */
export function setAccountOrganization(
  accountId: string,
  organizationId: string,
  opts: LoadClaudeOAuthOptions = {},
): boolean {
  const store = readPatchStore(opts);
  if (!store) return false;
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account?.credential) return false;
  if (account.credential.organizationId === organizationId) return false;
  writePatchStore(
    {
      accounts: store.accounts.map((a) =>
        a.id === accountId && a.credential !== null
          ? { ...a, credential: { ...a.credential, organizationId } }
          : a,
      ),
      activeAccountId: store.activeAccountId,
      ...(store.seededFrom ? { seededFrom: store.seededFrom } : {}),
    },
    opts,
  );
  return true;
}

/** Every stored account on this host/backend, for Settings and the per-chat account picker. */
export function listPatchStoreAccounts(opts: LoadClaudeOAuthOptions = {}): ClaudeStoredAccount[] {
  return readPatchStore(opts)?.accounts ?? [];
}

/**
 * One-time seed. When the store does not yet exist, resolve the credential from
 * the legacy sources (env → file → Keychain) and write it in as the store's
 * FIRST account (`DEFAULT_ACCOUNT_ID`), made active. Returns what was seeded,
 * or null when there was nothing to seed (leaving the store absent, so a later
 * `claude login` can still be picked up).
 *
 * Never overwrites an existing store — including an emptied one.
 */
export function seedPatchStore(opts: LoadClaudeOAuthOptions = {}): PatchStoredCredential | null {
  if (readPatchStore(opts) !== null) return null;
  let legacy: ClaudeOAuthCredentials;
  try {
    legacy = loadLegacyClaudeOAuth(opts);
  } catch {
    return null; // nothing to seed
  }
  const credential: PatchStoredCredential = {
    accessToken: legacy.accessToken,
    ...(legacy.refreshToken ? { refreshToken: legacy.refreshToken } : {}),
    ...(legacy.expiresAt !== undefined ? { expiresAt: legacy.expiresAt } : {}),
    ...(legacy.email ? { email: legacy.email } : {}),
  };
  writePatchStore(
    {
      accounts: [{ id: DEFAULT_ACCOUNT_ID, label: 'Default', credential }],
      activeAccountId: DEFAULT_ACCOUNT_ID,
      seededFrom: legacy.sourcePath,
    },
    opts,
  );
  return credential;
}

/**
 * Read & parse the Claude Code OAuth credential. Resolution order:
 *   1. `CLAUDE_CODE_OAUTH_TOKEN` env (explicit override).
 *   2. credentials JSON file (`~/.claude/.credentials.json` / override).
 *   3. macOS Keychain (`Claude Code-credentials`).
 *
 * Throws `ClaudeOAuthMissingError` when no source yields a token, and
 * `ClaudeOAuthMalformedError` when a present source has the wrong structure.
 */
export function loadClaudeOAuth(opts: LoadClaudeOAuthOptions = {}): ClaudeOAuthCredentials {
  // Patch's own store wins outright once it exists — including when it is empty,
  // which is what makes "disconnect" stick instead of being undone by an env var.
  const store = readPatchStore(opts);
  if (store !== null) {
    const path = resolvePatchStorePath(opts);
    const targetId = opts.accountId ?? store.activeAccountId;
    const account = targetId === null ? undefined : store.accounts.find((a) => a.id === targetId);
    if (!account || account.credential === null) throw new ClaudeOAuthMissingError(path);
    const c = account.credential;
    return {
      accessToken: c.accessToken,
      ...(c.refreshToken ? { refreshToken: c.refreshToken } : {}),
      ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
      // ONLY the stored credential's own email. There used to be a fallback to
      // `~/.claude.json`'s `oauthAccount.emailAddress` here, and it made the
      // reported account name a lie: a token pasted into Settings carries no
      // email (see `validateClaudeOAuthToken` — Anthropic will not tell us whose
      // it is), so every pasted credential displayed the machine's ambient
      // Claude Code login instead — usually the account being switched AWAY
      // from. A seeded store keeps its email because `seedPatchStore` copies the
      // legacy one in, where the credential really IS that login.
      ...(c.email ? { email: c.email } : {}),
      sourcePath: path,
      sourceKind: 'store',
      filePath: path,
      accountId: account.id,
    };
  }
  return loadLegacyClaudeOAuth(opts);
}

/**
 * The pre-store resolution order (env → credentials file → Keychain), kept as the
 * SEED source for a first boot. Not consulted once patch's own store exists.
 */
export function loadLegacyClaudeOAuth(opts: LoadClaudeOAuthOptions = {}): ClaudeOAuthCredentials {
  const env = opts.env ?? process.env;
  const plat = opts.platform ?? platform();
  const email = loadAccountEmail(env);

  // 1. Explicit env override. A bare access token with no surrounding blob, so
  // no refreshToken/expiresAt — the host cannot self-refresh this one (the
  // operator set it deliberately, e.g. `claude setup-token`).
  const envToken = env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken && envToken.length > 0) {
    return {
      accessToken: envToken,
      ...(email ? { email } : {}),
      sourcePath: 'CLAUDE_CODE_OAUTH_TOKEN',
      sourceKind: 'env',
    };
  }

  // 2. Credentials file.
  const filePath = resolveClaudeConfigPath(opts);
  if (existsSync(filePath)) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new ClaudeOAuthMalformedError(filePath, `read failed: ${(err as Error).message}`);
    }
    // An empty/whitespace credentials file means "not logged in here" — treat
    // it as absent so we fall through to the Keychain (the common macOS case
    // where Claude Code leaves a 0-byte ~/.claude/.credentials.json).
    if (raw.trim().length > 0) {
      const blob = extractOAuthBlob(raw, filePath);
      return {
        accessToken: blob.accessToken,
        ...(blob.refreshToken ? { refreshToken: blob.refreshToken } : {}),
        ...(blob.expiresAt !== undefined ? { expiresAt: blob.expiresAt } : {}),
        ...(email ? { email } : {}),
        sourcePath: filePath,
        sourceKind: 'file',
        filePath,
      };
    }
  }

  // 3. macOS Keychain — UNLESS the operator has opted out (CLAUDE_OAUTH_NO_KEYCHAIN
  // / `noKeychain`). The opt-out makes a `CLAUDE_CREDENTIALS_PATH` file the sole
  // credential store, mirroring the Linux production host (which has no
  // Keychain). This is what lets a developer Mac exercise the Settings
  // "disconnect" credential-clear against a sandbox file WITHOUT the host
  // Keychain silently re-satisfying the lookup. NO behaviour change unless set.
  if (plat === 'darwin' && !keychainDisabled(opts)) {
    const readKeychain = opts.readKeychain ?? readKeychainDefault;
    const secret = readKeychain();
    if (secret && secret.length > 0) {
      const blob = extractOAuthBlob(secret, 'macOS Keychain (Claude Code-credentials)');
      return {
        accessToken: blob.accessToken,
        ...(blob.refreshToken ? { refreshToken: blob.refreshToken } : {}),
        ...(blob.expiresAt !== undefined ? { expiresAt: blob.expiresAt } : {}),
        ...(email ? { email } : {}),
        sourcePath: 'macOS Keychain (Claude Code-credentials)',
        sourceKind: 'keychain',
      };
    }
  }

  // Nothing yielded a token.
  throw new ClaudeOAuthMissingError(filePath);
}

export interface ClearClaudeOAuthOptions extends LoadClaudeOAuthOptions {
  /**
   * Override the macOS Keychain deleter (test hook). Returns true iff a stored
   * item was removed. Defaults to `security delete-generic-password` on darwin.
   */
  deleteKeychain?: () => boolean;
}

/** Result of clearing the Claude OAuth credential from every resolvable store. */
export interface ClearClaudeOAuthResult {
  /** The credentials file was present and removed. */
  fileRemoved: boolean;
  /** The macOS Keychain item was present and removed. */
  keychainRemoved: boolean;
}

/** Default macOS Keychain deleter. Returns true iff an item was removed. */
function deleteKeychainDefault(): boolean {
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    // Item not in the Keychain (exit 44) or `security` unavailable — nothing to
    // remove. The caller reports the overall post-clear state by re-loading.
    return false;
  }
}

/**
 * spec/10-auth.md Settings "disconnect": CLEAR the Claude Code OAuth credential
 * so the host goes genuinely unauthenticated and requires re-auth.
 *
 * The credential lives in the platform store — `~/.claude/.credentials.json`
 * (overridable via `CLAUDE_CREDENTIALS_PATH` / `path`) and, on a developer Mac,
 * the Keychain (service `Claude Code-credentials`). This removes BOTH so the
 * resolution order (env → file → Keychain) no longer yields a token. The env
 * override `CLAUDE_CODE_OAUTH_TOKEN` is process-level and deliberately NOT
 * touched (the operator set it; clearing a process env var wouldn't persist).
 *
 * NO FALLBACK: each store delete is best-effort and the result reports what was
 * actually removed; the caller re-reads `loadClaudeOAuth` to surface the real
 * post-disconnect `connected` state rather than assuming success.
 */
export function clearClaudeOAuth(opts: ClearClaudeOAuthOptions = {}): ClearClaudeOAuthResult {
  const plat = opts.platform ?? platform();
  let fileRemoved = false;
  const filePath = resolveClaudeConfigPath(opts);
  if (existsSync(filePath)) {
    rmSync(filePath);
    fileRemoved = true;
  }
  let keychainRemoved = false;
  // Touch the Keychain ONLY when it's the real credential store: darwin, NOT
  // opted out (CLAUDE_OAUTH_NO_KEYCHAIN / noKeychain), and no explicit
  // credentials-file override (an override / opt-out means we're pointed at a
  // sandbox file, not the host Keychain). Per spec/10 disconnect must clear the
  // credential everywhere it resolves — on a real Mac that includes deleting the
  // Keychain item; in the dev/sandbox configuration the file IS the store.
  const hasFileOverride =
    opts.path !== undefined || !!(opts.env ?? process.env)['CLAUDE_CREDENTIALS_PATH'];
  const disabled = keychainDisabled(opts);
  if (!hasFileOverride && !disabled && plat === 'darwin') {
    const del = opts.deleteKeychain ?? deleteKeychainDefault;
    keychainRemoved = del();
  } else if (opts.deleteKeychain) {
    // Test hook: allow exercising the Keychain branch explicitly.
    keychainRemoved = opts.deleteKeychain();
  }
  return { fileRemoved, keychainRemoved };
}

// ---------------------------------------------------------------------------
// Token refresh (spec/10-auth.md — the host self-heals an expired token).
//
// KNOWN HOST DEFECT this fixes: the host resolved the OAuth access token
// and passed it to the SDK as CLAUDE_CODE_OAUTH_TOKEN; an explicit env token
// SUPPRESSES the SDK's own Keychain refresh, so once the access token expired
// (~1h) every real query 401'd with "Invalid authentication credentials". The
// durable fix is for the host to refresh the token itself using the stored
// refreshToken when the credential is stale (or on a 401 retry), and write the
// rotated credential back to the SAME store Claude Code reads.

export interface RefreshClaudeOAuthOptions {
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Token endpoint override (tests). */
  tokenUrl?: string;
  /** OAuth client id override (tests). */
  clientId?: string;
}

/**
 * Exchange a refresh token for a fresh access token via the Claude OAuth token
 * endpoint. Returns the rotated `{ accessToken, refreshToken, expiresAt }`. NO
 * FALLBACK — a non-2xx or malformed response throws (the caller surfaces
 * `daemon.unauthenticated`, never an API-key fallback).
 */
export async function refreshClaudeOAuth(
  refreshToken: string,
  opts: RefreshClaudeOAuthOptions = {},
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tokenUrl = opts.tokenUrl ?? CLAUDE_OAUTH_TOKEN_URL;
  const clientId = opts.clientId ?? CLAUDE_OAUTH_CLIENT_ID;
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude OAuth refresh failed: HTTP ${res.status} ${text}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Claude OAuth refresh: response missing access_token');
  }
  // The endpoint rotates the refresh token; if it omits one, the old token
  // stays valid (some IdPs keep refresh tokens stable).
  const newRefresh =
    typeof body['refresh_token'] === 'string' && (body['refresh_token'] as string).length > 0
      ? (body['refresh_token'] as string)
      : refreshToken;
  const expiresInSec =
    typeof body['expires_in'] === 'number' ? (body['expires_in'] as number) : 3600;
  return {
    accessToken,
    refreshToken: newRefresh,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

// ---------------------------------------------------------------------------
// Token validation at entry (spec/10-auth.md § Validating a pasted token).
//
// A pasted token used to be stored unread, so a typo'd or revoked one was only
// discovered later, by a chat that failed. The check below is the cheapest call
// that exercises exactly what the host does with the credential: an
// OAuth-authenticated GET against the Anthropic REST API. Listing models costs
// no inference and needs no model id.
//
// Anthropic will NOT say whose token it is — `GET /api/oauth/profile` answers
// 403 `permission_error` ("OAuth token does not meet scope requirement
// any_of(user:profile, user:office)") for a `claude setup-token` token — so
// validation is the only thing this can establish. The account email of a pasted
// token is unknowable, which is why nothing here invents one.

/** Anthropic REST API version header, required on every call. */
export const ANTHROPIC_API_VERSION = '2023-06-01';
/** Beta header that lets an OAuth bearer token (not an API key) authenticate. */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
/** The cheapest authenticated endpoint: auth-only, no inference, no model id. */
export const ANTHROPIC_VALIDATE_URL = 'https://api.anthropic.com/v1/models?limit=1';

export interface ValidateClaudeOAuthOptions {
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint override (tests). */
  url?: string;
}

/**
 * The three things that can be true of a submitted token.
 *
 * `rejected` is Anthropic answering that the token is bad. `unreachable` is us
 * failing to get an answer at all, which is NOT the same claim and must never be
 * reported as one — and must never be treated as a pass either. Only `valid` may
 * lead to a store write.
 */
export type ClaudeTokenValidation =
  | {
      kind: 'valid';
      /**
       * Which Anthropic organisation the token authenticates as, read off the
       * validating response's `anthropic-organization-id` header. The check was
       * already making this call; the header was simply being dropped. Absent
       * when Anthropic did not stamp one.
       */
      organizationId?: string;
    }
  | { kind: 'rejected'; message: string }
  | { kind: 'unreachable'; message: string };

/**
 * Ask Anthropic whether an OAuth access token authenticates, using the same
 * headers the host's model-catalogue read uses.
 *
 * NO FALLBACK: an inconclusive result stays inconclusive. 200 is valid; 401/403
 * is the token being refused; every other status, an unparseable body, or a
 * thrown network error is `unreachable`, because none of those is Anthropic
 * saying "no".
 */
export async function validateClaudeOAuthToken(
  accessToken: string,
  opts: ValidateClaudeOAuthOptions = {},
): Promise<ClaudeTokenValidation> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? ANTHROPIC_VALIDATE_URL;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'anthropic-beta': ANTHROPIC_OAUTH_BETA,
      },
    });
  } catch (err) {
    return {
      kind: 'unreachable',
      message: `Could not reach Anthropic to check the token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.ok) {
    const organizationId = res.headers?.get(ORGANIZATION_HEADER) ?? undefined;
    return { kind: 'valid', ...(organizationId ? { organizationId } : {}) };
  }
  const detail = await res.text().then(
    (t) => t.slice(0, 200),
    () => '',
  );
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'rejected',
      message: `Anthropic rejected this token (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    };
  }
  return {
    kind: 'unreachable',
    message: `Anthropic could not check the token (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
  };
}

export interface PersistClaudeOAuthOptions {
  /** Keychain writer override (tests). Defaults to the `security` upsert. */
  writeKeychain?: (secret: string) => void;
  /** Keychain reader override (tests) — used to merge non-OAuth fields. */
  readKeychain?: () => string | undefined;
}

/**
 * Write a refreshed credential back to the SAME store it was loaded from, so
 * Claude Code and patch read identical tokens. Merges the rotated
 * accessToken/refreshToken/expiresAt into the existing `claudeAiOauth` blob,
 * preserving every other field (scopes, subscriptionType, …). The `env` source
 * is not persistable (no blob to write) — that returns without error so the
 * caller can still use the freshly-refreshed in-memory token for this run.
 */
export function persistClaudeOAuth(
  cred: ClaudeOAuthCredentials,
  refreshed: { accessToken: string; refreshToken: string; expiresAt: number },
  opts: PersistClaudeOAuthOptions = {},
): void {
  if (cred.sourceKind === 'env') return;

  const mergeInto = (rawExisting: string | undefined): string => {
    let existing: Record<string, unknown> = {};
    if (rawExisting && rawExisting.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawExisting);
        if (typeof parsed === 'object' && parsed !== null)
          existing = parsed as Record<string, unknown>;
      } catch {
        // Corrupt prior blob — overwrite with a clean one rather than fail; the
        // refreshed credential is authoritative.
        existing = {};
      }
    }
    const priorOauth =
      typeof existing['claudeAiOauth'] === 'object' && existing['claudeAiOauth'] !== null
        ? (existing['claudeAiOauth'] as Record<string, unknown>)
        : {};
    existing['claudeAiOauth'] = {
      ...priorOauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    return JSON.stringify(existing);
  };

  // A store-sourced credential writes back to the STORE — to the ONE account it
  // resolved from (`cred.accountId`), not necessarily the active one. Without
  // this branch it fell through to the Keychain case below and a routine token
  // refresh would have overwritten the developer's actual Claude Code login.
  if (cred.sourceKind === 'store') {
    if (!cred.accountId) throw new Error('persistClaudeOAuth: store source has no accountId');
    const existing = readPatchStore({ storePath: cred.sourcePath }) ?? {
      accounts: [],
      activeAccountId: null,
    };
    const prior = existing.accounts.find((a) => a.id === cred.accountId);
    const nextCredential: PatchStoredCredential = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(prior?.credential?.email ? { email: prior.credential.email } : {}),
    };
    const accounts = existing.accounts.map((a) =>
      a.id === cred.accountId ? { ...a, credential: nextCredential } : a,
    );
    writePatchStore(
      {
        accounts,
        activeAccountId: existing.activeAccountId,
        ...(existing.seededFrom ? { seededFrom: existing.seededFrom } : {}),
      },
      { storePath: cred.sourcePath },
    );
    return;
  }

  if (cred.sourceKind === 'file') {
    if (!cred.filePath) throw new Error('persistClaudeOAuth: file source has no filePath');
    let rawExisting: string | undefined;
    if (existsSync(cred.filePath)) rawExisting = readFileSync(cred.filePath, 'utf8');
    const next = mergeInto(rawExisting);
    const tmp = `${cred.filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, cred.filePath);
    return;
  }

  // keychain
  const read = opts.readKeychain ?? readKeychainDefault;
  const write = opts.writeKeychain ?? writeKeychainDefault;
  write(mergeInto(read()));
}

/**
 * True when the credential has an expiry that is at/within the refresh skew of
 * now. Credentials with no `expiresAt` (env override) are treated as fresh.
 */
export function isClaudeOAuthStale(
  cred: Pick<ClaudeOAuthCredentials, 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  if (cred.expiresAt === undefined) return false;
  return now >= cred.expiresAt - CLAUDE_OAUTH_REFRESH_SKEW_MS;
}

/**
 * Convenience wrapper: returns the access token only. Throws same errors
 * as `loadClaudeOAuth` if absent/malformed.
 */
export function getClaudeOAuthToken(opts: LoadClaudeOAuthOptions = {}): string {
  return loadClaudeOAuth(opts).accessToken;
}
