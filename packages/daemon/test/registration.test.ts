// Host key write-atomic + 0600 mode. OAuth bootstrap returns typed errors
// without throwing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  bootstrapClaudeOAuth,
  claudeConfigPath,
  daemonKeyPath,
  disconnectClaude,
  connectClaude,
  addClaudeAccount,
  makeResolveOAuth,
  readDaemonKey,
  registerDaemon,
  reorderClaudeAccounts,
  writeDaemonKey,
} from '../src/registration.js';
import { existsSync } from 'node:fs';
import { seedPatchStore, readPatchStore, writePatchStore } from '@patch/auth';
import type { PatchStoreContents, PatchStoredCredential } from '@patch/auth';

const silent = pino({ level: 'silent' });

/**
 * The pre-multi-account tests below assert on "the" credential, back when the
 * store held exactly one. `readPatchStore` now returns an account LIST
 * (spec/10 § Multiple accounts), so this resolves the same thing these tests
 * mean: whichever account is active (falling back to the first, mirroring
 * `loadClaudeOAuth`'s own resolution order).
 */
function activeCredential(store: PatchStoreContents | null): PatchStoredCredential | null {
  if (!store) return null;
  const account =
    store.accounts.find((a) => a.id === store.activeAccountId) ?? store.accounts[0] ?? null;
  return account?.credential ?? null;
}

