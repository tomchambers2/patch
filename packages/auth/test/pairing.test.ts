import { describe, it, expect } from 'vitest';
import {
  generateUserKeypair,
  createPairingNonce,
  completePairing,
  InMemoryPairingNonceStore,
  PAIRING_NONCE_TTL_MS,
  verifySurfaceCredential,
  CredentialVerificationError,
  PairingNonceExpiredError,
  PairingNonceUnknownError,
  type PairingNonceStore,
  type PairingNonceRecord,
} from '../src/index.js';

describe('QR pairing flow (server-as-credential-authority)', () => {
  it('createPairingNonce returns a 256-bit base64url nonce that expires in 5min', () => {
    const t0 = 1_700_000_000_000;
    const created = createPairingNonce({
      randomBytes: () => new Uint8Array(32).fill(0xab),
      nowMs: t0,
    });
    expect(created.nonce.length).toBe(43);
    expect(created.expiresAt).toBe(t0 + PAIRING_NONCE_TTL_MS);
  });

  it('createPairingNonce uses default randomBytes + Date.now() when opts are omitted', () => {
    const before = Date.now();
    const created = createPairingNonce();
    const after = Date.now();
    expect(created.nonce.length).toBe(43);
    expect(created.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_NONCE_TTL_MS);
    expect(created.expiresAt).toBeLessThanOrEqual(after + PAIRING_NONCE_TTL_MS);
  });

  it('createPairingNonce throws if the injected randomBytes returns the wrong length', () => {
    expect(() => createPairingNonce({ randomBytes: () => new Uint8Array(16) })).toThrowError(
      /randomBytes returned 16 bytes, expected 32/,
    );
  });

  it('end-to-end: server mints a credential bound to the nonce + device key', async () => {
    const account = generateUserKeypair(() => new Uint8Array(32).fill(3));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(5));

    const t0 = 1_700_000_000_000;
    const created = createPairingNonce({
      randomBytes: () => new Uint8Array(32).fill(6),
      nowMs: t0,
    });

    const store = new InMemoryPairingNonceStore();
    store.put({ nonce: created.nonce, expiresAt: created.expiresAt });

    const result = await completePairing({
      nonce: created.nonce,
      devicePublicKey: device.publicKey,
      surface: { kind: 'mobile', label: 'pixel-9', surfaceId: 'srf-new' },
      accountPrivateKey: account.privateKey,
      nonceStore: store,
      nowMs: t0 + 1000,
    });

    expect(result.surfaceId).toBe('srf-new');

    // Nonce consumed.
    expect(store.get(created.nonce)).toBeUndefined();

    // The minted JWT verifies against the account public key and carries the
    // pairing bindings.
    const claims = await verifySurfaceCredential(result.credential, {
      userPublicKey: account.publicKey,
      now: Math.floor(t0 / 1000) + 2,
    });
    expect(claims.surface_kind).toBe('mobile');
    expect(claims.surface_id).toBe('srf-new');
    expect(claims.pairing_nonce).toBe(created.nonce);
    expect(claims.surface_pubkey).toBe(device.publicKey);
  });

  it('rejects an expired nonce', async () => {
    const account = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(8));

    const t0 = 1_700_000_000_000;
    const created = createPairingNonce({
      randomBytes: () => new Uint8Array(32).fill(10),
      nowMs: t0,
    });

    const store = new InMemoryPairingNonceStore();
    store.put({ nonce: created.nonce, expiresAt: created.expiresAt });

    await expect(
      completePairing({
        nonce: created.nonce,
        devicePublicKey: device.publicKey,
        surface: { kind: 'web', label: 'b', surfaceId: 's' },
        accountPrivateKey: account.privateKey,
        nonceStore: store,
        nowMs: t0 + PAIRING_NONCE_TTL_MS + 1,
      }),
    ).rejects.toBeInstanceOf(PairingNonceExpiredError);
  });

  it('rejects an unknown nonce', async () => {
    const account = generateUserKeypair(() => new Uint8Array(32).fill(11));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(12));

    await expect(
      completePairing({
        nonce: 'nope',
        devicePublicKey: device.publicKey,
        surface: { kind: 'web', label: 'b', surfaceId: 's' },
        accountPrivateKey: account.privateKey,
        nonceStore: new InMemoryPairingNonceStore(),
      }),
    ).rejects.toBeInstanceOf(PairingNonceUnknownError);
  });

  it('rejects a malformed device public key (does not burn the nonce)', async () => {
    const account = generateUserKeypair(() => new Uint8Array(32).fill(14));
    const t0 = 1_700_000_000_000;

    const store = new InMemoryPairingNonceStore();
    store.put({ nonce: 'N', expiresAt: t0 + PAIRING_NONCE_TTL_MS });

    await expect(
      completePairing({
        nonce: 'N',
        devicePublicKey: 'not-a-valid-ed25519-key',
        surface: { kind: 'web', label: 'b', surfaceId: 's' },
        accountPrivateKey: account.privateKey,
        nonceStore: store,
        nowMs: t0,
      }),
    ).rejects.toBeInstanceOf(CredentialVerificationError);

    // Nonce survives a bad submission (DoS resistance).
    expect(store.get('N')).toBeDefined();
  });

  it('throws TypeError when nonceStore is missing (JS-caller guard)', async () => {
    const account = generateUserKeypair(() => new Uint8Array(32).fill(50));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(51));
    await expect(
      completePairing({
        nonce: 'N',
        devicePublicKey: device.publicKey,
        surface: { kind: 'web', label: 'b', surfaceId: 's' },
        accountPrivateKey: account.privateKey,
      } as unknown as Parameters<typeof completePairing>[0]),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('single-use: a consumed nonce cannot be replayed', async () => {
    const account = generateUserKeypair(() => new Uint8Array(32).fill(60));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(61));
    const t0 = 1_700_000_000_000;

    const store = new InMemoryPairingNonceStore();
    store.put({ nonce: 'N', expiresAt: t0 + PAIRING_NONCE_TTL_MS });

    const first = await completePairing({
      nonce: 'N',
      devicePublicKey: device.publicKey,
      surface: { kind: 'web', label: 'b', surfaceId: 's1' },
      accountPrivateKey: account.privateKey,
      nonceStore: store,
      nowMs: t0,
    });
    expect(first.credential.length).toBeGreaterThan(0);

    await expect(
      completePairing({
        nonce: 'N',
        devicePublicKey: device.publicKey,
        surface: { kind: 'web', label: 'b', surfaceId: 's2' },
        accountPrivateKey: account.privateKey,
        nonceStore: store,
        nowMs: t0,
      }),
    ).rejects.toBeInstanceOf(PairingNonceUnknownError);
  });

  it('InMemoryPairingNonceStore caps at maxEntries (FIFO drop oldest)', () => {
    const store = new InMemoryPairingNonceStore({ maxEntries: 3, now: () => 0 });
    store.put({ nonce: 'n1', expiresAt: 1_000_000_000 });
    store.put({ nonce: 'n2', expiresAt: 1_000_000_000 });
    store.put({ nonce: 'n3', expiresAt: 1_000_000_000 });
    store.put({ nonce: 'n4', expiresAt: 1_000_000_000 });
    expect(store.get('n1')).toBeUndefined();
    expect(store.get('n2')).toBeDefined();
    expect(store.get('n4')).toBeDefined();
    expect(store.size()).toBe(3);
  });

  it('InMemoryPairingNonceStore auto-prunes expired entries on put', () => {
    let nowMs = 1000;
    const store = new InMemoryPairingNonceStore({ maxEntries: 100, now: () => nowMs });
    store.put({ nonce: 'old', expiresAt: 2000 });
    nowMs = 5000;
    store.put({ nonce: 'fresh', expiresAt: 10_000 });
    expect(store.get('old')).toBeUndefined();
    expect(store.get('fresh')).toBeDefined();
  });

  it('InMemoryPairingNonceStore rejects a non-positive maxEntries', () => {
    expect(() => new InMemoryPairingNonceStore({ maxEntries: 0 })).toThrowError(
      /maxEntries must be > 0/,
    );
    expect(() => new InMemoryPairingNonceStore({ maxEntries: -1 })).toThrowError(
      /maxEntries must be > 0/,
    );
  });

  it('InMemoryPairingNonceStore.put re-orders a re-inserted nonce to the tail', () => {
    // Re-putting the SAME nonce (e.g. a refreshed expiry) must not create a
    // duplicate entry — it should be removed and re-added, moving it to the
    // most-recent end of the FIFO eviction order.
    const store = new InMemoryPairingNonceStore({ maxEntries: 2, now: () => 0 });
    store.put({ nonce: 'a', expiresAt: 1_000_000_000 });
    store.put({ nonce: 'a', expiresAt: 2_000_000_000 }); // re-insert, same key
    store.put({ nonce: 'b', expiresAt: 1_000_000_000 });
    // Still under the cap (2 unique entries) — nothing evicted, and 'a' has
    // the refreshed expiry.
    expect(store.size()).toBe(2);
    expect(store.get('a')?.expiresAt).toBe(2_000_000_000);
    expect(store.get('b')).toBeDefined();
  });

  it('InMemoryPairingNonceStore.take returns undefined for a nonce that was never stored', () => {
    const store = new InMemoryPairingNonceStore();
    expect(store.take('never-put')).toBeUndefined();
  });

  it('completePairing puts the nonce back if mintSurfaceCredential fails (does not burn it)', async () => {
    const device = generateUserKeypair(() => new Uint8Array(32).fill(70));
    const t0 = 1_700_000_000_000;
    const store = new InMemoryPairingNonceStore();
    store.put({ nonce: 'N', expiresAt: t0 + PAIRING_NONCE_TTL_MS });

    // An invalid (wrong-length) accountPrivateKey makes mintSurfaceCredential's
    // internal loadUserIdentity throw AFTER the nonce has already been reserved.
    await expect(
      completePairing({
        nonce: 'N',
        devicePublicKey: device.publicKey,
        surface: { kind: 'web', label: 'b', surfaceId: 's' },
        accountPrivateKey: 'not-a-valid-private-key',
        nonceStore: store,
        nowMs: t0,
      }),
    ).rejects.toThrow();

    // The nonce was put back, not burned — a retry with a valid key succeeds.
    expect(store.get('N')).toBeDefined();
    const account = generateUserKeypair(() => new Uint8Array(32).fill(71));
    const result = await completePairing({
      nonce: 'N',
      devicePublicKey: device.publicKey,
      surface: { kind: 'web', label: 'b', surfaceId: 's' },
      accountPrivateKey: account.privateKey,
      nonceStore: store,
      nowMs: t0,
    });
    expect(result.surfaceId).toBe('s');
  });

  it('rejects with PairingNonceUnknownError when take() loses a TOCTOU race after get() succeeded', async () => {
    // Simulates two concurrent completes racing on the same nonce: this
    // store's `get` reports the record as present/unexpired, but `take`
    // (the atomic reserve-and-remove) reports it already gone — the loser
    // of the race must see PairingNonceUnknownError, never proceed to mint.
    const account = generateUserKeypair(() => new Uint8Array(32).fill(72));
    const device = generateUserKeypair(() => new Uint8Array(32).fill(73));
    const record: PairingNonceRecord = { nonce: 'N', expiresAt: Number.MAX_SAFE_INTEGER };
    const raceStore: PairingNonceStore = {
      get: () => record,
      take: () => undefined,
      put: () => {
        /* no-op: not reached before the throw */
      },
    };
    await expect(
      completePairing({
        nonce: 'N',
        devicePublicKey: device.publicKey,
        surface: { kind: 'web', label: 'b', surfaceId: 's' },
        accountPrivateKey: account.privateKey,
        nonceStore: raceStore,
        nowMs: 0,
      }),
    ).rejects.toBeInstanceOf(PairingNonceUnknownError);
  });
});
