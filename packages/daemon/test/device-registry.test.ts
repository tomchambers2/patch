// Unit tests for the host-side device pairing registry (group 23.5,
// B-24-3) — persistence, register (fresh/re-pair/conflict), revoke, and the
// test-only snapshot. Pure logic over a JSON file on disk, so exercised
// directly with a temp-dir fixture rather than through the full control-WSS
// harness.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceRegistry, DeviceConflictError } from '../src/devices/registry.js';

describe('DeviceRegistry', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-device-registry-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('load() creates an empty devices.json when none exists', () => {
    const registry = DeviceRegistry.load(home);
    expect(registry.list()).toEqual([]);
    const path = join(home, 'devices.json');
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual({ version: 1, devices: [] });
  });

  it('load() reads back an existing file written by a prior instance', () => {
    const first = DeviceRegistry.load(home);
    first.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    // Fresh instance reading the SAME path must see the persisted device.
    const second = DeviceRegistry.load(home);
    expect(second.get('kitchen')).toMatchObject({ deviceId: 'kitchen', publicKey: 'pub-1' });
  });

  it('register() adds a new device', () => {
    const registry = DeviceRegistry.load(home);
    const record = registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    expect(record).toEqual({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    expect(registry.list()).toHaveLength(1);
  });

  it('register() is idempotent (re-pair) when the publicKey matches — refreshes name/registeredAt', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    const updated = registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen (renamed)',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 2000,
    });
    expect(updated.name).toBe('Kitchen (renamed)');
    expect(updated.registeredAt).toBe(2000);
    expect(registry.list()).toHaveLength(1); // not duplicated
    expect(registry.get('kitchen')?.name).toBe('Kitchen (renamed)');
  });

  it('register() re-pair leaves OTHER devices in the list untouched', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    registry.register({
      deviceId: 'bedroom',
      name: 'Bedroom',
      accountId: 'acct',
      publicKey: 'pub-2',
      registeredAt: 1500,
    });
    // Re-pair kitchen only; bedroom's record must be unaffected by the map.
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen (renamed)',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 3000,
    });
    expect(registry.get('bedroom')).toEqual({
      deviceId: 'bedroom',
      name: 'Bedroom',
      accountId: 'acct',
      publicKey: 'pub-2',
      registeredAt: 1500,
    });
    expect(registry.list()).toHaveLength(2);
  });

  it('register() throws DeviceConflictError when the deviceId is re-registered with a DIFFERENT publicKey', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    expect(() =>
      registry.register({
        deviceId: 'kitchen',
        name: 'Kitchen',
        accountId: 'acct',
        publicKey: 'pub-2',
        registeredAt: 2000,
      }),
    ).toThrow(DeviceConflictError);
    try {
      registry.register({
        deviceId: 'kitchen',
        name: 'Kitchen',
        accountId: 'acct',
        publicKey: 'pub-2',
        registeredAt: 2000,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceConflictError);
      expect((err as Error).name).toBe('DeviceConflictError');
      expect((err as Error).message).toContain('kitchen');
    }
    // The original record is untouched by the rejected conflicting register.
    expect(registry.get('kitchen')?.publicKey).toBe('pub-1');
  });

  it('get() returns undefined for an unknown device', () => {
    const registry = DeviceRegistry.load(home);
    expect(registry.get('ghost')).toBeUndefined();
  });

  it('revoke() marks a device revoked and persists it', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    registry.revoke('kitchen');
    expect(registry.get('kitchen')?.revoked).toBe(true);
    // Persisted: a fresh load from the same path sees the revocation.
    const reloaded = DeviceRegistry.load(home);
    expect(reloaded.get('kitchen')?.revoked).toBe(true);
  });

  it('revoke() throws for an unknown device', () => {
    const registry = DeviceRegistry.load(home);
    expect(() => registry.revoke('ghost')).toThrow(/no device ghost/);
  });

  it('isRevoked() reports true only for a revoked device, false for unknown/unrevoked', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    expect(registry.isRevoked('kitchen')).toBe(false);
    expect(registry.isRevoked('ghost')).toBe(false);
    registry.revoke('kitchen');
    expect(registry.isRevoked('kitchen')).toBe(true);
  });

  it('list() returns a copy — mutating it does not affect the registry', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    const list = registry.list();
    list.pop();
    expect(registry.list()).toHaveLength(1);
  });

  it('snapshot() returns a deep clone independent of internal state', () => {
    const registry = DeviceRegistry.load(home);
    registry.register({
      deviceId: 'kitchen',
      name: 'Kitchen',
      accountId: 'acct',
      publicKey: 'pub-1',
      registeredAt: 1000,
    });
    const snap = registry.snapshot();
    expect(snap).toEqual({
      version: 1,
      devices: [
        {
          deviceId: 'kitchen',
          name: 'Kitchen',
          accountId: 'acct',
          publicKey: 'pub-1',
          registeredAt: 1000,
        },
      ],
    });
    // Mutating the snapshot must not leak back into the registry.
    snap.devices.push({
      deviceId: 'bedroom',
      name: 'Bedroom',
      accountId: 'acct',
      publicKey: 'pub-2',
      registeredAt: 2000,
    });
    expect(registry.list()).toHaveLength(1);
  });
});