describe('registration', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-reg-'));
  });

  it('writes daemon.key atomically with mode 0600', () => {
    writeDaemonKey(home, 'creds-jwt-here');
    const path = daemonKeyPath(home);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('creds-jwt-here');
    expect(readDaemonKey(home)).toBe('creds-jwt-here');
  });

  it('readDaemonKey returns undefined when absent', () => {
    expect(readDaemonKey(home)).toBeUndefined();
  });

  it('readDaemonKey returns undefined for a whitespace-only file (trim().length === 0)', () => {
    const path = daemonKeyPath(home);
    mkdirSync(join(home), { recursive: true });
    writeFileSync(path, '   \n  ', 'utf8');
    expect(readDaemonKey(home)).toBeUndefined();
  });

  it('readDaemonKey rethrows a non-ENOENT fs error', () => {
    // Point at a DIRECTORY where a file is expected — readFileSync throws
    // EISDIR, not ENOENT, so the rethrow branch (not the "absent" branch) fires.
    const dirAsFile = join(home, 'daemon.key');
    mkdirSync(dirAsFile);
    expect(() => readDaemonKey(home)).toThrow();
  });

  it('overwrite via temp+rename leaves a single key file', () => {
    writeDaemonKey(home, 'first');
    writeDaemonKey(home, 'second');
    expect(readDaemonKey(home)).toBe('second');
  });

  // env:{} + platform:'linux' isolate the credentials-FILE source so the test
  // is deterministic on a dev Mac (whose Keychain holds a real token) too.
  // storePath is REQUIRED here: without it these resolve patch's real credential
  // store under ~/.patch, and the seed/disconnect paths would read and WRITE the
  // developer's home directory from a unit test. That happened.
  const fileEnv = (): { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; storePath: string } => ({
    env: {},
    platform: 'linux' as NodeJS.Platform,
    storePath: join(home, 'patch-claude-store.json'),
  });

  it('bootstrapClaudeOAuth returns typed `missing` error when the credentials file is absent', () => {
    const result = bootstrapClaudeOAuth({ path: join(home, 'nope.json'), ...fileEnv() });
    expect(result.credentials).toBeUndefined();
    expect(result.error?.kind).toBe('missing');
    expect(result.error?.message).toMatch(/claude login/);
  });

  it('bootstrapClaudeOAuth returns typed `malformed` error on bad JSON', () => {
    const path = join(home, 'bad.json');
    writeFileSync(path, '{not-json', 'utf8');
    const result = bootstrapClaudeOAuth({ path, ...fileEnv() });
    expect(result.error?.kind).toBe('malformed');
  });

  it('bootstrapClaudeOAuth returns credentials for a well-formed credentials file', () => {
    const path = join(home, 'good.json');
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'abc-123', refreshToken: 'r', expiresAt: 1, scopes: [] },
      }),
      'utf8',
    );
    const result = bootstrapClaudeOAuth({ path, ...fileEnv() });
    expect(result.credentials?.accessToken).toBe('abc-123');
  });

  it('bootstrapClaudeOAuth rethrows an error that is neither Missing nor Malformed', async () => {
    // loadClaudeOAuth only ever throws these two typed errors today; drive the
    // defensive rethrow branch by mocking @patch/auth to throw a third kind.
    vi.doMock('@patch/auth', async () => {
      const actual = await vi.importActual<typeof import('@patch/auth')>('@patch/auth');
      return {
        ...actual,
        loadClaudeOAuth: () => {
          throw new Error('totally unexpected failure');
        },
      };
    });
    try {
      vi.resetModules();
      const fresh = await import('../src/registration.js');
      expect(() => fresh.bootstrapClaudeOAuth({ path: join(home, 'x.json') })).toThrow(
        /totally unexpected failure/,
      );
    } finally {
      vi.doUnmock('@patch/auth');
      vi.resetModules();
    }
  });

  it('claudeConfigPath falls back to ~/.claude.json when CLAUDE_CONFIG_PATH is unset (pure, no fs access)', () => {
    expect(claudeConfigPath({})).toBe(join(homedir(), '.claude.json'));
    expect(claudeConfigPath({ CLAUDE_CONFIG_PATH: '/custom/path.json' })).toBe('/custom/path.json');
  });

  it("disconnectClaude empties patch's store and flips connected→false", () => {
    const storePath = join(home, 'patch-claude-store.json');
    const credPath = join(home, 'creds.json');
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }), 'utf8');
    // Seed the store the way boot does, so there is something to disconnect.
    seedPatchStore({ path: credPath, storePath, env: {}, platform: 'linux' });
    const result = disconnectClaude({
      env: {},
      credentialsPath: credPath,
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    expect(result.connected).toBe(false);
    expect(result.storeEmptied).toBe(true);
    // Emptied, NOT deleted: an absent store means "first boot, seed me", so
    // deleting it would let the next boot silently restore the credential.
    expect(existsSync(storePath)).toBe(true);
    expect(activeCredential(readPatchStore({ storePath, env: {} }))).toBeNull();
  });

  it('disconnect defeats a CLAUDE_CODE_OAUTH_TOKEN that is still in the environment', () => {
    // The production bug: the token arrives as container env, which no process can
    // unset, so the old disconnect deleted files that did not matter and the host
    // reported itself connected again on the next read.
    const storePath = join(home, 'patch-claude-store.json');
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'still-in-the-container' };
    seedPatchStore({ storePath, env, platform: 'linux' });
    const result = disconnectClaude({
      env,
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    expect(result.connected).toBe(false);
  });

  it("disconnect leaves Claude Code's own credential alone", () => {
    // It used to delete the credentials file and the macOS Keychain item, logging
    // the developer out of Claude Code itself. Patch only owns its own store.
    const storePath = join(home, 'patch-claude-store.json');
    const credPath = join(home, 'creds.json');
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }), 'utf8');
    seedPatchStore({ path: credPath, storePath, env: {}, platform: 'linux' });
    disconnectClaude({
      env: {},
      credentialsPath: credPath,
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    expect(existsSync(credPath)).toBe(true);
  });

  it('disconnect reports (not throws) when the store cannot be written', () => {
    // A directory where the store file should be makes the write fail.
    const storePath = join(home, 'unwritable');
    mkdirSync(storePath, { recursive: true });
    const result = disconnectClaude({
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    expect(result.storeEmptied).toBe(false);
    // NO FALLBACK: a failed write means NOT disconnected, and it says so.
    expect(result.connected).toBe(false);
  });

  it('connectClaude stores a pasted token, restoring access after a disconnect', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    disconnectClaude({ env: {}, loadOptions: { platform: 'linux', storePath }, logger: silent });
    // validate: always valid so the store write proceeds without a real network call.
    const result = await connectClaude({
      accessToken: 'pasted-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid' }),
    });
    expect(result.connected).toBe(true);
    expect(result.rejection).toBeUndefined();
    expect(activeCredential(readPatchStore({ storePath, env: {} }))?.accessToken).toBe(
      'pasted-token',
    );
  });

  it('connectClaude with no token re-adopts the host credential', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const credPath = join(home, 'creds.json');
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: 'host-tok', refreshToken: 'r' } }),
      'utf8',
    );
    disconnectClaude({
      env: {},
      credentialsPath: credPath,
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    // No accessToken → no validation call needed; re-adopts the host credential.
    const result = await connectClaude({
      env: {},
      credentialsPath: credPath,
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    expect(result.connected).toBe(true);
    expect(result.rejection).toBeUndefined();
    expect(activeCredential(readPatchStore({ storePath, env: {} }))).toMatchObject({
      accessToken: 'host-tok',
      refreshToken: 'r',
    });
  });

  it('connectClaude reports not-connected when there is nothing to adopt', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const result = await connectClaude({
      env: {},
      credentialsPath: join(home, 'absent.json'),
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
    });
    expect(result.connected).toBe(false);
    expect(result.rejection).toBeUndefined();
  });

  // ── Task 2: token validation at entry ──────────────────────────────────────

  it('connectClaude: a token Anthropic rejects is NOT stored (kind: rejected)', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    // Seed a real credential first so we can confirm the store is unchanged after.
    const credPath = join(home, 'creds.json');
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'good-tok' } }), 'utf8');
    seedPatchStore({ path: credPath, storePath, env: {}, platform: 'linux' });

    const result = await connectClaude({
      accessToken: 'bad-pasted-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({
        kind: 'rejected',
        message: 'Anthropic rejected this token (HTTP 401): {"error":"invalid_bearer_token"}',
      }),
    });
    // Nothing written — the existing credential is still there.
    expect(result.rejection).toBeDefined();
    expect(result.rejection?.kind).toBe('rejected');
    expect(activeCredential(readPatchStore({ storePath, env: {} }))?.accessToken).toBe('good-tok');
  });

  it('connectClaude: an unreachable check is NOT treated as a pass (kind: unreachable)', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const result = await connectClaude({
      accessToken: 'some-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({
        kind: 'unreachable',
        message: 'Could not reach Anthropic to check the token: ECONNREFUSED',
      }),
    });
    // Must not store: unreachable ≠ valid.
    expect(result.rejection).toBeDefined();
    expect(result.rejection?.kind).toBe('unreachable');
    // Store was not written — it is still empty (no credential).
    expect(activeCredential(readPatchStore({ storePath, env: {} }))).toBeNull();
  });

  // ── addClaudeAccount validation ─────────────────────────────────────────────

  it('addClaudeAccount: a valid token is stored and outcome.added is populated', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const outcome = await addClaudeAccount({
      accessToken: 'good-new-token',
      label: 'work',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid' }),
    });
    expect(outcome.added).not.toBeNull();
    expect(outcome.rejection).toBeUndefined();
    // The token should actually be in the store.
    const store = readPatchStore({ storePath, env: {} });
    const account = store?.accounts.find((a) => a.id === outcome.added?.accountId);
    expect(account?.credential?.accessToken).toBe('good-new-token');
  });

  it('addClaudeAccount: records the organisation the token belongs to', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const outcome = await addClaudeAccount({
      accessToken: 'good-new-token',
      label: 'work',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid', organizationId: 'org-1' }),
    });
    const store = readPatchStore({ storePath, env: {} });
    const account = store?.accounts.find((a) => a.id === outcome.added?.accountId);
    expect(account?.credential?.organizationId).toBe('org-1');
  });

  // THE guard against the 2026-09-11 incident: this host held "Default" and
  // "work" as two accounts that were one Claude account, so failover had
  // nowhere to go and said so only after spending a turn finding out.
  it('addClaudeAccount: refuses a token for an account already stored', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    await addClaudeAccount({
      accessToken: 'first-token',
      label: 'Default',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid', organizationId: 'org-same' }),
    });

    const outcome = await addClaudeAccount({
      accessToken: 'second-token-same-account',
      label: 'work',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid', organizationId: 'org-same' }),
    });

    expect(outcome.added).toBeNull();
    expect(outcome.rejection?.kind).toBe('duplicate');
    // It names the row it clashes with — "already added" is not actionable.
    expect(outcome.rejection?.message).toContain('Default');
    // Nothing written: still exactly one account.
    expect(readPatchStore({ storePath, env: {} })?.accounts).toHaveLength(1);
  });

  it('addClaudeAccount: accepts a token for a DIFFERENT account', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    await addClaudeAccount({
      accessToken: 'first-token',
      label: 'Default',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid', organizationId: 'org-a' }),
    });
    const outcome = await addClaudeAccount({
      accessToken: 'second-token',
      label: 'personal',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid', organizationId: 'org-b' }),
    });
    expect(outcome.added).not.toBeNull();
    expect(readPatchStore({ storePath, env: {} })?.accounts).toHaveLength(2);
  });

  // An unidentified token must still be storable: identity is an enrichment,
  // and refusing every token whose organisation we could not read would make a
  // network blip look like a duplicate.
  it('addClaudeAccount: two tokens of UNKNOWN organisation are not called duplicates', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    await addClaudeAccount({
      accessToken: 'first-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid' }),
    });
    const outcome = await addClaudeAccount({
      accessToken: 'second-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid' }),
    });
    expect(outcome.rejection).toBeUndefined();
    expect(readPatchStore({ storePath, env: {} })?.accounts).toHaveLength(2);
  });

  it('addClaudeAccount: a token Anthropic rejects leaves the store untouched (kind: rejected)', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const outcome = await addClaudeAccount({
      accessToken: 'bad-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({
        kind: 'rejected',
        message: 'Anthropic rejected this token (HTTP 401)',
      }),
    });
    expect(outcome.added).toBeNull();
    expect(outcome.rejection?.kind).toBe('rejected');
    // Store is still empty — no account was created.
    expect(readPatchStore({ storePath, env: {} })).toBeNull();
  });

  it('addClaudeAccount: unreachable check leaves the store untouched (kind: unreachable)', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const outcome = await addClaudeAccount({
      accessToken: 'some-token',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({
        kind: 'unreachable',
        message: 'Could not reach Anthropic: ETIMEDOUT',
      }),
    });
    expect(outcome.added).toBeNull();
    expect(outcome.rejection?.kind).toBe('unreachable');
    // Store is still empty.
    expect(readPatchStore({ storePath, env: {} })).toBeNull();
  });

  // ── Task 1: stale name regression ───────────────────────────────────────────
  // The account email used to come from `oauth.credentials` (a snapshot taken
  // at boot). After switching, any report built WITHOUT an explicit override
  // reverted to the old credential's email. The fix: always read from the
  // store, so the name is whatever is actually stored.

  it('connectClaude: a successful connect stores the email from the token, not a stale snapshot', async () => {
    const storePath = join(home, 'patch-claude-store.json');
    const credPath = join(home, 'creds.json');
    // Seed "old account" with an email.
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: 'old-tok', email: 'old@example.com' } }),
      'utf8',
    );
    seedPatchStore({ path: credPath, storePath, env: {}, platform: 'linux' });

    // Now connect with a new pasted token (no email — pasted tokens never carry one).
    const result = await connectClaude({
      accessToken: 'new-tok',
      env: {},
      loadOptions: { platform: 'linux', storePath },
      logger: silent,
      validate: async () => ({ kind: 'valid' }),
    });
    expect(result.rejection).toBeUndefined();
    expect(result.connected).toBe(true);
    // After writing: the active credential has the new token.
    const stored = activeCredential(readPatchStore({ storePath, env: {} }));
    expect(stored?.accessToken).toBe('new-tok');
    // The pasted token has no email — the result email is null, not the old one.
    expect(result.email).toBeNull();
  });
});

