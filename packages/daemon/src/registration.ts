// Host registration (~/.patch/daemon.key) + Claude OAuth bootstrap.
//
// Spec: spec/10-auth.md "Host registration", spec/02-daemon.md.
//
// On first start the host has no key on disk. It emits
// `daemon.unauthenticated` upstream and waits for a signed credential to
// come back via the surface QR flow. Once received, the credential is
// written atomically to ~/.patch/daemon.key with mode 0600.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import { loadOrCreateDaemonIdentity } from './identity.js';
import { accountOrderMismatch } from './accountFailover.js';
import {
  loadClaudeOAuth,
  loadLegacyClaudeOAuth,
  connectPatchStore,
  disconnectPatchStore,
  addPatchStoreAccount,
  readPatchStore,
  writePatchStore,
  findAccountByOrganization,
  DEFAULT_ACCOUNT_ID,
  refreshClaudeOAuth,
  validateClaudeOAuthToken,
  persistClaudeOAuth,
  isClaudeOAuthStale,
  type ClaudeOAuthCredentials,
  type ClaudeStoredAccount,
  type ClaudeTokenValidation,
  type LoadClaudeOAuthOptions,
  ClaudeOAuthMissingError,
  ClaudeOAuthMalformedError,
} from '@patch/auth';

export interface RegistrationPaths {
  /** ~/.patch */
  patchHome: string;
}

export function daemonKeyPath(patchHome: string): string {
  return join(patchHome, 'daemon.key');
}

