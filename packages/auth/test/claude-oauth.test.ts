import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadLegacyClaudeOAuth,
  clearClaudeOAuth,
  getClaudeOAuthToken,
  resolveClaudeConfigPath,
  refreshClaudeOAuth,
  persistClaudeOAuth,
  isClaudeOAuthStale,
  validateClaudeOAuthToken,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_OAUTH_BETA,
  type ClaudeOAuthCredentials,
  ClaudeOAuthMissingError,
  ClaudeOAuthMalformedError,
} from '../src/index.js';

// NOTE: these exercise the LEGACY seed chain (env → credentials file → Keychain),
// so they call loadLegacyClaudeOAuth directly. loadClaudeOAuth now consults patch's
// own store first, and reading the real ~/.patch/claude-oauth.json from a unit test
// would make results depend on whether the dev machine happens to have a host
// store — see claude-oauth-store.test.ts for the store's own coverage.
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

// Isolate the FILE source: empty env (no CLAUDE_CODE_OAUTH_TOKEN) and a
// non-darwin platform so the Keychain branch is never taken.
const fileOnly = (path: string) =>
  loadLegacyClaudeOAuth({ path, env: {}, platform: 'linux' as NodeJS.Platform });

describe('Claude OAuth loader', () => {
  it('reads a well-formed credentials file (claudeAiOauth.accessToken)', () => {
    const creds = fileOnly(join(fixturesDir, 'claude-good.json'));
    expect(creds.accessToken).toBe('test-oauth-token-abc123');
    expect(creds.sourcePath).toContain('claude-good.json');
  });

  it('getClaudeOAuthToken returns just the token', () => {
    expect(
      getClaudeOAuthToken({
        path: join(fixturesDir, 'claude-good.json'),
        // Point the store at a path that cannot exist so this asserts the legacy
        // chain, not whatever store the dev machine's host has written.
        storePath: join(fixturesDir, 'no-such-store.json'),
        env: {},
        platform: 'linux' as NodeJS.Platform,
      }),
    ).toBe('test-oauth-token-abc123');
  });

  it('prefers CLAUDE_CODE_OAUTH_TOKEN env over file/Keychain', () => {
    const creds = loadLegacyClaudeOAuth({
      path: join(fixturesDir, 'claude-good.json'),
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-wins-token' },
      platform: 'linux' as NodeJS.Platform,
    });
    expect(creds.accessToken).toBe('env-wins-token');
    expect(creds.sourcePath).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('falls through to the macOS Keychain when no env token and the file is absent/empty', () => {
    const creds = loadLegacyClaudeOAuth({
      path: join(fixturesDir, 'does-not-exist.json'),
      env: {},
      platform: 'darwin' as NodeJS.Platform,
      readKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token-xyz' } }),
    });
    expect(creds.accessToken).toBe('keychain-token-xyz');
    expect(creds.sourcePath).toContain('Keychain');
  });

  it('throws ClaudeOAuthMissingError when no source yields a token', () => {
    expect(() =>
      loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'does-not-exist.json'),
        env: {},
        platform: 'darwin' as NodeJS.Platform,
        readKeychain: () => undefined,
      }),
    ).toThrow(ClaudeOAuthMissingError);
  });

  it('throws ClaudeOAuthMissingError on a non-darwin host with no env token and no file', () => {
    expect(() =>
      loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'does-not-exist.json'),
        env: {},
        platform: 'linux' as NodeJS.Platform,
      }),
    ).toThrow(ClaudeOAuthMissingError);
  });

  it('throws ClaudeOAuthMalformedError on invalid JSON in the file', () => {
    expect(() => fileOnly(join(fixturesDir, 'claude-broken.txt'))).toThrow(
      ClaudeOAuthMalformedError,
    );
  });

  it('throws ClaudeOAuthMalformedError when claudeAiOauth.accessToken is absent', () => {
    expect(() => fileOnly(join(fixturesDir, 'claude-malformed.json'))).toThrow(
      ClaudeOAuthMalformedError,
    );
  });

  it('throws ClaudeOAuthMalformedError when the top-level JSON value is not an object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-not-object-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify(42));
    expect(() => fileOnly(file)).toThrow(ClaudeOAuthMalformedError);
    expect(() => fileOnly(file)).toThrow(/top-level value is not an object/);
  });

  it('throws ClaudeOAuthMalformedError when claudeAiOauth is present but accessToken is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-no-token-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { scopes: ['x'] } }));
    expect(() => fileOnly(file)).toThrow(/claudeAiOauth.accessToken/);
  });

  it('throws ClaudeOAuthMalformedError when claudeAiOauth.accessToken is an empty string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-empty-token-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: '' } }));
    expect(() => fileOnly(file)).toThrow(/claudeAiOauth.accessToken/);
  });

  it('throws ClaudeOAuthMalformedError when the credentials file cannot be read (e.g. a directory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-isdir-'));
    const fakeFile = join(dir, 'not-a-file.json');
    mkdirSync(fakeFile); // exists per existsSync, but readFileSync on a dir throws EISDIR
    expect(() => fileOnly(fakeFile)).toThrow(ClaudeOAuthMalformedError);
    expect(() => fileOnly(fakeFile)).toThrow(/read failed/);
  });

  describe('account email (~/.claude.json oauthAccount.emailAddress)', () => {
    it('is included when present and well-formed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oauth-email-'));
      const configPath = join(dir, '.claude.json');
      writeFileSync(
        configPath,
        JSON.stringify({ oauthAccount: { emailAddress: 'tom@example.com' } }),
      );
      const creds = loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'claude-good.json'),
        env: { CLAUDE_CONFIG_PATH: configPath },
        platform: 'linux' as NodeJS.Platform,
      });
      expect(creds.email).toBe('tom@example.com');
    });

    it('is undefined (not an error) when ~/.claude.json is malformed JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oauth-email-bad-'));
      const configPath = join(dir, '.claude.json');
      writeFileSync(configPath, '{ not json');
      const creds = loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'claude-good.json'),
        env: { CLAUDE_CONFIG_PATH: configPath },
        platform: 'linux' as NodeJS.Platform,
      });
      expect(creds.email).toBeUndefined();
      expect(creds.accessToken).toBe('test-oauth-token-abc123');
    });

    it('is undefined when the top-level value is not an object', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oauth-email-nonobj-'));
      const configPath = join(dir, '.claude.json');
      writeFileSync(configPath, JSON.stringify('just a string'));
      const creds = loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'claude-good.json'),
        env: { CLAUDE_CONFIG_PATH: configPath },
        platform: 'linux' as NodeJS.Platform,
      });
      expect(creds.email).toBeUndefined();
    });

    it('is undefined when oauthAccount is missing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oauth-email-noaccount-'));
      const configPath = join(dir, '.claude.json');
      writeFileSync(configPath, JSON.stringify({}));
      const creds = loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'claude-good.json'),
        env: { CLAUDE_CONFIG_PATH: configPath },
        platform: 'linux' as NodeJS.Platform,
      });
      expect(creds.email).toBeUndefined();
    });

    it('is undefined when emailAddress is missing or empty', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oauth-email-noaddr-'));
      const configPath = join(dir, '.claude.json');
      writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: '' } }));
      const creds = loadLegacyClaudeOAuth({
        path: join(fixturesDir, 'claude-good.json'),
        env: { CLAUDE_CONFIG_PATH: configPath },
        platform: 'linux' as NodeJS.Platform,
      });
      expect(creds.email).toBeUndefined();
    });
  });

  it('includes the account email alongside an env-sourced access token when ~/.claude.json resolves one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-env-email-'));
    const configPath = join(dir, '.claude.json');
    writeFileSync(
      configPath,
      JSON.stringify({ oauthAccount: { emailAddress: 'tom@example.com' } }),
    );
    const creds = loadLegacyClaudeOAuth({
      path: join(fixturesDir, 'claude-good.json'),
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token', CLAUDE_CONFIG_PATH: configPath },
      platform: 'linux' as NodeJS.Platform,
    });
    expect(creds.accessToken).toBe('env-token');
    expect(creds.email).toBe('tom@example.com');
    expect(creds.sourceKind).toBe('env');
  });

  it('honours CLAUDE_CREDENTIALS_PATH env when no explicit path given', () => {
    const expected = join(fixturesDir, 'claude-good.json');
    const path = resolveClaudeConfigPath({ env: { CLAUDE_CREDENTIALS_PATH: expected } });
    expect(path).toBe(expected);
  });

  it('defaults the credentials path to ~/.claude/.credentials.json when env is unset', () => {
    const path = resolveClaudeConfigPath({ env: {} });
    expect(path.endsWith(join('.claude', '.credentials.json'))).toBe(true);
  });

  it('surfaces refreshToken + expiresAt + sourceKind from a file source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-blob-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'acc-1',
          refreshToken: 'ref-1',
          expiresAt: 9_999_999_999_000,
          scopes: ['x'],
        },
      }),
    );
    const cred = loadLegacyClaudeOAuth({
      path: file,
      env: {},
      platform: 'linux' as NodeJS.Platform,
    });
    expect(cred.accessToken).toBe('acc-1');
    expect(cred.refreshToken).toBe('ref-1');
    expect(cred.expiresAt).toBe(9_999_999_999_000);
    expect(cred.sourceKind).toBe('file');
    expect(cred.filePath).toBe(file);
  });
});