describe('makeResolveOAuth — remaining branches', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-reg-resolve-'));
  });

  /**
   * The loader options that describe THIS fixture's machine and nothing else.
   *
   * `env: {}` and `platform: 'linux'` shut out the env token and the Keychain,
   * but patch's OWN store outranks both and every legacy source — and its
   * default path is `~/.patch/claude-oauth.json` in the REAL home. On any host
   * that has run `claude login` through patch (every host, including the
   * deployment box) these cases resolved the operator's live token instead of
   * their fixture: "a missing credential refuses" got `ok: true`, and the cases
   * pinning an access token got a real `sk-ant-oat01-…` back. Pointing storePath
   * at a path inside the temp home makes the store absent, which is what these
   * cases mean by a machine with only a credentials file.
   */
  const loadOptions = (extra: { path?: string } = {}) => ({
    env: {},
    platform: 'linux' as NodeJS.Platform,
    storePath: join(home, 'claude-oauth.json'),
    ...extra,
  });

  it('omitting claudeCredentialsPath falls through to loadOptions.path', async () => {
    const path = join(home, 'nope.json');
    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      loadOptions: loadOptions({ path }),
    });
    const res = await resolve();
    expect(res.ok).toBe(false);
  });

  it('honours an injected `now` clock', async () => {
    const path = join(home, '.credentials.json');
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000_000 },
      }),
      'utf8',
    );
    let nowCalled = false;
    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      claudeCredentialsPath: path,
      loadOptions: loadOptions(),
      now: () => {
        nowCalled = true;
        return 500_000; // comfortably before expiresAt -> not stale
      },
    });
    const res = await resolve();
    expect(nowCalled).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.ok && res.accessToken).toBe('a');
  });

  it('logs .info on a successful self-refresh when a logger is provided', async () => {
    const path = join(home, '.credentials.json');
    writeFileSync(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: 'stale', refreshToken: 'r1', expiresAt: 1 } }),
      'utf8',
    );
    const infoCalls: unknown[] = [];
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }),
      }) as unknown as Response) as unknown as typeof fetch;
    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      claudeCredentialsPath: path,
      loadOptions: loadOptions(),
      refreshOptions: { fetchImpl: fakeFetch },
      logger: {
        info: (...args: unknown[]) => infoCalls.push(args),
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const res = await resolve();
    expect(res.ok).toBe(true);
    expect(infoCalls).toHaveLength(1);
  });

  it('a FAILING refresh logs .error (when provided) and returns ok:false with an actionable reason', async () => {
    const path = join(home, '.credentials.json');
    writeFileSync(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: 'stale', refreshToken: 'r1', expiresAt: 1 } }),
      'utf8',
    );
    const errorCalls: unknown[] = [];
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      }) as unknown as Response) as unknown as typeof fetch;
    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      claudeCredentialsPath: path,
      loadOptions: loadOptions(),
      refreshOptions: { fetchImpl: fakeFetch },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => errorCalls.push(args),
      },
    });
    const res = await resolve();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/refresh failed/i);
    expect(errorCalls).toHaveLength(1);
  });

  it('omitting refreshOptions falls back to the real refreshClaudeOAuth default ({}), still failing safely offline', async () => {
    const path = join(home, '.credentials.json');
    writeFileSync(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: 'stale', refreshToken: 'r1', expiresAt: 1 } }),
      'utf8',
    );
    // Stub the GLOBAL fetch for the duration of this test only, so the
    // `opts.refreshOptions ?? {}` fallback (no override at all) is exercised
    // without making a real network call.
    const originalFetch = globalThis.fetch;
    let calledUrl: string | undefined;
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const resolve = makeResolveOAuth({
        sdkBackend: 'real',
        claudeCredentialsPath: path,
        loadOptions: loadOptions(),
        // refreshOptions intentionally omitted.
      });
      const res = await resolve();
      expect(res.ok).toBe(false);
      expect(calledUrl).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 408 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('registerDaemon (QR pairing flow)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-reg2-'));
  });

  it('starts, long-polls await, then returns the surface-signed daemonKey', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/register/start')) {
        return jsonResponse(200, { nonce: 'nonce-xyz', expiresAt: Date.now() + 60_000 });
      }
      // The host now posts complete itself; the SERVER mints the daemonKey.
      if (url.includes('/register/complete')) {
        return jsonResponse(200, { ok: true });
      }
      if (url.includes('/register/await')) {
        return jsonResponse(200, { daemonKey: 'signed.jwt.token' });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      daemonId: 'daemon-ulid',
      label: 'test-host',
      renderQr: () => undefined,
    });

    expect(result.daemonKey).toBe('signed.jwt.token');
    expect(result.daemonId).toBe('daemon-ulid');
    expect(calls[0]).toContain('/api/auth/daemon/register/start');
    expect(calls[1]).toContain('/api/auth/daemon/register/complete');
    expect(calls[2]).toContain('/api/auth/daemon/register/await?nonce=nonce-xyz');

    // The caller persists the key; confirm it lands atomically with mode 0600.
    writeDaemonKey(home, result.daemonKey);
    expect(readDaemonKey(home)).toBe('signed.jwt.token');
    expect(statSync(daemonKeyPath(home)).mode & 0o777).toBe(0o600);
  });

  it('with a prePairedNonce (surface-initiated add-daemon QR) skips register/start and awaits directly', async () => {
    const calls: string[] = [];
    let qrRendered = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/register/start')) {
        throw new Error('register/start must NOT be called when a surface issued the nonce');
      }
      if (url.includes('/register/complete')) {
        return jsonResponse(200, { ok: true });
      }
      if (url.includes('/register/await')) {
        return jsonResponse(200, { daemonKey: 'surface.signed.jwt' });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      daemonId: 'daemon-ulid',
      label: 'test-host',
      renderQr: () => {
        qrRendered = true;
      },
      prePairedNonce: 'surface-nonce-1',
    });

    expect(result.daemonKey).toBe('surface.signed.jwt');
    // It went straight to complete+await against the surface-issued nonce; no
    // start, no terminal QR render (the surface already showed the QR).
    expect(calls.every((u) => !u.includes('/register/start'))).toBe(true);
    expect(calls[0]).toContain('/api/auth/daemon/register/complete');
    expect(calls[1]).toContain('/api/auth/daemon/register/await?nonce=surface-nonce-1');
    expect(qrRendered).toBe(false);
  });

  it('re-issues start with a fresh QR after a 408 await timeout', async () => {
    let awaitCalls = 0;
    let startCalls = 0;
    const renderedNonces: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        startCalls += 1;
        return jsonResponse(200, { nonce: `nonce-${startCalls}`, expiresAt: 0 });
      }
      if (url.includes('/register/complete')) {
        return jsonResponse(200, { ok: true });
      }
      // first await times out (408), second succeeds.
      awaitCalls += 1;
      if (awaitCalls === 1) return jsonResponse(408, null);
      return jsonResponse(200, { daemonKey: 'jwt-2' });
    });

    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: (nonce) => renderedNonces.push(nonce),
    });

    expect(result.daemonKey).toBe('jwt-2');
    expect(startCalls).toBe(2);
    expect(renderedNonces).toEqual(['nonce-1', 'nonce-2']);
  });

  it('retries (does NOT crash) when register/start returns 400 before the server is bootstrapped', async () => {
    // Production/Docker: the daemon boots before the server has an account
    // bootstrapped. register/start fails (400) the first 2 attempts, then the
    // round-trip succeeds. registerDaemon must retry — never throw — and end
    // up with the surface-signed daemonKey.
    let startCalls = 0;
    const delays: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        startCalls += 1;
        if (startCalls <= 2) return jsonResponse(400, { error: 'no account yet' });
        return jsonResponse(200, { nonce: 'nonce-ok', expiresAt: Date.now() + 60_000 });
      }
      return jsonResponse(200, { daemonKey: 'jwt-after-retry' });
    });

    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      // Injected no-op delay so the test doesn't actually sleep.
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result.daemonKey).toBe('jwt-after-retry');
    expect(startCalls).toBe(3);
    // Two transient failures -> two backoff waits, following the schedule.
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('retries when the server is unreachable (fetch throws), then succeeds', async () => {
    let startCalls = 0;
    const delays: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        startCalls += 1;
        if (startCalls === 1) throw new TypeError('fetch failed: ECONNREFUSED');
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      return jsonResponse(200, { daemonKey: 'jwt-conn' });
    });

    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result.daemonKey).toBe('jwt-conn');
    expect(startCalls).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  it('an aborted signal breaks the retry loop (does not retry forever)', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        // Abort, then fail, so the catch sees the aborted signal and stops.
        controller.abort();
        throw new TypeError('fetch failed');
      }
      throw new Error(`unexpected url ${url}`);
    });

    await expect(
      registerDaemon({
        serverUrl: 'http://server:3000',
        patchHome: home,
        logger: silent,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        renderQr: () => undefined,
        signal: controller.signal,
        delay: async () => undefined,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it('an ALREADY-aborted signal at loop entry throws immediately without ever fetching', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw new Error('must not be called — signal was already aborted');
    });
    await expect(
      registerDaemon({
        serverUrl: 'http://server:3000',
        patchHome: home,
        logger: silent,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        renderQr: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries (transient) when register/start returns a malformed body (missing nonce/expiresAt)', async () => {
    let startCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        startCalls += 1;
        if (startCalls === 1) return jsonResponse(200, { nonce: 'n' }); // missing expiresAt
        return jsonResponse(200, { nonce: 'n2', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, { daemonKey: 'jwt-malformed-start-recovery' });
    });
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      delay: async () => undefined,
    });
    expect(result.daemonKey).toBe('jwt-malformed-start-recovery');
    expect(startCalls).toBe(2);
  });

  it('retries (transient) when register/complete responds non-ok', async () => {
    let completeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) {
        completeCalls += 1;
        if (completeCalls === 1) return jsonResponse(409, { error: 'nonce already used' });
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { daemonKey: 'jwt-complete-recovery' });
    });
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      delay: async () => undefined,
    });
    expect(result.daemonKey).toBe('jwt-complete-recovery');
    expect(completeCalls).toBe(2);
  });

  it('retries (transient) when register/await responds non-408 non-ok (e.g. 500)', async () => {
    let awaitCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
      awaitCalls += 1;
      if (awaitCalls === 1) return jsonResponse(500, { error: 'server hiccup' });
      return jsonResponse(200, { daemonKey: 'jwt-await-500-recovery' });
    });
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      delay: async () => undefined,
    });
    expect(result.daemonKey).toBe('jwt-await-500-recovery');
    expect(awaitCalls).toBe(2);
  });

  it('retries (transient) when register/await responds 200 with a malformed/empty daemonKey', async () => {
    let awaitCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
      awaitCalls += 1;
      if (awaitCalls === 1) return jsonResponse(200, { daemonKey: '' }); // empty -> malformed
      return jsonResponse(200, { daemonKey: 'jwt-malformed-await-recovery' });
    });
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      delay: async () => undefined,
    });
    expect(result.daemonKey).toBe('jwt-malformed-await-recovery');
    expect(awaitCalls).toBe(2);
  });

  it('passes a real (non-aborted) AbortSignal through to registerAwait on a full successful round trip', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
      // The await call must have been made WITH the signal wired through.
      expect(init?.signal).toBe(controller.signal);
      return jsonResponse(200, { daemonKey: 'jwt-with-signal' });
    });
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      signal: controller.signal,
    });
    expect(result.daemonKey).toBe('jwt-with-signal');
  });

  it('falls back to defaultDelay (a real timer) and 30_000ms when backoffSchedule is empty', async () => {
    let startCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        startCalls += 1;
        if (startCalls === 1) return jsonResponse(400, { error: 'not ready' });
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, { daemonKey: 'jwt-empty-schedule' });
    });
    const delays: number[] = [];
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      backoffSchedule: [],
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.daemonKey).toBe('jwt-empty-schedule');
    expect(delays).toEqual([30_000]);
  });

  it('omitting renderQr uses defaultRenderQr (writes a QR + pairing code to stdout)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/register/start')) {
          return jsonResponse(200, { nonce: 'nonce-default-qr', expiresAt: Date.now() + 60_000 });
        }
        if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
        return jsonResponse(200, { daemonKey: 'jwt-default-qr' });
      });
      const result = await registerDaemon({
        serverUrl: 'http://server:3000',
        patchHome: home,
        logger: silent,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        // renderQr intentionally omitted.
      });
      expect(result.daemonKey).toBe('jwt-default-qr');
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('nonce-default-qr');
    } finally {
      writeSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('omitting fetchImpl falls back to the global fetch (network-unreachable retry, then abort)', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    await expect(
      registerDaemon({
        // Port 1 on loopback refuses instantly — no DNS, no real network dependency.
        serverUrl: 'http://127.0.0.1:1',
        patchHome: home,
        logger: silent,
        renderQr: () => undefined,
        signal: controller.signal,
        delay: async (ms) => {
          delays.push(ms);
          controller.abort();
        },
      }),
    ).rejects.toThrow(/aborted/);
    expect(delays.length).toBeGreaterThan(0);
  });

  it('omitting delay uses the real defaultDelay (a genuine timer) across one retry', async () => {
    let startCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/register/start')) {
        startCalls += 1;
        if (startCalls === 1) return jsonResponse(400, { error: 'not ready yet' });
        return jsonResponse(200, { nonce: 'n', expiresAt: Date.now() + 60_000 });
      }
      if (url.includes('/register/complete')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, { daemonKey: 'jwt-real-delay' });
    });
    const result = await registerDaemon({
      serverUrl: 'http://server:3000',
      patchHome: home,
      logger: silent,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      renderQr: () => undefined,
      backoffSchedule: [15], // keep the real setTimeout short
      // delay intentionally omitted -> exercises the real defaultDelay.
    });
    expect(result.daemonKey).toBe('jwt-real-delay');
    expect(startCalls).toBe(2);
  });
});

