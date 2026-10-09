// Unit tests for the in-memory device presence registry (group 23.5,
// B-24-5). Pure logic over Maps — no WS/network needed, so this is exercised
// directly rather than through the full control-WSS harness (which
// device-control-ws.test.ts already covers for the wiring into a live
// connection).

import { describe, it, expect } from 'vitest';
import { PresenceRegistry } from '../src/devices/presence.js';
import type { DeviceRecord } from '../src/devices/registry.js';

function record(over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: 'kitchen',
    name: 'Kitchen',
    accountId: 'acct',
    publicKey: 'pub',
    registeredAt: 0,
    ...over,
  };
}

describe('PresenceRegistry', () => {
  it('attach() brings a device online; isOnline() reflects it', () => {
    const p = new PresenceRegistry();
    expect(p.isOnline('kitchen')).toBe(false);
    p.attach('kitchen', { muted: false, lastUsedAt: 1, send: () => {}, close: () => {} });
    expect(p.isOnline('kitchen')).toBe(true);
    expect(p.activeCount()).toBe(1);
  });

  it('attach() evicts a prior live connection for the same deviceId, calling close()', () => {
    const p = new PresenceRegistry();
    let closed = false;
    p.attach('kitchen', {
      muted: false,
      lastUsedAt: 1,
      send: () => {},
      close: () => {
        closed = true;
      },
    });
    p.attach('kitchen', { muted: false, lastUsedAt: 2, send: () => {}, close: () => {} });
    expect(closed).toBe(true);
    expect(p.activeCount()).toBe(1);
  });

  it('attach() swallows a prior close() that throws (still replaces it)', () => {
    const p = new PresenceRegistry();
    p.attach('kitchen', {
      muted: false,
      lastUsedAt: 1,
      send: () => {},
      close: () => {
        throw new Error('close boom');
      },
    });
    expect(() =>
      p.attach('kitchen', { muted: true, lastUsedAt: 2, send: () => {}, close: () => {} }),
    ).not.toThrow();
    expect(p.isMuted('kitchen')).toBe(true);
  });

  it('detach() on a device never seen is a no-op', () => {
    const p = new PresenceRegistry();
    expect(() => p.detach('ghost')).not.toThrow();
    expect(p.isOnline('ghost')).toBe(false);
  });

  it('detach() moves muted/lastUsedAt into lastSeen and marks offline', () => {
    const p = new PresenceRegistry();
    p.attach('kitchen', { muted: true, lastUsedAt: 42, send: () => {}, close: () => {} });
    p.detach('kitchen');
    expect(p.isOnline('kitchen')).toBe(false);
    expect(p.isMuted('kitchen')).toBe(true); // survives via lastSeen
  });

  it('isMuted() falls back to false when the device was never seen', () => {
    const p = new PresenceRegistry();
    expect(p.isMuted('ghost')).toBe(false);
  });

  it('setMuted() is a no-op for a device that is not active', () => {
    const p = new PresenceRegistry();
    expect(() => p.setMuted('ghost', true, 1)).not.toThrow();
    expect(p.isMuted('ghost')).toBe(false);
  });

  it('setMuted() updates muted + lastUsedAt for an active device', () => {
    const p = new PresenceRegistry();
    p.attach('kitchen', { muted: false, lastUsedAt: 1, send: () => {}, close: () => {} });
    p.setMuted('kitchen', true, 99);
    expect(p.isMuted('kitchen')).toBe(true);
    const [live] = p.enumerate([record()]);
    expect(live?.lastUsedAt).toBe(99);
  });

  it('touch() is a no-op for a device that is not active', () => {
    const p = new PresenceRegistry();
    expect(() => p.touch('ghost', 5)).not.toThrow();
  });

  it('touch() updates lastUsedAt for an active device', () => {
    const p = new PresenceRegistry();
    p.attach('kitchen', { muted: false, lastUsedAt: 1, send: () => {}, close: () => {} });
    p.touch('kitchen', 123);
    const [live] = p.enumerate([record()]);
    expect(live?.lastUsedAt).toBe(123);
  });

  it('send() returns false for a device that is not active', () => {
    const p = new PresenceRegistry();
    expect(p.send('ghost', { type: 'ring' })).toBe(false);
  });

  it('send() delivers the frame to an active device and returns true', () => {
    const p = new PresenceRegistry();
    const sent: Record<string, unknown>[] = [];
    p.attach('kitchen', {
      muted: false,
      lastUsedAt: 1,
      send: (f) => sent.push(f),
      close: () => {},
    });
    expect(p.send('kitchen', { type: 'ring', chatId: 'c1' })).toBe(true);
    expect(sent).toEqual([{ type: 'ring', chatId: 'c1' }]);
  });

  it('enumerate() filters out revoked devices and reports fwVersion only when live', () => {
    const p = new PresenceRegistry();
    p.attach('kitchen', {
      muted: false,
      lastUsedAt: 5,
      fwVersion: '1.2.3',
      send: () => {},
      close: () => {},
    });
    const records = [
      record({ deviceId: 'kitchen', name: 'Kitchen' }),
      record({ deviceId: 'bedroom', name: 'Bedroom' }),
      record({ deviceId: 'attic', name: 'Attic', revoked: true }),
    ];
    const out = p.enumerate(records);
    expect(out).toHaveLength(2); // attic excluded
    const kitchen = out.find((d) => d.deviceId === 'kitchen');
    expect(kitchen).toMatchObject({
      online: true,
      muted: false,
      lastUsedAt: 5,
      fwVersion: '1.2.3',
    });
    const bedroom = out.find((d) => d.deviceId === 'bedroom');
    expect(bedroom).toMatchObject({ online: false, muted: false, lastUsedAt: 0 });
    expect(bedroom).not.toHaveProperty('fwVersion');
  });

  it('enumerate() falls back to lastSeen muted/lastUsedAt for an offline-but-seen device', () => {
    const p = new PresenceRegistry();
    p.attach('kitchen', { muted: true, lastUsedAt: 7, send: () => {}, close: () => {} });
    p.detach('kitchen');
    const [out] = p.enumerate([record({ deviceId: 'kitchen' })]);
    expect(out).toMatchObject({ online: false, muted: true, lastUsedAt: 7 });
  });

  it('activeCount() reflects attach/detach', () => {
    const p = new PresenceRegistry();
    expect(p.activeCount()).toBe(0);
    p.attach('kitchen', { muted: false, lastUsedAt: 1, send: () => {}, close: () => {} });
    p.attach('bedroom', { muted: false, lastUsedAt: 1, send: () => {}, close: () => {} });
    expect(p.activeCount()).toBe(2);
    p.detach('kitchen');
    expect(p.activeCount()).toBe(1);
  });

  it('closeAll() closes every active socket and swallows a throwing close()', () => {
    const p = new PresenceRegistry();
    let kitchenClosed = false;
    p.attach('kitchen', {
      muted: false,
      lastUsedAt: 1,
      send: () => {},
      close: () => {
        kitchenClosed = true;
      },
    });
    p.attach('bedroom', {
      muted: false,
      lastUsedAt: 1,
      send: () => {},
      close: () => {
        throw new Error('close boom');
      },
    });
    expect(() => p.closeAll()).not.toThrow();
    expect(kitchenClosed).toBe(true);
    expect(p.activeCount()).toBe(0);
  });
});