export function readDaemonKey(patchHome: string): string | undefined {
  try {
    const raw = readFileSync(daemonKeyPath(patchHome), 'utf8');
    return raw.trim().length > 0 ? raw.trim() : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Atomic write to daemon.key with mode 0600. NO FALLBACK: if the FS rejects
 * the rename or the chmod, surface the error.
 */
export function writeDaemonKey(patchHome: string, credential: string): void {
  const path = daemonKeyPath(patchHome);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, credential, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Try to load Claude OAuth at startup. PURE READ — no writes.
 *
 * Seeding patch's store is deliberately NOT done here. It was, briefly, and a
 * loader that writes to `~/.patch` as a side effect meant the host's own unit
 * tests seeded the developer's real home directory and then read it back on the
 * next case. Seeding is a boot step, in index.ts, where it happens once and with
 * explicit paths.
 *
 * On miss/malformed, log a clear
 * actionable message and return undefined — the host can still serve
 * /healthz and the WS link, but every `query()` will throw until OAuth
 * is set. Per spec/10-auth.md "Host refuses to start any query()" —
 * the refusal happens at runQuery time, not startup.
 */
export interface OAuthBootstrapResult {
  credentials?: ClaudeOAuthCredentials;
  error?: { kind: 'missing' | 'malformed'; message: string };
}

export function bootstrapClaudeOAuth(opts: LoadClaudeOAuthOptions = {}): OAuthBootstrapResult {
  try {
    const creds = loadClaudeOAuth(opts);
    return { credentials: creds };
  } catch (err) {
    if (err instanceof ClaudeOAuthMissingError) {
      return {
        error: {
          kind: 'missing',
          message:
            `Claude OAuth credential not found (checked CLAUDE_CODE_OAUTH_TOKEN, ${err.path}, and the macOS Keychain). ` +
            `Run \`claude login\` on the host so Claude Code writes claudeAiOauth.accessToken.`,
        },
      };
    }
    if (err instanceof ClaudeOAuthMalformedError) {
      return {
        error: {
          kind: 'malformed',
          message:
            `Claude OAuth file at ${err.path} is malformed: ${err.reason}. ` +
            `Re-run \`claude login\` to refresh the credential.`,
        },
      };
    }
    throw err;
  }
}

/**
 * Build the per-query OAuth gate the host runs before every SDK `query()`.
 *
 * The gate exists ONLY to protect the REAL Claude Agent SDK path: an
 * expired/missing OAuth token there means the SDK call would fail, so the
 * host refuses the turn and emits `daemon.unauthenticated` (NO API-key
 * fallback). The MOCK backend never contacts Claude — it returns a
 * deterministic echo — so a real-credential precondition is meaningless for
 * it. Gating mock turns on ~/.claude.json would make local-dev and the test
 * stack (`SDK_BACKEND=mock`) unable to exercise ANY agent behaviour without a
 * real `claude login` on the host. When the backend is mock the gate is a
 * no-op carrying a synthetic token the mock ignores.
 */
export function makeResolveOAuth(opts: {
  sdkBackend: 'mock' | 'real';
  claudeCredentialsPath?: string;
  /** Loader overrides (env / platform / Keychain reader) — test hook only. */
  loadOptions?: LoadClaudeOAuthOptions;
  /** Refresh-endpoint overrides (tests). */
  refreshOptions?: Parameters<typeof refreshClaudeOAuth>[1];
  /** Persist-back overrides (tests). */
  persistOptions?: Parameters<typeof persistClaudeOAuth>[2];
  /** Clock injection (tests). */
  now?: () => number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}): (
  accountId?: string,
) => Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }> {
  return async (accountId?: string) => {
    if (opts.sdkBackend === 'mock') {
      return { ok: true, accessToken: 'mock-oauth-token' };
    }
    const loadOpts: LoadClaudeOAuthOptions = {
      ...opts.loadOptions,
      ...(opts.claudeCredentialsPath !== undefined ? { path: opts.claudeCredentialsPath } : {}),
      // Resolve the chat's pinned account when given one; the store's
      // active/default account otherwise (spec/10-auth.md § Backend
      // credentials — multiple accounts).
      ...(accountId !== undefined ? { accountId } : {}),
    };
    const fresh = bootstrapClaudeOAuth(loadOpts);
    if (fresh.error) return { ok: false, reason: fresh.error.message };
    const cred = fresh.credentials!;
    // KNOWN HOST DEFECT FIX (spec/10-auth.md): the host passes the resolved
    // access token to the SDK as CLAUDE_CODE_OAUTH_TOKEN, which suppresses the
    // SDK's own Keychain refresh — so a token that expired (~1h) would 401 every
    // query. Here, BEFORE handing the token to the SDK, we self-refresh when the
    // credential is at/near expiry and we hold a refresh token, then write the
    // rotated credential back to the SAME store Claude Code reads. NO API-key
    // fallback; a refresh failure surfaces as `daemon.unauthenticated`.
    const now = opts.now?.() ?? Date.now();
    if (cred.refreshToken && isClaudeOAuthStale(cred, now)) {
      try {
        const rotated = await refreshClaudeOAuth(cred.refreshToken, opts.refreshOptions ?? {});
        persistClaudeOAuth(cred, rotated, opts.persistOptions ?? {});
        opts.logger?.info(
          { source: cred.sourcePath, expiresAt: rotated.expiresAt },
          'Claude OAuth token refreshed (was expiring) and persisted',
        );
        return { ok: true, accessToken: rotated.accessToken };
      } catch (err) {
        opts.logger?.error(
          { err: (err as Error).message },
          'Claude OAuth refresh failed; query will be refused (NO API-key fallback)',
        );
        return {
          ok: false,
          reason: `Claude OAuth token expired and refresh failed: ${(err as Error).message}. Re-run \`claude login\` on the host.`,
        };
      }
    }
    return { ok: true, accessToken: cred.accessToken };
  };
}

/**
 * Resolve the Claude Code account-metadata file (`~/.claude.json`), honouring
 * the `CLAUDE_CONFIG_PATH` override.
 */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_PATH'] ?? join(homedir(), '.claude.json');
}

export interface DisconnectClaudeResult {
  /** True iff a credential still resolves after the disconnect. */
  connected: boolean;
  /** Best-effort account email after the disconnect (null when gone). */
  email: string | null;
  /** Whether patch's credential store was emptied. */
  storeEmptied: boolean;
  /**
   * Which stored account this acted on — the caller's explicit `accountId`,
   * else the store's active account at the time, else null when the store
   * has neither (spec/10-auth.md § Backend credentials — multiple accounts).
   */
  accountId: string | null;
}

/**
 * spec/10-auth.md Settings "disconnect": empty PATCH's credential store so the
 * host goes genuinely unauthenticated.
 *
 * This used to delete Claude Code's own credential — the credentials file, the
 * macOS Keychain item, and `~/.claude.json`. Two things were wrong with that.
 * First it didn't work where it mattered: a container deployment supplies the
 * token as `CLAUDE_CODE_OAUTH_TOKEN`, which no process can unset, so disconnect
 * deleted the account email, changed nothing else, and the host reported itself
 * connected a moment later. Second it was destructive beyond its remit — on a
 * developer Mac it logged you out of Claude Code itself.
 *
 * Patch now owns its credential (`~/.patch/claude-oauth.json`) and that store is
 * the only source read, so emptying it IS a complete disconnect. Claude Code's
 * login is left alone, which also makes reconnecting instant.
 *
 * The store is EMPTIED, never deleted: an absent store means "first boot, seed
 * me", and re-seeding would silently restore the very credential the user just
 * revoked.
 */

/**
 * `readPatchStore`, but a malformed/unreadable store reports as "nothing to
 * resolve a target account from" instead of throwing. Both `disconnectClaude`
 * and `connectClaude` read the store up front ONLY to work out which account
 * id they are acting on — the write attempt just below already reports (not
 * throws) on the exact same failure, so this first read must not crash ahead
 * of it on a store that's a directory, unreadable, or corrupt on disk. NO
 * FALLBACK: this never invents a credential, it only avoids letting a doomed
 * write crash the host before its own error handling gets a turn.
 */
function readPatchStoreSafe(
  loadOpts: LoadClaudeOAuthOptions,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
  action: 'claude.disconnect' | 'claude.connect' | 'claude.add_account',
): ReturnType<typeof readPatchStore> {
  try {
    return readPatchStore(loadOpts);
  } catch (err) {
    logger?.error(
      { err: (err as Error).message },
      `${action}: failed to read credential store while resolving the target account`,
    );
    return null;
  }
}

/**
 * Why a submitted token was NOT stored (spec/10-auth.md § Validating a pasted
 * token). Mirrors `daemon.account`'s `credentialError`, which is where a surface
 * reads it.
 */
export interface CredentialRejection {
  /**
   * `duplicate` is not Anthropic refusing anything — the token is perfectly
   * good. It is patch refusing to store a SECOND credential for an account it
   * already holds, because two rows sharing one organisation share one pool of
   * credit: the failover walks from one to the other, asks the same account
   * twice, and reports "every account is out of credit" having tried one.
   * That is precisely what this host did with "Default" and "work".
   */
  kind: 'rejected' | 'unreachable' | 'duplicate';
  message: string;
}

/**
 * Checks a token with Anthropic before it is stored. Injectable so tests never
 * touch the real API — the ONLY reason this is a parameter.
 */
export type ClaudeTokenValidator = (accessToken: string) => Promise<ClaudeTokenValidation>;

/**
 * Validate a pasted token, or explain why it cannot be stored.
 *
 * Returns null when the token is good. NO FALLBACK: an `unreachable` result is
 * NOT treated as a pass, because storing a token nobody has confirmed is exactly
 * how an invalid one comes to be discovered by a chat that fails later — the
 * defect this check exists to remove.
 */
async function rejectBadToken(
  accessToken: string,
  validate: ClaudeTokenValidator | undefined,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
  action: 'claude.connect' | 'claude.add_account',
): Promise<{ rejection: CredentialRejection } | { organizationId: string | undefined }> {
  const result = await (validate ?? ((t: string) => validateClaudeOAuthToken(t)))(accessToken);
  if (result.kind === 'valid') return { organizationId: result.organizationId };
  logger?.warn({ kind: result.kind, reason: result.message }, `${action}: token not stored`);
  return { rejection: { kind: result.kind, message: result.message } };
}

/**
 * Refuse a token that belongs to an account patch already holds.
 *
 * Returns null when the token is a genuinely new account, when its
 * organisation could not be established (unknown is not "different" — but it
 * is also not grounds to refuse a token the user is trying to add), or when
 * the match is the very slot being re-connected, which is a rotated token
 * rather than a duplicate.
 *
 * Deliberately refuses rather than warns. A warning here would leave the store
 * in the state that caused the incident, and the cost of being wrong is one
 * re-paste.
 */
function rejectDuplicateAccount(
  accounts: readonly ClaudeStoredAccount[],
  organizationId: string | undefined,
  exceptId: string | undefined,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
  action: 'claude.connect' | 'claude.add_account',
): CredentialRejection | null {
  const clash = findAccountByOrganization(accounts, organizationId, exceptId);
  if (!clash) return null;
  logger?.warn(
    { organizationId, existingAccountId: clash.id, existingLabel: clash.label },
    `${action}: token belongs to an account already stored`,
  );
  return {
    kind: 'duplicate',
    message: `This token is for the same Claude account as "${clash.label}" — they share one pool of credit, so adding it again would not give patch anywhere to fail over to. Paste a token for a different account, or reconnect "${clash.label}" instead.`,
  };
}

export function disconnectClaude(opts: {
  env?: NodeJS.ProcessEnv;
  /** Override the credentials-file path (tests / sandbox). */
  credentialsPath?: string;
  /** Extra loader overrides (store path / platform) — test hook. */
  loadOptions?: LoadClaudeOAuthOptions;
  /** Which stored account to disconnect. Omitted means the active account. */
  accountId?: string;
  /** Keychain deleter override. Unused now; kept so callers/tests still compile. */
  deleteKeychain?: () => boolean;
  logger?: Pick<Logger, 'warn' | 'error'>;
}): DisconnectClaudeResult {
  const env = opts.env ?? process.env;
  const loadOpts: LoadClaudeOAuthOptions = {
    ...opts.loadOptions,
    ...(opts.credentialsPath !== undefined ? { path: opts.credentialsPath } : {}),
    env,
  };

  const before = readPatchStoreSafe(loadOpts, opts.logger, 'claude.disconnect');
  const targetId = opts.accountId ?? before?.activeAccountId ?? null;

  let storeEmptied = false;
  try {
    disconnectPatchStore(loadOpts, opts.accountId);
    storeEmptied = true;
    opts.logger?.warn({ accountId: targetId }, 'claude.disconnect: emptied a stored account');
  } catch (err) {
    // NO FALLBACK: if the store can't be written the user is NOT disconnected, and
    // the post-clear re-read below reports that truthfully.
    opts.logger?.error(
      { err: (err as Error).message },
      'claude.disconnect: failed to empty credential store',
    );
  }

  const after = bootstrapClaudeOAuth({ ...loadOpts, ...(targetId ? { accountId: targetId } : {}) });
  return {
    connected: after.credentials !== undefined,
    email: after.credentials?.email ?? null,
    storeEmptied,
    accountId: targetId,
  };
}

/**
 * Settings "connect": set the credential explicitly. Either a token pasted by the
 * user (`claude setup-token`) or one re-read from Claude Code on this host.
 *
 * This is the other half of making the credential revocable — without it a
 * disconnect would strand the host until someone edited config on the host.
 *
 * A PASTED token is checked with Anthropic first (spec/10-auth.md § Validating a
 * pasted token) and nothing is written unless it comes back valid; the returned
 * `rejection` says why not. The re-adopt-the-host-credential path is not a token
 * the user typed, so it is not re-validated — the periodic credential check
 * already reports on a credential that has gone bad since.
 */
export interface ConnectClaudeResult extends DisconnectClaudeResult {
  /** Set when a submitted token was refused, in which case NOTHING was stored. */
  rejection?: CredentialRejection;
}

export async function connectClaude(opts: {
  /** Paste path: an explicit access token. */
  accessToken?: string;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  loadOptions?: LoadClaudeOAuthOptions;
  /** Which stored account to set. Omitted means the active account (creating the first one if none exists yet). */
  accountId?: string;
  /** Token validator override (tests). Defaults to the real Anthropic check. */
  validate?: ClaudeTokenValidator;
  logger?: Pick<Logger, 'warn' | 'error'>;
}): Promise<ConnectClaudeResult> {
  const env = opts.env ?? process.env;
  const loadOpts: LoadClaudeOAuthOptions = {
    ...opts.loadOptions,
    ...(opts.credentialsPath !== undefined ? { path: opts.credentialsPath } : {}),
    env,
  };

  const before = readPatchStoreSafe(loadOpts, opts.logger, 'claude.connect');
  const targetId = opts.accountId ?? before?.activeAccountId ?? DEFAULT_ACCOUNT_ID;

  let organizationId: string | undefined;
  if (opts.accessToken && opts.accessToken.length > 0) {
    const checked = await rejectBadToken(
      opts.accessToken,
      opts.validate,
      opts.logger,
      'claude.connect',
    );
    const rejection =
      'rejection' in checked
        ? checked.rejection
        : // A re-connect targets one slot, so that slot is exempt: replacing an
          // account's own token with a fresh one for the same organisation is a
          // rotation, not a duplicate.
          rejectDuplicateAccount(
            before?.accounts ?? [],
            checked.organizationId,
            targetId,
            opts.logger,
            'claude.connect',
          );
    if (rejection) {
      // Report the state that is still true — the store was not touched.
      const unchanged = bootstrapClaudeOAuth({ ...loadOpts, accountId: targetId });
      return {
        connected: unchanged.credentials !== undefined,
        email: unchanged.credentials?.email ?? null,
        storeEmptied: false,
        accountId: targetId,
        rejection,
      };
    }
    organizationId = 'organizationId' in checked ? checked.organizationId : undefined;
  }

  try {
    if (opts.accessToken && opts.accessToken.length > 0) {
      connectPatchStore(
        {
          accessToken: opts.accessToken,
          ...(organizationId !== undefined ? { organizationId } : {}),
        },
        loadOpts,
        opts.accountId,
      );
      opts.logger?.warn({ accountId: targetId }, 'claude.connect: stored a pasted access token');
    } else {
      // Re-read from Claude Code on this host. The store is emptied first so the
      // seed path is eligible again — seedPatchStore deliberately refuses to write
      // over an existing store.
      const legacy = loadLegacyClaudeOAuth(loadOpts);
      connectPatchStore(
        {
          accessToken: legacy.accessToken,
          ...(legacy.refreshToken ? { refreshToken: legacy.refreshToken } : {}),
          ...(legacy.expiresAt !== undefined ? { expiresAt: legacy.expiresAt } : {}),
          ...(legacy.email ? { email: legacy.email } : {}),
        },
        loadOpts,
        opts.accountId,
      );
      opts.logger?.warn(
        { from: legacy.sourcePath, accountId: targetId },
        'claude.connect: adopted host credential',
      );
    }
  } catch (err) {
    opts.logger?.error({ err: (err as Error).message }, 'claude.connect: failed');
  }

  const after = bootstrapClaudeOAuth({ ...loadOpts, accountId: targetId });
  return {
    connected: after.credentials !== undefined,
    email: after.credentials?.email ?? null,
    storeEmptied: false,
    accountId: targetId,
  };
}

/**
 * Settings "add another account" (spec/10-auth.md § Backend credentials —
 * multiple accounts): always creates a NEW stored account from a pasted token,
 * never replacing an existing one — the counterpart to `connectClaude`, which
 * replaces one slot. There is no "re-adopt the host's own login" case here: an
 * added account has to name an explicit credential, since the host's own
 * ambient login is already covered by the first (default) account.
 */
export interface AddClaudeAccountResult {
  accountId: string;
  label: string;
  connected: boolean;
  email: string | null;
}

/**
 * Either the account that was added, or why the token was refused — never both,
 * and never a half-written account. An `added` of null means the store is
 * untouched.
 */
export interface AddClaudeAccountOutcome {
  added: AddClaudeAccountResult | null;
  rejection?: CredentialRejection;
}

export async function addClaudeAccount(opts: {
  accessToken: string;
  label?: string;
  env?: NodeJS.ProcessEnv;
  loadOptions?: LoadClaudeOAuthOptions;
  /** Token validator override (tests). Defaults to the real Anthropic check. */
  validate?: ClaudeTokenValidator;
  logger?: Pick<Logger, 'warn' | 'error'>;
}): Promise<AddClaudeAccountOutcome> {
  const env = opts.env ?? process.env;
  const loadOpts: LoadClaudeOAuthOptions = { ...opts.loadOptions, env };

  // Checked BEFORE the slot is created, so a bad token leaves no empty account
  // behind for the user to delete (spec/10-auth.md § Validating a pasted token).
  const checked = await rejectBadToken(
    opts.accessToken,
    opts.validate,
    opts.logger,
    'claude.add_account',
  );
  if ('rejection' in checked) return { added: null, rejection: checked.rejection };

  // Nothing is exempt on an ADD: every existing account is a slot this token
  // must not duplicate.
  const existing = readPatchStoreSafe(loadOpts, opts.logger, 'claude.add_account');
  const duplicate = rejectDuplicateAccount(
    existing?.accounts ?? [],
    checked.organizationId,
    undefined,
    opts.logger,
    'claude.add_account',
  );
  if (duplicate) return { added: null, rejection: duplicate };

  const account = addPatchStoreAccount(
    {
      accessToken: opts.accessToken,
      ...(checked.organizationId !== undefined ? { organizationId: checked.organizationId } : {}),
    },
    loadOpts,
    opts.label,
  );
  opts.logger?.warn(
    { accountId: account.id, label: account.label },
    'claude.add_account: stored a new account',
  );

  const after = bootstrapClaudeOAuth({ ...loadOpts, accountId: account.id });
  return {
    added: {
      accountId: account.id,
      label: account.label,
      connected: after.credentials !== undefined,
      email: after.credentials?.email ?? null,
    },
  };
}

/**
 * Set the priority order of this host's stored Claude accounts (Settings →
 * drag to rank). The store's `accounts` array IS the failover priority
 * (accountFailover.ts — PRIORITY IS ORDER), so rewriting it in the requested
 * order is the whole operation; `activeAccountId` and every credential are
 * left exactly as they were. Throws, writing nothing, unless `accountIds`
 * names exactly the stored accounts, each once.
 */
export function reorderClaudeAccounts(opts: {
  accountIds: readonly string[];
  loadOptions?: LoadClaudeOAuthOptions;
}): void {
  const loadOpts: LoadClaudeOAuthOptions = { ...opts.loadOptions };
  const store = readPatchStore(loadOpts) ?? { accounts: [], activeAccountId: null };
  const mismatch = accountOrderMismatch(
    store.accounts.map((a) => a.id),
    opts.accountIds,
  );
  if (mismatch) throw new Error(`host.backend_reorder_accounts: ${mismatch}`);
  const byId = new Map(store.accounts.map((a) => [a.id, a]));
  writePatchStore(
    {
      accounts: opts.accountIds.map((id) => byId.get(id)!),
      activeAccountId: store.activeAccountId,
      ...(store.seededFrom ? { seededFrom: store.seededFrom } : {}),
    },
    loadOpts,
  );
}

// ---------------------------------------------------------------------------
// QR host registration (spec/10-auth.md "Host registration").
//
// The registration window is ALWAYS opened from a linked surface (H1): an
// already-linked surface (the web Settings "add-daemon QR") mints the
// single-use registration nonce and renders the QR; the host is started
// with that surface-issued pairing code (`patch host start --pair <code>`).
// The host NEVER self-issues a registration nonce — there is no
// register/start route any more.
//
// When ~/.patch/daemon.key is absent and a pairing code is supplied the daemon:
//   1. POST {serverUrl}/api/auth/daemon/register/complete {nonce,daemonId,label}
//        against the surface-issued nonce; the SERVER mints the daemonKey.
//   2. Long-poll GET {serverUrl}/api/auth/daemon/register/await?nonce=<nonce>
//        -> 200 {daemonKey}; 408 on timeout (window expired) -> abort, the user
//           re-opens the add-daemon QR on a surface and restarts with the new code.
//   3. writeDaemonKey(patchHome, daemonKey).
//
// NO FALLBACK: we never proceed without a real, surface-signed daemonKey, and
// every failure is logged. But in the production/Docker topology the daemon can
// boot BEFORE the server is reachable or BEFORE an account is bootstrapped on
// the server. That's a TRANSIENT precondition, not a fallback: a connection
// error, a 5xx from register/complete or register/await, or a malformed
// response is caught, LOGGED (warn, with the error), and retried after a
// backoff delay (1s -> 2s -> 5s -> 10s, capped 30s; reset once a round-trip
// reaches the server). An aborted signal still breaks the loop.

/** Registration retry backoff schedule in ms. Last value is the steady-state cap. */
export const REGISTER_BACKOFF_SCHEDULE_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface RegisterStartResponse {
  nonce: string;
  expiresAt: number;
}

/** Result of a successful registration: the signed daemonKey JWT + chosen id/label. */
export interface RegistrationResult {
  daemonKey: string;
  daemonId: string;
  label: string;
}

export interface RegisterDaemonOptions {
  serverUrl: string;
  /** `~/.patch` — where this machine's identity keypair lives. */
  patchHome: string;
  logger: Logger;
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  daemonId?: string;
  label?: string;
  /** Render the pairing nonce as a terminal QR (overridable in tests). */
  renderQr?: (nonce: string) => void;
  /** Abort the long-poll loop (tests). */
  signal?: AbortSignal;
  /** Retry backoff schedule in ms (overridable in tests). */
  backoffSchedule?: readonly number[];
  /** Sleep used between retries — injectable so tests don't actually wait. */
  delay?: (ms: number) => Promise<void>;
  /**
   * spec/14 `/settings` add-daemon QR: a nonce pre-issued by a linked surface
   * (the web Settings page) and scanned on the host. When set, the
   * host skips its own `register/start` and awaits this nonce directly — the
   * surface opened the registration window, not the host.
   */
  prePairedNonce?: string;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRenderQr(nonce: string): void {
  process.stdout.write('\nScan this QR from a linked patch surface to authorise this daemon:\n\n');
  qrcode.generate(nonce, { small: true });
  process.stdout.write(`\nPairing code: ${nonce}\n\n`);
}

async function registerStart(
  fetchImpl: typeof fetch,
  serverUrl: string,
  daemonId: string,
  label: string,
): Promise<RegisterStartResponse> {
  const res = await fetchImpl(`${serverUrl}/api/auth/daemon/register/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemonId, label }),
  });
  if (!res.ok) {
    throw new Error(`host register/start failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>)['nonce'] !== 'string' ||
    typeof (body as Record<string, unknown>)['expiresAt'] !== 'number'
  ) {
    throw new Error('host register/start: malformed response (expected {nonce,expiresAt})');
  }
  return body as RegisterStartResponse;
}

/**
 * Submit register/complete with this host's chosen id + label. The SERVER is
 * the credential authority and MINTS the daemonKey (spec/10 § Host
 * registration). The minted key is relayed to the long-poll `await`. A 4xx
 * (e.g. unknown/expired nonce) throws so the caller can re-issue the QR.
 */
async function registerComplete(
  fetchImpl: typeof fetch,
  serverUrl: string,
  nonce: string,
  daemonId: string,
  label: string,
  publicKey: string,
): Promise<void> {
  const res = await fetchImpl(`${serverUrl}/api/auth/daemon/register/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, daemonId, label, publicKey }),
  });
  if (!res.ok) {
    throw new Error(`host register/complete failed: HTTP ${res.status}`);
  }
}

/**
 * Long-poll await. Resolves with the daemonKey on 200, returns undefined on
 * 408 (the caller re-issues start). Any other status throws (NO FALLBACK).
 */
async function registerAwait(
  fetchImpl: typeof fetch,
  serverUrl: string,
  nonce: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const url = `${serverUrl}/api/auth/daemon/register/await?nonce=${encodeURIComponent(nonce)}`;
  const res = await fetchImpl(url, signal ? { signal } : {});
  if (res.status === 408) return undefined;
  if (!res.ok) {
    throw new Error(`host register/await failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>)['daemonKey'] !== 'string' ||
    ((body as Record<string, unknown>)['daemonKey'] as string).length === 0
  ) {
    throw new Error('host register/await: malformed response (expected {daemonKey})');
  }
  return (body as { daemonKey: string }).daemonKey;
}

