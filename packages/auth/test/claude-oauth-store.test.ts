// Patch's own credential store.
//
// Before this existed, patch read the credential from wherever Claude Code left
// it. On a container deployment that was `CLAUDE_CODE_OAUTH_TOKEN` — resolution
// step 1, unchangeable by a running process — so Settings' "disconnect" deleted
// files that didn't matter and the host reported itself connected a moment
// later. These tests pin the two rules that fix it: the store wins once it
// exists, and an EMPTY store is a decision, not an invitation to re-seed.
//
// The store now holds a LIST of named accounts (spec/10-auth.md § Backend
// credentials — multiple accounts), not one flat credential. Disconnect empties
// one account's credential (never removes the account, never deletes the
// store); connect replaces one account's credential; addPatchStoreAccount always
// creates a brand-new slot.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeOAuthMissingError,
  ClaudeOAuthMalformedError,
  addPatchStoreAccount,
  connectPatchStore,
  disconnectPatchStore,
  listPatchStoreAccounts,
  loadClaudeOAuth,
  readPatchStore,
  resolvePatchStorePath,
  seedPatchStore,
  writePatchStore,
  DEFAULT_ACCOUNT_ID,
} from '../src/index.js';

let dir: string;
let storePath: string;
/** Opts that keep every test off the real ~/.patch and ~/.claude. */
const opts = (): { storePath: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform } => ({
  storePath,
  // Isolate from the real ~/.claude.json — otherwise loadAccountEmail() leaks
  // whatever account is actually logged in on this machine into assertions.
  env: { CLAUDE_CONFIG_PATH: join(dir, 'no-such-claude.json') },
  platform: 'linux' as NodeJS.Platform,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-store-'));
  storePath = join(dir, 'claude-oauth.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolvePatchStorePath', () => {
  it('prefers an explicit path, then env, then ~/.patch', () => {
    expect(resolvePatchStorePath({ storePath: '/x/y.json' })).toBe('/x/y.json');
    expect(resolvePatchStorePath({ env: { PATCH_CLAUDE_STORE_PATH: '/e/s.json' } })).toBe(
      '/e/s.json',
    );
    expect(resolvePatchStorePath({ env: {} })).toMatch(/\.patch\/claude-oauth\.json$/);
  });
});

describe('readPatchStore', () => {
  it('distinguishes an ABSENT store from an EMPTY one', () => {
    // The whole disconnect mechanism rests on this distinction: absent means
    // "seed me", empty means "the user said no".
    expect(readPatchStore(opts())).toBeNull();
    writePatchStore({ accounts: [], activeAccountId: null }, opts());
    expect(readPatchStore(opts())).toEqual({ accounts: [], activeAccountId: null });
  });

  it('round-trips a full credential', () => {
    connectPatchStore(
      { accessToken: 'tok', refreshToken: 'ref', expiresAt: 123, email: 'a@b.c' },
      opts(),
    );
    const store = readPatchStore(opts());
    expect(store?.accounts).toEqual([
      {
        id: DEFAULT_ACCOUNT_ID,
        label: 'Default',
        credential: { accessToken: 'tok', refreshToken: 'ref', expiresAt: 123, email: 'a@b.c' },
      },
    ]);
    expect(store?.activeAccountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('treats an empty file as an empty store, not corruption', () => {
    writeFileSync(storePath, '   ');
    expect(readPatchStore(opts())).toEqual({ accounts: [], activeAccountId: null });
  });

  it('throws on corrupt content rather than silently reconnecting', () => {
    // Falling back to the legacy chain here would resurrect the env token the
    // user disconnected from.
    writeFileSync(storePath, 'not json{');
    expect(() => readPatchStore(opts())).toThrow(ClaudeOAuthMalformedError);
    writeFileSync(storePath, JSON.stringify({ credential: { refreshToken: 'r' } }));
    expect(() => readPatchStore(opts())).toThrow(/accessToken missing/);
    writeFileSync(storePath, JSON.stringify({ credential: 'nope' }));
    expect(() => readPatchStore(opts())).toThrow(/not an object/);
    writeFileSync(storePath, JSON.stringify(['a']));
    expect(() => readPatchStore(opts())).toThrow(ClaudeOAuthMalformedError);
    writeFileSync(storePath, JSON.stringify({ accounts: 'nope' }));
    expect(() => readPatchStore(opts())).toThrow(/accounts is not an array/);
    writeFileSync(storePath, JSON.stringify({ accounts: [{ label: 'x', credential: null }] }));
    expect(() => readPatchStore(opts())).toThrow(/\.id missing/);
    writeFileSync(storePath, JSON.stringify({ accounts: [{ id: 'a', credential: null }] }));
    expect(() => readPatchStore(opts())).toThrow(/\.label missing/);
  });

  it('migrates a legacy single-credential store transparently on read', () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        credential: { accessToken: 'legacy-tok', email: 'legacy@example.com' },
        seededFrom: 'CLAUDE_CODE_OAUTH_TOKEN',
      }),
    );
    const store = readPatchStore(opts());
    expect(store?.accounts).toEqual([
      {
        id: DEFAULT_ACCOUNT_ID,
        label: 'Default',
        credential: { accessToken: 'legacy-tok', email: 'legacy@example.com' },
      },
    ]);
    expect(store?.activeAccountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(store?.seededFrom).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('migrates a legacy DISCONNECTED store (credential: null) to an empty account list', () => {
    writeFileSync(storePath, JSON.stringify({ credential: null }));
    expect(readPatchStore(opts())).toEqual({ accounts: [], activeAccountId: null });
  });
});

describe('writePatchStore', () => {
  it('writes 0600 and creates the directory', () => {
    const nested = join(dir, 'deep', 'claude-oauth.json');
    writePatchStore(
      {
        accounts: [{ id: 'x', label: 'X', credential: { accessToken: 't' } }],
        activeAccountId: 'x',
      },
      { storePath: nested, env: {} },
    );
    expect(existsSync(nested)).toBe(true);
    // Same permissions as the host key that lives beside it.
    expect(statSync(nested).mode & 0o777).toBe(0o600);
  });
});

describe('loadClaudeOAuth with a store', () => {
  it('uses the store when it holds a credential', () => {
    connectPatchStore({ accessToken: 'from-store' }, opts());
    const cred = loadClaudeOAuth(opts());
    expect(cred.accessToken).toBe('from-store');
    expect(cred.sourceKind).toBe('store');
    expect(cred.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('reports MISSING when the store is empty, even with an env token present', () => {
    // The exact production bug: disconnect appeared to work, then the env var
    // reconnected the host on the next read.
    disconnectPatchStore(opts());
    expect(() =>
      loadClaudeOAuth({ storePath, env: { CLAUDE_CODE_OAUTH_TOKEN: 'still-here' } }),
    ).toThrow(ClaudeOAuthMissingError);
  });

  it('beats an env token when the store holds one', () => {
    connectPatchStore({ accessToken: 'store-wins' }, opts());
    expect(
      loadClaudeOAuth({ storePath, env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-loses' } }).accessToken,
    ).toBe('store-wins');
  });

  it('falls back to the legacy chain only while the store is absent', () => {
    const cred = loadClaudeOAuth({ storePath, env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' } });
    expect(cred.accessToken).toBe('env-tok');
    expect(cred.sourceKind).toBe('env');
  });

  it('resolves a specific accountId when asked, ignoring the active one', () => {
    connectPatchStore({ accessToken: 'first' }, opts());
    const second = addPatchStoreAccount({ accessToken: 'second' }, opts(), 'Second');
    // Active is still the first account (adding never reassigns it).
    expect(loadClaudeOAuth(opts()).accessToken).toBe('first');
    expect(loadClaudeOAuth({ ...opts(), accountId: second.id }).accessToken).toBe('second');
  });

  it('throws MISSING when asked for an accountId the store does not have', () => {
    connectPatchStore({ accessToken: 'first' }, opts());
    expect(() => loadClaudeOAuth({ ...opts(), accountId: 'nope' })).toThrow(
      ClaudeOAuthMissingError,
    );
  });
});

describe('seedPatchStore', () => {
  it('seeds from the env token on a first boot and records the source', () => {
    const seeded = seedPatchStore({
      storePath,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'seed-me', CLAUDE_CONFIG_PATH: join(dir, 'no-such.json') },
    });
    expect(seeded?.accessToken).toBe('seed-me');
    const store = readPatchStore(opts());
    expect(store?.seededFrom).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(store?.accounts).toEqual([
      { id: DEFAULT_ACCOUNT_ID, label: 'Default', credential: { accessToken: 'seed-me' } },
    ]);
    expect(store?.activeAccountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('seeds from a credentials file, carrying the refresh token', () => {
    const credFile = join(dir, 'creds.json');
    writeFileSync(
      credFile,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 999 },
      }),
    );
    const seeded = seedPatchStore({ storePath, path: credFile, env: {}, platform: 'linux' });
    expect(seeded).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresAt: 999 });
  });

  it('NEVER re-seeds over an emptied store', () => {
    // This is what makes disconnect survive a container recreate, where the env
    // var is still present on the next boot.
    disconnectPatchStore(opts());
    expect(seedPatchStore({ storePath, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sneaky' } })).toBeNull();
    expect(readPatchStore(opts())).toEqual({ accounts: [], activeAccountId: null });
  });

  it('never overwrites a store that already holds a credential', () => {
    connectPatchStore({ accessToken: 'mine' }, opts());
    expect(seedPatchStore({ storePath, env: { CLAUDE_CODE_OAUTH_TOKEN: 'theirs' } })).toBeNull();
    expect(
      readPatchStore(opts())?.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID)?.credential
        ?.accessToken,
    ).toBe('mine');
  });

  it('leaves the store ABSENT when there is nothing to seed', () => {
    // So a later `claude login` on the host can still be picked up. Writing an
    // empty store here would wrongly look like a deliberate disconnect.
    expect(seedPatchStore(opts())).toBeNull();
    expect(existsSync(storePath)).toBe(false);
  });
});

describe('disconnect / connect round trip', () => {
  it('disconnect empties the active account and never deletes the store', () => {
    connectPatchStore({ accessToken: 't' }, opts());
    disconnectPatchStore(opts());
    // Deleting it would make the next boot look like a first boot and re-seed.
    expect(existsSync(storePath)).toBe(true);
    const store = readPatchStore(opts());
    expect(store?.accounts).toEqual([
      { id: DEFAULT_ACCOUNT_ID, label: 'Default', credential: null },
    ]);
  });

  it('connect after disconnect restores access', () => {
    disconnectPatchStore(opts());
    expect(() => loadClaudeOAuth(opts())).toThrow(ClaudeOAuthMissingError);
    connectPatchStore({ accessToken: 'reconnected' }, opts());
    expect(loadClaudeOAuth(opts()).accessToken).toBe('reconnected');
  });

  it('does not touch the credentials file or Keychain', () => {
    // Disconnect used to delete the developer's actual Claude Code login. Patch
    // only owns its own store; emptying it is a complete disconnect because the
    // store is the only source read.
    const credFile = join(dir, 'creds.json');
    mkdirSync(join(dir, 'keep'), { recursive: true });
    writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
    connectPatchStore({ accessToken: 't' }, { storePath, path: credFile, env: {} });
    disconnectPatchStore({ storePath, path: credFile, env: {} });
    expect(existsSync(credFile)).toBe(true);
  });

  it('disconnect targets a named accountId, leaving other accounts untouched', () => {
    connectPatchStore({ accessToken: 'first' }, opts());
    const second = addPatchStoreAccount({ accessToken: 'second' }, opts(), 'Second');
    disconnectPatchStore(opts(), second.id);
    const store = readPatchStore(opts());
    expect(store?.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID)?.credential?.accessToken).toBe(
      'first',
    );
    expect(store?.accounts.find((a) => a.id === second.id)?.credential).toBeNull();
    // Active account is untouched by a disconnect of a non-active account.
    expect(store?.activeAccountId).toBe(DEFAULT_ACCOUNT_ID);
  });
});

describe('addPatchStoreAccount / listPatchStoreAccounts', () => {
  it('always creates a new slot, never replacing an existing account', () => {
    connectPatchStore({ accessToken: 'first' }, opts());
    const second = addPatchStoreAccount({ accessToken: 'second' }, opts(), 'Work');
    const accounts = listPatchStoreAccounts(opts());
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID)?.credential?.accessToken).toBe(
      'first',
    );
    expect(accounts.find((a) => a.id === second.id)).toEqual({
      id: second.id,
      label: 'Work',
      credential: { accessToken: 'second' },
    });
  });

  it('does not reassign activeAccountId when one already exists', () => {
    connectPatchStore({ accessToken: 'first' }, opts());
    addPatchStoreAccount({ accessToken: 'second' }, opts());
    expect(readPatchStore(opts())?.activeAccountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('becomes the active account when the store had none yet', () => {
    const account = addPatchStoreAccount({ accessToken: 'first' }, opts());
    expect(readPatchStore(opts())?.activeAccountId).toBe(account.id);
  });

  it('derives a label from the credential email when none is given', () => {
    const account = addPatchStoreAccount({ accessToken: 't', email: 'me@example.com' }, opts());
    expect(account.label).toBe('me@example.com');
  });

  it('derives a numbered label when there is no email and no explicit label', () => {
    addPatchStoreAccount({ accessToken: 'a' }, opts());
    const second = addPatchStoreAccount({ accessToken: 'b' }, opts());
    expect(second.label).toBe('Account 2');
  });

  it('lists an empty array for an absent store', () => {
    expect(listPatchStoreAccounts(opts())).toEqual([]);
  });
});

describe('persistClaudeOAuth with a store credential', () => {
  it('writes a refreshed token back to the STORE, not the Keychain', async () => {
    // Without a 'store' branch this fell through to the Keychain case and a routine
    // refresh would have overwritten the developer's actual Claude Code login.
    const { persistClaudeOAuth } = await import('../src/index.js');
    connectPatchStore({ accessToken: 'old', refreshToken: 'r0', email: 'a@b.c' }, opts());
    let keychainWrites = 0;
    persistClaudeOAuth(
      loadClaudeOAuth(opts()),
      { accessToken: 'new', refreshToken: 'r1', expiresAt: 42 },
      {
        writeKeychain: () => {
          keychainWrites += 1;
        },
      },
    );
    expect(keychainWrites).toBe(0);
    const store = readPatchStore(opts());
    expect(store?.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID)?.credential).toEqual({
      accessToken: 'new',
      refreshToken: 'r1',
      expiresAt: 42,
      email: 'a@b.c', // preserved across the refresh
    });
  });

  it('writes back to the SPECIFIC account it resolved from, leaving other accounts untouched', async () => {
    const { persistClaudeOAuth } = await import('../src/index.js');
    connectPatchStore({ accessToken: 'first', refreshToken: 'r0' }, opts());
    const second = addPatchStoreAccount({ accessToken: 'second', refreshToken: 'r0-2' }, opts());
    const cred = loadClaudeOAuth({ ...opts(), accountId: second.id });
    persistClaudeOAuth(
      cred,
      { accessToken: 'second-new', refreshToken: 'r1-2', expiresAt: 99 },
      {},
    );
    const store = readPatchStore(opts());
    expect(store?.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID)?.credential?.accessToken).toBe(
      'first',
    );
    expect(store?.accounts.find((a) => a.id === second.id)?.credential?.accessToken).toBe(
      'second-new',
    );
  });
});