describe('reorderClaudeAccounts — the stored order is the failover priority', () => {
  function seed(): string {
    const storePath = join(mkdtempSync(join(tmpdir(), 'patch-reorder-')), 'store.json');
    writePatchStore(
      {
        accounts: [
          { id: 'a', label: 'A', credential: { accessToken: 'tok-a', organizationId: 'org-a' } },
          { id: 'b', label: 'B', credential: { accessToken: 'tok-b' } },
          { id: 'c', label: 'C', credential: null },
        ],
        activeAccountId: 'a',
        seededFrom: '/somewhere',
      },
      { storePath, env: {} },
    );
    return storePath;
  }

  it('rewrites the accounts in the requested order and touches nothing else', () => {
    const storePath = seed();
    const before = readPatchStore({ storePath, env: {} })!;
    reorderClaudeAccounts({ accountIds: ['c', 'a', 'b'], loadOptions: { storePath, env: {} } });
    const after = readPatchStore({ storePath, env: {} })!;
    expect(after.accounts.map((a) => a.id)).toEqual(['c', 'a', 'b']);
    // Same records, same credentials — only their positions moved.
    for (const account of before.accounts) {
      expect(after.accounts.find((a) => a.id === account.id)).toEqual(account);
    }
    expect(after.activeAccountId).toBe('a');
    expect(after.seededFrom).toBe('/somewhere');
  });

  it('refuses an order that is not exactly the stored accounts, and writes nothing', () => {
    const storePath = seed();
    const raw = readFileSync(storePath, 'utf8');
    for (const accountIds of [
      ['a', 'b'],
      ['a', 'b', 'c', 'd'],
      ['a', 'a', 'b', 'c'],
    ]) {
      expect(() =>
        reorderClaudeAccounts({ accountIds, loadOptions: { storePath, env: {} } }),
      ).toThrow(/host\.backend_reorder_accounts: the order must name each held account/);
      expect(readFileSync(storePath, 'utf8')).toBe(raw);
    }
  });
});
