// Covers the DEFAULT macOS Keychain read/write/delete implementations
// (readKeychainDefault / writeKeychainDefault / deleteKeychainDefault) inside
// claude-oauth.ts — the ones used when a caller does NOT inject a
// readKeychain/writeKeychain/deleteKeychain test hook.
//
// SAFETY: every other test in this package deliberately injects those hooks
// specifically so it never has to shell out to the real `security` CLI —
// which, on a real macOS host (this is a Mac), would read/mutate/DELETE the
// actual `Claude Code-credentials` Keychain item the real `claude` CLI
// depends on. To exercise the default implementations' own logic (trimming,
// empty-string handling, the exit-44 "not found" catch) WITHOUT ever touching
// the live Keychain, we mock `node:child_process`'s `execFileSync` at the
// module level — the real `security` binary is never invoked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadLegacyClaudeOAuth, clearClaudeOAuth, persistClaudeOAuth } from '../src/index.js';

// NOTE: these exercise the LEGACY seed chain (env → credentials file → Keychain),
// so they call loadLegacyClaudeOAuth directly. loadClaudeOAuth now consults patch's
// own store first, and reading the real ~/.patch/claude-oauth.json from a unit test
// would make results depend on whether the dev machine happens to have a host
// store — see claude-oauth-store.test.ts for the store's own coverage.

// vi.mock() is hoisted above all imports by Vitest's compiler, so the mock
// factory can't close over a plain top-level `const` (TDZ). vi.hoisted()
// runs before that hoisting, giving the factory a safe reference.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

describe('Claude OAuth default macOS Keychain implementations (execFileSync mocked)', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('readKeychainDefault trims the security output and uses it as the secret', () => {
    execFileSyncMock.mockReturnValue('  {"claudeAiOauth":{"accessToken":"kc-token"}}  \n');
    const creds = loadLegacyClaudeOAuth({
      path: '/nonexistent/does-not-exist.json',
      env: {},
      platform: 'darwin' as NodeJS.Platform,
    });
    expect(creds.accessToken).toBe('kc-token');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('readKeychainDefault treats a whitespace-only result as absent (falls through to Missing)', () => {
    execFileSyncMock.mockReturnValue('   \n');
    expect(() =>
      loadLegacyClaudeOAuth({
        path: '/nonexistent/does-not-exist.json',
        env: {},
        platform: 'darwin' as NodeJS.Platform,
      }),
    ).toThrow(/not found/);
  });

  it('readKeychainDefault swallows a thrown error (item not in Keychain, exit 44) and reports absent', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('security: exit 44 — item not found');
    });
    expect(() =>
      loadLegacyClaudeOAuth({
        path: '/nonexistent/does-not-exist.json',
        env: {},
        platform: 'darwin' as NodeJS.Platform,
      }),
    ).toThrow(/not found/);
  });

  it('writeKeychainDefault invokes the upsert add-generic-password with the secret', () => {
    execFileSyncMock.mockReturnValue(''); // read-back not used in this path
    persistClaudeOAuth(
      {
        accessToken: 'old',
        sourcePath: 'macOS Keychain (Claude Code-credentials)',
        sourceKind: 'keychain',
      },
      { accessToken: 'new', refreshToken: 'new-ref', expiresAt: 123 },
    );
    const writeCall = execFileSyncMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === 'add-generic-password',
    );
    expect(writeCall).toBeDefined();
    expect(writeCall![1]).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      'Claude Code-credentials',
      '-a',
      'Claude Code-credentials',
      '-w',
      expect.stringContaining('"accessToken":"new"'),
    ]);
  });

  it('deleteKeychainDefault runs delete-generic-password and reports removed on success', () => {
    execFileSyncMock.mockReturnValue('');
    const res = clearClaudeOAuth({ env: {}, platform: 'darwin' as NodeJS.Platform });
    expect(res.keychainRemoved).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'security',
      ['delete-generic-password', '-s', 'Claude Code-credentials'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'ignore'] }),
    );
  });

  it('deleteKeychainDefault swallows a thrown error (item absent, exit 44) and reports not removed', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('security: exit 44 — item not found');
    });
    const res = clearClaudeOAuth({ env: {}, platform: 'darwin' as NodeJS.Platform });
    expect(res.keychainRemoved).toBe(false);
  });
});