/**
 * Run the full QR registration flow. Loops start -> show QR -> await until a
 * daemonKey comes back, re-issuing on 408 timeout. Does NOT write the key to
 * disk — the caller does that via writeDaemonKey so the I/O stays in one place.
 */
export async function registerDaemon(opts: RegisterDaemonOptions): Promise<RegistrationResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // This machine's own identity (spec/10 § Host registration): its stable
  // daemonId and the public key it registers with. Minted once, under the
  // host user's own ~/.patch, so a re-run is the SAME machine.
  const identity = loadOrCreateDaemonIdentity(opts.patchHome);
  const daemonId = opts.daemonId ?? identity.daemonId;
  const label = opts.label ?? hostname();
  const renderQr = opts.renderQr ?? defaultRenderQr;
  const serverUrl = opts.serverUrl.replace(/\/+$/, '');
  const schedule = opts.backoffSchedule ?? REGISTER_BACKOFF_SCHEDULE_MS;
  const delay = opts.delay ?? defaultDelay;

  // Index into `schedule`; reset to 0 every time a round-trip reaches the
  // server (success or a clean 408). Only transient failures advance it.
  let attempt = 0;

  for (;;) {
    if (opts.signal?.aborted) throw new Error('host registration aborted');
    try {
      // Surface-initiated (spec/14 add-daemon QR): the web Settings page already
      // minted the nonce; await it directly rather than self-issuing one. The
      // QR was shown on the surface, so we don't re-render it here.
      let nonce: string;
      if (opts.prePairedNonce !== undefined && opts.prePairedNonce.length > 0) {
        nonce = opts.prePairedNonce;
        opts.logger.info(
          { daemonId, label },
          'host registration: awaiting surface-issued pairing nonce',
        );
      } else {
        nonce = (await registerStart(fetchImpl, serverUrl, daemonId, label)).nonce;
        opts.logger.info({ daemonId, label }, 'host registration: awaiting surface approval');
        renderQr(nonce);
      }
      // The SERVER mints the daemonKey: submit our id + label against the nonce,
      // then pick up the minted key via the long-poll await.
      await registerComplete(fetchImpl, serverUrl, nonce, daemonId, label, identity.publicKey);
      const daemonKey = await registerAwait(fetchImpl, serverUrl, nonce, opts.signal);
      // The round-trip reached the server — reset the transient backoff.
      attempt = 0;
      if (daemonKey !== undefined) {
        opts.logger.info({ daemonId, label }, 'host registration: daemonKey received');
        return { daemonKey, daemonId, label };
      }
      opts.logger.warn('host registration: pairing window expired, re-issuing QR');
    } catch (err) {
      // An aborted signal is terminal — break the loop, never retry.
      if (opts.signal?.aborted) throw new Error('host registration aborted');
      // Anything else is a transient precondition (server not yet reachable,
      // account not yet bootstrapped, etc.). NO FALLBACK: we never proceed
      // without a real daemonKey — we log loudly and patiently retry.
      const wait = schedule[Math.min(attempt, schedule.length - 1)] ?? 30_000;
      attempt += 1;
      opts.logger.warn(
        { err, wait, daemonId, label },
        'host registration: server not ready (transient) — retrying after backoff',
      );
      await delay(wait);
    }
  }
}