// spec/10-auth.md Settings "disconnect" — clearClaudeOAuth must REMOVE the
// resolvable credential so the host genuinely goes unauthenticated.
describe('clearClaudeOAuth (Settings disconnect)', () => {
  it('removes the credentials file so loadClaudeOAuth then throws missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-clear-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'tkn', scopes: [] } }));
    // Authenticated before.
    expect(loadLegacyClaudeOAuth({ path: file, env: {}, platform: 'linux' }).accessToken).toBe(
      'tkn',
    );

    const res = clearClaudeOAuth({ path: file, env: {}, platform: 'linux' });
    expect(res.fileRemoved).toBe(true);
    expect(existsSync(file)).toBe(false);
    // Unauthenticated after (no env token, no file, non-darwin so no Keychain).
    expect(() => loadLegacyClaudeOAuth({ path: file, env: {}, platform: 'linux' })).toThrow(
      ClaudeOAuthMissingError,
    );
  });

  it('deletes the macOS Keychain item when no file override is present', () => {
    let deleted = 0;
    const res = clearClaudeOAuth({
      env: {},
      platform: 'darwin',
      deleteKeychain: () => {
        deleted += 1;
        return true;
      },
    });
    expect(deleted).toBe(1);
    expect(res.keychainRemoved).toBe(true);
  });

  it('with CLAUDE_OAUTH_NO_KEYCHAIN the loader never falls through to the Keychain, so clearing flips to missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-clear-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'tkn', scopes: [] } }));
    const env = { CLAUDE_CREDENTIALS_PATH: file, CLAUDE_OAUTH_NO_KEYCHAIN: '1' };
    // Authenticated from the file even on darwin.
    expect(loadLegacyClaudeOAuth({ env, platform: 'darwin' }).accessToken).toBe('tkn');
    // Clear: file removed, Keychain NOT touched (opt-out).
    const res = clearClaudeOAuth({ env, platform: 'darwin' });
    expect(res.fileRemoved).toBe(true);
    expect(res.keychainRemoved).toBe(false);
    // Now genuinely unauthenticated — the host Keychain is NOT consulted.
    expect(() => loadLegacyClaudeOAuth({ env, platform: 'darwin' })).toThrow(
      ClaudeOAuthMissingError,
    );
  });

  it('does NOT touch the Keychain when a credentials-file override is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-clear-'));
    let deleted = 0;
    // With an explicit path override we are pointed at a sandbox file, not the
    // host Keychain — the default deleter must not run. (The hook still lets a
    // test exercise the branch, but it should not be auto-invoked.)
    const res = clearClaudeOAuth({
      path: join(dir, 'absent.json'),
      env: {},
      platform: 'darwin',
    });
    // No deleteKeychain hook + override present → keychainRemoved stays false
    // and the (unset) default deleter was never reached for the host store.
    expect(deleted).toBe(0);
    expect(res.keychainRemoved).toBe(false);
  });

  it('still exercises an injected deleteKeychain test hook even when the auto-condition would skip it', () => {
    // plat !== 'darwin' means the auto-invoke condition is false, but a test
    // wants to exercise the Keychain-delete branch anyway via the hook.
    let deleted = 0;
    const res = clearClaudeOAuth({
      env: {},
      platform: 'linux',
      deleteKeychain: () => {
        deleted += 1;
        return true;
      },
    });
    expect(deleted).toBe(1);
    expect(res.keychainRemoved).toBe(true);
  });
});

