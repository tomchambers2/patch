// Host-side device registry (group 23.5, B-24-3).
//
// Persists per-device pairing records — { deviceId, name, accountId,
// publicKey, registeredAt } — to `<patchHome>/devices.json` via atomic
// temp + rename. The host (not the server) owns this because the
// device-pairing flow must run on the host: per spec/16, the device
// only ever talks to its paired host.
//
// NO FALLBACK on parse errors: a malformed file fails loudly so we don't
// silently overwrite bad data.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const DeviceRecord = z
  .object({
    deviceId: z.string().min(1),
    name: z.string().min(1),
    accountId: z.string().min(1),
    /** Base64url Ed25519 public key — the device's surface key. */
    publicKey: z.string().min(1),
    registeredAt: z.number().int(),
    revoked: z.boolean().optional(),
  })
  .strict();
export type DeviceRecord = z.infer<typeof DeviceRecord>;

const DeviceRegistryFile = z
  .object({
    version: z.literal(1),
    devices: z.array(DeviceRecord),
  })
  .strict();
export type DeviceRegistryFile = z.infer<typeof DeviceRegistryFile>;

const EMPTY: DeviceRegistryFile = { version: 1, devices: [] };

export class DeviceConflictError extends Error {
  constructor(deviceId: string) {
    super(`device ${deviceId} already registered with a different public key`);
    this.name = 'DeviceConflictError';
  }
}

export class DeviceRegistry {
  private state: DeviceRegistryFile;
  private readonly path: string;

  private constructor(path: string, state: DeviceRegistryFile) {
    this.path = path;
    this.state = state;
  }

  static load(patchHome: string): DeviceRegistry {
    const path = join(patchHome, 'devices.json');
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const r = new DeviceRegistry(path, structuredClone(EMPTY));
      r.flush();
      return r;
    }
    const raw = readFileSync(path, 'utf8');
    const parsed = DeviceRegistryFile.parse(JSON.parse(raw));
    return new DeviceRegistry(path, parsed);
  }

  /** Atomic write: temp + fsync + rename. */
  private flush(): void {
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    const fd = openSync(tmp, 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path);
  }

  list(): DeviceRecord[] {
    return this.state.devices.slice();
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.state.devices.find((d) => d.deviceId === deviceId);
  }

  /**
   * Register a new device. Throws DeviceConflictError if the deviceId is
   * already known with a different publicKey. Idempotent on identical key.
   */
  register(input: {
    deviceId: string;
    name: string;
    accountId: string;
    publicKey: string;
    registeredAt: number;
  }): DeviceRecord {
    const existing = this.state.devices.find((d) => d.deviceId === input.deviceId);
    if (existing) {
      if (existing.publicKey !== input.publicKey) {
        throw new DeviceConflictError(input.deviceId);
      }
      // Refresh name/account/registeredAt — re-pair flow.
      const updated: DeviceRecord = {
        deviceId: input.deviceId,
        name: input.name,
        accountId: input.accountId,
        publicKey: input.publicKey,
        registeredAt: input.registeredAt,
      };
      this.state.devices = this.state.devices.map((d) =>
        d.deviceId === input.deviceId ? updated : d,
      );
      this.flush();
      return updated;
    }
    const record: DeviceRecord = {
      deviceId: input.deviceId,
      name: input.name,
      accountId: input.accountId,
      publicKey: input.publicKey,
      registeredAt: input.registeredAt,
    };
    this.state.devices = [...this.state.devices, record];
    this.flush();
    return record;
  }

  revoke(deviceId: string): void {
    const idx = this.state.devices.findIndex((d) => d.deviceId === deviceId);
    if (idx < 0) throw new Error(`DeviceRegistry.revoke: no device ${deviceId}`);
    const cur = this.state.devices[idx];
    // Unreachable defensively: idx just came from findIndex on this same array
    // and nothing else can mutate `this.state.devices` between these two
    // synchronous lines (no await, single-threaded) — cur is always defined.
    /* v8 ignore next */
    if (!cur) throw new Error('DeviceRegistry.revoke: lost record mid-update');
    this.state.devices[idx] = { ...cur, revoked: true };
    this.flush();
  }

  isRevoked(deviceId: string): boolean {
    const r = this.state.devices.find((d) => d.deviceId === deviceId);
    return r?.revoked === true;
  }

  /** Test-only snapshot. */
  snapshot(): DeviceRegistryFile {
    return structuredClone(this.state);
  }
}
