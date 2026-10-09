import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import { Registry } from '../src/registry.js';

// Deterministic keypairs for assertions on the (server-generated) account key.
const KP_A = generateUserKeypair(() => new Uint8Array(32).fill(1));
const KP_B = generateUserKeypair(() => new Uint8Array(32).fill(2));

describe('Registry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-registry-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and re-reads atomically (no temp file left behind)', () => {
    const r1 = Registry.load(dir);
    r1.bootstrapAccount({ keypair: KP_A, nowMs: 1000 });
    r1.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1000,
    });

    // Atomic: no .tmp.* file left after a successful flush.
    const stragglers = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stragglers).toEqual([]);
    expect(existsSync(join(dir, 'registry.json'))).toBe(true);

    // Reload from disk; expect identical state — including the persisted private
    // key (server-internal, read only via getAccountPrivateKey).
    const r2 = Registry.load(dir);
    expect(r2.getAccount()?.userPublicKey).toBe(KP_A.publicKey);
    expect(r2.getAccountPrivateKey()).toBe(KP_A.privateKey);
    expect(r2.listSurfaces()).toHaveLength(1);
    expect(r2.listSurfaces()[0]?.surfaceId).toBe('srf-1');
  });

  it('writes registry.json owner-only (0600) on every flush, not just at create', () => {
    // registry.json holds daemonKeys (the credential machines authenticate
    // with) and the account private key. spec/10-auth keeps credential stores
    // owner-only. The write is tmp-then-rename, so the mode must be set on the
    // tmp file — chmod'ing the destination afterwards would not survive the
    // NEXT flush, which is exactly the regression this asserts against.
    const path = join(dir, 'registry.json');
    const r = Registry.load(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Loosen it by hand, then flush again: the writer must restore 0600.
    chmodSync(path, 0o644);
    r.bootstrapAccount({ keypair: KP_A, nowMs: 1000 });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    chmodSync(path, 0o644);
    r.upsertSurface({ surfaceId: 'srf-mode', surfaceKind: 'web', label: 'b', issuedAt: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('commit-before-act: durable write completes (fsync+rename) before upsertSurface returns (Fix 5)', () => {
    // Fix 5 (TB1): the registry write is the durable commit that must land on
    // disk BEFORE any dependent broadcast/response (e.g. pair/complete emits
    // the credential + admits the surface only after this returns). flush()
    // does writeFileSync(temp) → fsync → rename synchronously, so by the time
    // upsertSurface() returns the renamed file MUST already contain the record
    // and NO temp straggler may remain (rename completed).
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A, nowMs: 1000 });

    const path = join(dir, 'registry.json');
    r.upsertSurface({
      surfaceId: 'srf-ordered',
      surfaceKind: 'mobile',
      label: 'pixel',
      issuedAt: 2000,
    });

    // Read the file fresh off disk (independent of the in-memory state) — the
    // durable commit is observable the instant the synchronous call returns.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      surfaces: { surfaceId: string }[];
    };
    expect(onDisk.surfaces.some((s) => s.surfaceId === 'srf-ordered')).toBe(true);

    // rename completed atomically — no half-written temp file is observable.
    const stragglers = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stragglers).toEqual([]);
  });

  it('bootstrapAccount is single-shot: a second call throws (server is the authority)', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    expect(account.accountId).toBe(KP_A.publicKey);
    // No second account may be bootstrapped — even with the same key.
    expect(() => r.bootstrapAccount({ keypair: KP_A })).toThrowError(/already bootstrapped/);
    expect(() => r.bootstrapAccount({ keypair: KP_B })).toThrowError(/already bootstrapped/);
  });

  it('server-generated bootstrap mints a keypair when none is injected', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount();
    expect(account.userPublicKey.length).toBeGreaterThan(0);
    expect(account.accountId).toBe(account.userPublicKey);
    // The private key is held server-side and re-derives the public key.
    const priv = r.getAccountPrivateKey();
    expect(priv).not.toBeNull();
    // getAccount() must NOT expose the private key.
    expect(JSON.stringify(r.getAccount())).not.toContain(priv as string);
  });

  it('revoke + isRevoked round-trip for a surface', () => {
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A });
    r.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'x', issuedAt: 1 });
    expect(r.isRevoked('srf-1')).toBe(false);
    r.revoke('srf-1');
    expect(r.isRevoked('srf-1')).toBe(true);
    // Persisted across reload.
    expect(Registry.load(dir).isRevoked('srf-1')).toBe(true);
  });

  it('revoke unknown id throws (NO FALLBACK)', () => {
    const r = Registry.load(dir);
    expect(() => r.revoke('does-not-exist')).toThrowError(/no surface or host/);
  });

  it('hydration preserves an existing non-null account across reloads', () => {
    const r1 = Registry.load(dir);
    const account = r1.bootstrapAccount({ keypair: KP_A, nowMs: 5000 });
    expect(account.userPublicKey).toBe(KP_A.publicKey);
    // Simulate a process restart (docker stop/start) — re-load the same dir.
    const r2 = Registry.load(dir);
    expect(r2.getAccount()).not.toBeNull();
    expect(r2.getAccount()?.userPublicKey).toBe(KP_A.publicKey);
    expect(r2.getAccount()?.createdAt).toBe(5000);
    expect(r2.getAccountPrivateKey()).toBe(KP_A.privateKey);
  });

  it('rejects malformed registry.json on load', () => {
    const path = join(dir, 'registry.json');
    writeFileSync(path, '{"version":99,"account":null}', 'utf8');
    expect(() => Registry.load(dir)).toThrow();
  });

  it('rejects a legacy account (public key only, no private key) with a migration instruction', () => {
    const path = join(dir, 'registry.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        account: { accountId: KP_A.publicKey, userPublicKey: KP_A.publicKey, createdAt: 1 },
        surfaces: [],
        daemonKey: null,
      }),
      'utf8',
    );
    expect(() => Registry.load(dir)).toThrowError(/migrate:account-key/);
    expect(() => Registry.load(dir)).toThrowError(new RegExp(KP_A.publicKey));
  });

  it('upsertSurface updates an existing surface in place (does not duplicate)', () => {
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A });
    r.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'first', issuedAt: 1 });
    r.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'mobile', label: 'second', issuedAt: 2 });
    expect(r.listSurfaces()).toHaveLength(1);
    expect(r.getSurface('srf-1')).toEqual({
      surfaceId: 'srf-1',
      surfaceKind: 'mobile',
      label: 'second',
      issuedAt: 2,
    });
  });

  it('revoke requires a non-empty id (NO FALLBACK)', () => {
    const r = Registry.load(dir);
    expect(() => r.revoke('')).toThrowError(/id required/);
    expect(() => r.revoke(undefined as unknown as string)).toThrowError(/id required/);
  });

  it('revoke + isRevoked round-trip for a host key', () => {
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A });
    r.setDaemonKey({ daemonId: 'daemon-1', publicKey: KP_A.publicKey, issuedAt: 1 });
    expect(r.isRevoked('daemon-1')).toBe(false);
    r.revoke('daemon-1');
    expect(r.isRevoked('daemon-1')).toBe(true);
    // The registry holds a key PER MACHINE, so the record is read by id.
    expect(r.getDaemonKey('daemon-1')?.revoked).toBe(true);
  });

  it('removeDaemon tombstones the machine (revoked), drops it from the roster, and clears it as home', () => {
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A });
    r.setDaemonKey({ daemonId: 'daemon-1', publicKey: KP_A.publicKey, issuedAt: 1 });
    r.setDaemonKey({ daemonId: 'daemon-2', publicKey: KP_A.publicKey, issuedAt: 1 });
    r.setHomeDaemonId('daemon-2');
    r.removeDaemon('daemon-2');
    expect(r.isRevoked('daemon-2')).toBe(true);
    expect(r.registeredDaemonIds()).toEqual(['daemon-1']);
    expect(r.homeDaemonId()).toBe('daemon-1');
    // Durable: a reload agrees.
    const reloaded = Registry.load(dir);
    expect(reloaded.registeredDaemonIds()).toEqual(['daemon-1']);
    expect(reloaded.snapshot().homeDaemonId).toBeNull();
    // Removing it again, or a machine never registered, is refused naming it.
    expect(() => r.removeDaemon('daemon-2')).toThrow(/daemon-2/);
    expect(() => r.removeDaemon('nope')).toThrow(/nope/);
    // Pairing the machine again brings it back.
    r.setDaemonKey({ daemonId: 'daemon-2', publicKey: KP_A.publicKey, issuedAt: 2 });
    expect(r.registeredDaemonIds()).toEqual(['daemon-1', 'daemon-2']);
  });

  it('isRevoked returns false for a totally unknown id (not authoritative)', () => {
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A });
    expect(r.isRevoked('nobody-knows-this-id')).toBe(false);
  });

  it('registerPushToken updates an existing surface token in place (one per surface)', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    r.registerPushToken({
      surfaceId: 'srf-1',
      accountId: account.accountId,
      token: 'tok-old',
      registeredAt: 1,
    });
    r.registerPushToken({
      surfaceId: 'srf-1',
      accountId: account.accountId,
      token: 'tok-new',
      registeredAt: 2,
    });
    expect(r.listPushTokens(account.accountId)).toEqual(['tok-new']);
  });

  describe('removePushTokens', () => {
    it('is a no-op that returns 0 for an empty token list', () => {
      const r = Registry.load(dir);
      expect(r.removePushTokens([])).toBe(0);
    });

    it('removes matching tokens and returns the removed count', () => {
      const r = Registry.load(dir);
      const account = r.bootstrapAccount({ keypair: KP_A });
      r.registerPushToken({
        surfaceId: 'srf-1',
        accountId: account.accountId,
        token: 'tok-dead',
        registeredAt: 1,
      });
      r.registerPushToken({
        surfaceId: 'srf-2',
        accountId: account.accountId,
        token: 'tok-alive',
        registeredAt: 2,
      });
      expect(r.removePushTokens(['tok-dead'])).toBe(1);
      expect(r.listPushTokens(account.accountId)).toEqual(['tok-alive']);
    });

    it('returns 0 when none of the given tokens are present (no-op)', () => {
      const r = Registry.load(dir);
      const account = r.bootstrapAccount({ keypair: KP_A });
      r.registerPushToken({
        surfaceId: 'srf-1',
        accountId: account.accountId,
        token: 'tok-alive',
        registeredAt: 1,
      });
      expect(r.removePushTokens(['tok-does-not-exist'])).toBe(0);
      expect(r.listPushTokens(account.accountId)).toEqual(['tok-alive']);
    });
  });

  it('listPushTokens attributes a legacy record (no accountId) to the singleton account', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    // Simulate a pre-fix persisted record with no accountId field.
    const path = join(dir, 'registry.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      pushTokens?: Array<{ surfaceId: string; token: string; registeredAt: number }>;
    };
    raw.pushTokens = [{ surfaceId: 'srf-legacy', token: 'tok-legacy', registeredAt: 1 }];
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    const reloaded = Registry.load(dir);
    expect(reloaded.listPushTokens(account.accountId)).toEqual(['tok-legacy']);
    // A different (non-singleton) accountId must NOT see the legacy record.
    expect(reloaded.listPushTokens('some-other-account')).toEqual([]);
  });

  it('load() strips a legacy top-level `fcmTokens` key rather than rejecting the file', () => {
    // Pre-Expo-push registries persisted native FCM device tokens under
    // `fcmTokens`. There's no way to turn one of those into an Expo push
    // token, and the surface re-registers on its next launch anyway, so the
    // field is dead weight that must not crash `RegistryFile.parse`'s
    // `.strict()` schema on load.
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    const path = join(dir, 'registry.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    raw['fcmTokens'] = [{ surfaceId: 'srf-old', token: 'old-fcm-token', registeredAt: 1 }];
    writeFileSync(path, JSON.stringify(raw), 'utf8');
    const reloaded = Registry.load(dir);
    expect(reloaded.listPushTokens(account.accountId)).toEqual([]);
  });

  it('setProjectFolders updates an existing record in place (replaces, not appends)', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    r.setProjectFolders(account.accountId, ['/a'], 1);
    r.setProjectFolders(account.accountId, ['/b', '/c'], 2);
    expect(r.getProjectFolders(account.accountId)).toEqual(['/b', '/c']);
  });

  it('getAccount()/getAccountPrivateKey() are null before any bootstrap', () => {
    const r = Registry.load(dir);
    expect(r.getAccount()).toBeNull();
    expect(r.getAccountPrivateKey()).toBeNull();
  });

  it('removePushTokens/listPushTokens tolerate a registry that never had any fcmTokens', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    expect(r.removePushTokens(['whatever'])).toBe(0);
    expect(r.listPushTokens(account.accountId)).toEqual([]);
  });

  it('getProjectFolders returns [] for a registry that never set any + for an unknown account', () => {
    const r = Registry.load(dir);
    const account = r.bootstrapAccount({ keypair: KP_A });
    expect(r.getProjectFolders(account.accountId)).toEqual([]);
    r.setProjectFolders(account.accountId, ['/a'], 1);
    expect(r.getProjectFolders('some-other-account')).toEqual([]);
  });

  it('snapshot() returns a deep clone (mutating it never affects registry state)', () => {
    const r = Registry.load(dir);
    r.bootstrapAccount({ keypair: KP_A, nowMs: 1000 });
    r.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'x', issuedAt: 1 });
    const snap = r.snapshot();
    expect(snap.account?.accountId).toBe(KP_A.publicKey);
    expect(snap.surfaces).toHaveLength(1);
    snap.surfaces.push({ surfaceId: 'injected', surfaceKind: 'web', label: 'x', issuedAt: 1 });
    expect(r.listSurfaces()).toHaveLength(1);
  });
});