// KNOWN HOST DEFECT regression: the host must self-refresh an expired OAuth
// access token (using the stored refresh token) instead of 401-ing every query.
describe('Claude OAuth self-refresh (host token-expiry fix)', () => {
  it('isClaudeOAuthStale flags a credential at/within the skew of expiry', () => {
    const now = 1_000_000;
    expect(isClaudeOAuthStale({ expiresAt: now + 5 * 60_000 }, now)).toBe(false);
    expect(isClaudeOAuthStale({ expiresAt: now + 1_000 }, now)).toBe(true); // within 60s skew
    expect(isClaudeOAuthStale({ expiresAt: now - 1 }, now)).toBe(true); // already expired
    expect(isClaudeOAuthStale({}, now)).toBe(false); // env override (no expiry)
  });

  it('refreshClaudeOAuth POSTs the refresh grant and returns the rotated triple', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      captured = { url, body: JSON.parse(init!.body!) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'acc-2',
          refresh_token: 'ref-2',
          expires_in: 3600,
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const rotated = await refreshClaudeOAuth('ref-1', {
      fetchImpl: fakeFetch,
      tokenUrl: 'https://example.test/token',
      clientId: 'cid',
    });
    expect(rotated.accessToken).toBe('acc-2');
    expect(rotated.refreshToken).toBe('ref-2');
    expect(rotated.expiresAt).toBeGreaterThan(Date.now());
    expect(captured!.url).toBe('https://example.test/token');
    expect(captured!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ref-1',
      client_id: 'cid',
    });
  });

  it('refreshClaudeOAuth throws (NO fallback) on a non-2xx response', async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(refreshClaudeOAuth('bad', { fetchImpl: fakeFetch })).rejects.toThrow(/401/);
  });

  it('refreshClaudeOAuth throws when the response omits access_token', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ refresh_token: 'ref-2', expires_in: 3600 }),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(refreshClaudeOAuth('ref-1', { fetchImpl: fakeFetch })).rejects.toThrow(
      /response missing access_token/,
    );
  });

  it('refreshClaudeOAuth keeps the OLD refresh token when the response omits one (stable-refresh-token IdPs)', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'acc-2' }), // no refresh_token, no expires_in
      }) as unknown as Response) as unknown as typeof fetch;
    const rotated = await refreshClaudeOAuth('ref-1-stable', { fetchImpl: fakeFetch });
    expect(rotated.accessToken).toBe('acc-2');
    expect(rotated.refreshToken).toBe('ref-1-stable');
    // expires_in also defaulted (to 3600s) when absent.
    expect(rotated.expiresAt).toBeGreaterThan(Date.now());
    expect(rotated.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 1000);
  });

  it('persistClaudeOAuth writes the rotated triple back to the FILE source, preserving other fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-persist-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old',
          refreshToken: 'old-ref',
          expiresAt: 1,
          scopes: ['keep-me'],
          subscriptionType: 'pro',
        },
      }),
    );
    const cred: ClaudeOAuthCredentials = {
      accessToken: 'old',
      refreshToken: 'old-ref',
      expiresAt: 1,
      sourcePath: file,
      sourceKind: 'file',
      filePath: file,
    };
    persistClaudeOAuth(cred, { accessToken: 'new', refreshToken: 'new-ref', expiresAt: 12345 });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.claudeAiOauth.accessToken).toBe('new');
    expect(written.claudeAiOauth.refreshToken).toBe('new-ref');
    expect(written.claudeAiOauth.expiresAt).toBe(12345);
    expect(written.claudeAiOauth.scopes).toEqual(['keep-me']); // preserved
    expect(written.claudeAiOauth.subscriptionType).toBe('pro'); // preserved
  });

  it('persistClaudeOAuth overwrites a CORRUPT existing blob rather than failing (refreshed credential wins)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-persist-corrupt-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, '{ not valid json at all');
    const cred: ClaudeOAuthCredentials = {
      accessToken: 'old',
      sourcePath: file,
      sourceKind: 'file',
      filePath: file,
    };
    persistClaudeOAuth(cred, { accessToken: 'new', refreshToken: 'new-ref', expiresAt: 555 });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.claudeAiOauth.accessToken).toBe('new');
    expect(written.claudeAiOauth.refreshToken).toBe('new-ref');
    expect(written.claudeAiOauth.expiresAt).toBe(555);
  });

  it('persistClaudeOAuth starts a fresh claudeAiOauth blob when the existing file lacks one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-persist-noblob-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ someOtherKey: true })); // valid JSON, no claudeAiOauth
    const cred: ClaudeOAuthCredentials = {
      accessToken: 'old',
      sourcePath: file,
      sourceKind: 'file',
      filePath: file,
    };
    persistClaudeOAuth(cred, { accessToken: 'new', refreshToken: 'new-ref', expiresAt: 777 });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.someOtherKey).toBe(true); // sibling keys preserved
    expect(written.claudeAiOauth.accessToken).toBe('new');
    expect(written.claudeAiOauth.refreshToken).toBe('new-ref');
    expect(written.claudeAiOauth.expiresAt).toBe(777);
  });

  it('persistClaudeOAuth routes a keychain source through the injected writer (merges into existing blob)', () => {
    let written: string | undefined;
    const cred: ClaudeOAuthCredentials = {
      accessToken: 'old',
      refreshToken: 'old-ref',
      expiresAt: 1,
      sourcePath: 'macOS Keychain (Claude Code-credentials)',
      sourceKind: 'keychain',
    };
    persistClaudeOAuth(
      cred,
      { accessToken: 'new', refreshToken: 'new-ref', expiresAt: 999 },
      {
        readKeychain: () =>
          JSON.stringify({ claudeAiOauth: { accessToken: 'old', scopes: ['s'] } }),
        writeKeychain: (s) => {
          written = s;
        },
      },
    );
    const parsed = JSON.parse(written!);
    expect(parsed.claudeAiOauth.accessToken).toBe('new');
    expect(parsed.claudeAiOauth.refreshToken).toBe('new-ref');
    expect(parsed.claudeAiOauth.expiresAt).toBe(999);
    expect(parsed.claudeAiOauth.scopes).toEqual(['s']); // merged, preserved
  });

  it('persistClaudeOAuth is a no-op for the env source (no blob to write)', () => {
    const cred: ClaudeOAuthCredentials = {
      accessToken: 'x',
      sourcePath: 'CLAUDE_CODE_OAUTH_TOKEN',
      sourceKind: 'env',
    };
    // Must not throw even with no writer/path.
    expect(() =>
      persistClaudeOAuth(cred, { accessToken: 'y', refreshToken: 'z', expiresAt: 1 }),
    ).not.toThrow();
  });

  it('persistClaudeOAuth throws if a file-source credential has no filePath (type-inconsistent input)', () => {
    // The type says filePath is required for sourceKind 'file', but nothing
    // stops a caller from constructing an inconsistent object — this guard
    // fails loudly rather than writing to an undefined path.
    const cred = {
      accessToken: 'x',
      sourcePath: 'somewhere',
      sourceKind: 'file',
    } as ClaudeOAuthCredentials;
    expect(() =>
      persistClaudeOAuth(cred, { accessToken: 'y', refreshToken: 'z', expiresAt: 1 }),
    ).toThrow(/file source has no filePath/);
  });

  it('refreshClaudeOAuth falls back to the global fetch when fetchImpl is omitted', async () => {
    const stub = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'acc-stub', refresh_token: 'ref-stub', expires_in: 60 }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', stub);
    try {
      const rotated = await refreshClaudeOAuth('ref-in', {
        tokenUrl: 'https://example.test/token',
      });
      expect(rotated.accessToken).toBe('acc-stub');
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Keychain-sourced credential carries the full blob (branches only reachable via the Keychain path)', () => {
  it('carries refreshToken/expiresAt/email when the Keychain blob + account file both have them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-kc-full-'));
    const configPath = join(dir, '.claude.json');
    writeFileSync(
      configPath,
      JSON.stringify({ oauthAccount: { emailAddress: 'tom@example.com' } }),
    );
    const creds = loadLegacyClaudeOAuth({
      path: join(dir, 'does-not-exist.json'),
      env: { CLAUDE_CONFIG_PATH: configPath },
      platform: 'darwin' as NodeJS.Platform,
      readKeychain: () =>
        JSON.stringify({
          claudeAiOauth: { accessToken: 'kc-tok', refreshToken: 'kc-ref', expiresAt: 123456 },
        }),
    });
    expect(creds.accessToken).toBe('kc-tok');
    expect(creds.refreshToken).toBe('kc-ref');
    expect(creds.expiresAt).toBe(123456);
    expect(creds.email).toBe('tom@example.com');
    expect(creds.sourceKind).toBe('keychain');
  });
});

// These exercise the `opts.env ?? process.env` / `opts.platform ?? platform()`
// fallback branches, which every other test in this file deliberately avoids
// by always passing explicit env/platform. We stash + restore any real-world
// values of the env vars these functions read, so the test can't leak state
// into (or be polluted by) the actual host environment. Platform fallback
// tests either pin `platform: 'linux'` or set `noKeychain: true` so the real
// macOS host's Keychain is never consulted even when `platform()` resolves
// to the genuine 'darwin'.
describe('process.env / real os.platform() fallbacks (opts.env / opts.platform omitted)', () => {
  const ENV_KEYS = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CREDENTIALS_PATH',
    'CLAUDE_OAUTH_NO_KEYCHAIN',
    'CLAUDE_CONFIG_PATH',
  ] as const;

  function withClearedEnv<T>(fn: () => T): T {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      return fn();
    } finally {
      for (const k of ENV_KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('resolveClaudeConfigPath falls back to process.env when opts.env is omitted', () => {
    withClearedEnv(() => {
      const path = resolveClaudeConfigPath({});
      expect(path.endsWith(join('.claude', '.credentials.json'))).toBe(true);
    });
  });

  it('loadClaudeOAuth falls back to process.env when opts.env is omitted (platform pinned to skip Keychain)', () => {
    withClearedEnv(() => {
      expect(() =>
        loadLegacyClaudeOAuth({
          path: '/definitely/not/a/real/path.json',
          platform: 'linux' as NodeJS.Platform,
        }),
      ).toThrow(ClaudeOAuthMissingError);
    });
  });

  it('loadClaudeOAuth falls back to the real os.platform() when opts.platform is omitted (Keychain opted out)', () => {
    // noKeychain: true also exercises keychainDisabled's `opts.noKeychain`
    // branch directly (every other test opts out via the env-var form).
    expect(() =>
      loadLegacyClaudeOAuth({
        path: '/definitely/not/a/real/path.json',
        env: {},
        noKeychain: true,
      }),
    ).toThrow(ClaudeOAuthMissingError);
  });

  it('clearClaudeOAuth falls back to process.env when opts.env is omitted (platform pinned to skip Keychain)', () => {
    withClearedEnv(() => {
      const res = clearClaudeOAuth({
        path: '/definitely/not/a/real/path.json',
        platform: 'linux' as NodeJS.Platform,
      });
      expect(res.fileRemoved).toBe(false);
      expect(res.keychainRemoved).toBe(false);
    });
  });

  it('clearClaudeOAuth falls back to the real os.platform() when opts.platform is omitted (Keychain opted out)', () => {
    const res = clearClaudeOAuth({
      path: '/definitely/not/a/real/path.json',
      env: {},
      noKeychain: true,
    });
    expect(res.fileRemoved).toBe(false);
    expect(res.keychainRemoved).toBe(false);
  });

  it('clearClaudeOAuth reads CLAUDE_CREDENTIALS_PATH via process.env when BOTH opts.path and opts.env are omitted', () => {
    // Forces the hasFileOverride computation's `opts.env ?? process.env`
    // fallback to actually read process.env (every other override test
    // passes opts.env explicitly). We point the real env var at a sandbox
    // file so nothing near the host's real ~/.claude/.credentials.json is
    // ever touched, and the resulting hasFileOverride=true means the
    // Keychain auto-delete path is skipped regardless of platform.
    const dir = mkdtempSync(join(tmpdir(), 'oauth-clear-envfallback-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'tkn' } }));
    const saved = {
      CLAUDE_CREDENTIALS_PATH: process.env['CLAUDE_CREDENTIALS_PATH'],
      CLAUDE_OAUTH_NO_KEYCHAIN: process.env['CLAUDE_OAUTH_NO_KEYCHAIN'],
      CLAUDE_CODE_OAUTH_TOKEN: process.env['CLAUDE_CODE_OAUTH_TOKEN'],
    };
    process.env['CLAUDE_CREDENTIALS_PATH'] = file;
    delete process.env['CLAUDE_OAUTH_NO_KEYCHAIN'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    try {
      const res = clearClaudeOAuth({ platform: 'darwin' as NodeJS.Platform });
      expect(res.fileRemoved).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(res.keychainRemoved).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── validateClaudeOAuthToken ─────────────────────────────────────────────────
// These NEVER reach the real Anthropic API. Every test supplies a `fetchImpl`
// stub so the real `fetch` is never touched.

describe('validateClaudeOAuthToken', () => {
  it('returns valid when the endpoint answers 200', async () => {
    const fetchStub = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const result = await validateClaudeOAuthToken('good-token', { fetchImpl: fetchStub });
    expect(result).toEqual({ kind: 'valid' });
  });

  it('sends the right headers: Bearer, anthropic-version, anthropic-beta', async () => {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    await validateClaudeOAuthToken('tok-abc', { fetchImpl: fetchStub });
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-abc');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(headers['anthropic-beta']).toBe(ANTHROPIC_OAUTH_BETA);
  });

  it('returns rejected (kind: rejected) for HTTP 401', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response('{"error":{"type":"authentication_error","message":"invalid_bearer_token"}}', {
          status: 401,
        }),
    );
    const result = await validateClaudeOAuthToken('bad-tok', { fetchImpl: fetchStub });
    expect(result.kind).toBe('rejected');
    // Message must name the status code.
    expect((result as { kind: string; message: string }).message).toMatch(/401/);
  });

  it('returns rejected (kind: rejected) for HTTP 403', async () => {
    const fetchStub = vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 }));
    const result = await validateClaudeOAuthToken('bad-tok', { fetchImpl: fetchStub });
    expect(result.kind).toBe('rejected');
    expect((result as { kind: string; message: string }).message).toMatch(/403/);
  });

  it('returns unreachable for a network throw (not a 401/403)', async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await validateClaudeOAuthToken('any-tok', { fetchImpl: fetchStub });
    expect(result.kind).toBe('unreachable');
    expect((result as { kind: string; message: string }).message).toMatch(/ECONNREFUSED/);
  });

  it('returns unreachable for an unexpected HTTP status (500)', async () => {
    const fetchStub = vi.fn(async () => new Response('Internal error', { status: 500 }));
    const result = await validateClaudeOAuthToken('any-tok', { fetchImpl: fetchStub });
    expect(result.kind).toBe('unreachable');
    expect((result as { kind: string; message: string }).message).toMatch(/500/);
  });

  it('uses the url override when supplied (tests can point at a local server)', async () => {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    const customUrl = 'http://localhost:9999/v1/models?limit=1';
    await validateClaudeOAuthToken('tok', { fetchImpl: fetchStub, url: customUrl });
    expect(fetchStub.mock.calls[0]?.[0]).toBe(customUrl);
  });

  it('does NOT treat unreachable as valid — kind stays unreachable, never valid', async () => {
    // Explicitly enforces the spec: "storing a token nobody has confirmed is
    // how a bad one comes to be discovered by a failing chat later".
    const fetchStub = vi.fn(async () => new Response('', { status: 503 }));
    const result = await validateClaudeOAuthToken('tok', { fetchImpl: fetchStub });
    expect(result.kind).not.toBe('valid');
    expect(result.kind).toBe('unreachable');
  });
});
