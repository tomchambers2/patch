// The five-minute voice-device adoption window (spec/16 § F2).
//
// A speaker carries no account credential, so nothing here reaches the server —
// which makes the window itself the whole security boundary. It had no
// implementation at all: `deviceRegistry.register` had no call site and
// `/pair-device` had nothing to open.

import { describe, it, expect } from 'vitest';
import { DeviceAdoption, ADOPTION_WINDOW_MS } from '../src/devices/adoption.js';

function at(t: { now: number }) {
  return new DeviceAdoption(() => t.now);
}

describe('device adoption window', () => {
  it('is closed until the machine opens one', () => {
    const t = { now: 1_000 };
    const a = at(t);
    expect(a.isOpen()).toBe(false);
    const res = a.announce('spk-1');
    expect(res.adopted).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining('no adoption window is open') });
  });

  it('adopts the first device to announce inside the window', () => {
    const t = { now: 1_000 };
    const a = at(t);
    const w = a.open();
    expect(w.expiresAt - w.opensAt).toBe(ADOPTION_WINDOW_MS);
    expect(a.announce('spk-1')).toEqual({ adopted: true, deviceId: 'spk-1' });
  });

  it('adopts exactly ONE device per window — a second is refused, not swapped in', () => {
    const t = { now: 1_000 };
    const a = at(t);
    a.open();
    expect(a.announce('spk-1').adopted).toBe(true);
    const second = a.announce('spk-2');
    expect(second.adopted).toBe(false);
    expect(second).toMatchObject({ reason: expect.stringContaining('spk-1') });
  });

  it('refuses an announcement after the window expires', () => {
    const t = { now: 1_000 };
    const a = at(t);
    a.open();
    t.now += ADOPTION_WINDOW_MS; // exactly at the boundary — expired
    expect(a.isOpen()).toBe(false);
    expect(a.announce('spk-1').adopted).toBe(false);
  });

  it('still accepts one moment before expiry', () => {
    const t = { now: 1_000 };
    const a = at(t);
    a.open();
    t.now += ADOPTION_WINDOW_MS - 1;
    expect(a.announce('spk-1').adopted).toBe(true);
  });

  it('re-opening restarts the clock and allows a new device — re-pairing MOVES a device', () => {
    const t = { now: 1_000 };
    const a = at(t);
    a.open();
    expect(a.announce('spk-1').adopted).toBe(true);
    // The same machine (or another) opens a fresh window later.
    t.now += ADOPTION_WINDOW_MS * 2;
    a.open();
    expect(a.announce('spk-2').adopted).toBe(true);
  });

  it('close() cancels without adopting', () => {
    const t = { now: 1_000 };
    const a = at(t);
    a.open();
    a.close();
    expect(a.isOpen()).toBe(false);
    expect(a.announce('spk-1').adopted).toBe(false);
  });
});

// The window has to be CONSULTED, not merely opened. It was instantiated and
// `patch hosts pair-device` opened it, but the control socket's auth path
// refused every unregistered device unconditionally — so the command was
// ceremony and no device could ever be adopted.
describe('the adoption window admits a device (spec/16 § Adoption)', () => {
  it('refuses an unknown device while no window is open', () => {
    const a = new DeviceAdoption();
    const out = a.announce('dev-1');
    expect(out.adopted).toBe(false);
    expect(out.reason).toContain('no adoption window is open');
  });

  it('adopts an unknown device inside an open window', () => {
    const a = new DeviceAdoption();
    a.open();
    expect(a.announce('dev-1').adopted).toBe(true);
  });

  it('one window adopts ONE device — a second is refused, not silently swapped', () => {
    const a = new DeviceAdoption();
    a.open();
    expect(a.announce('dev-1').adopted).toBe(true);
    const second = a.announce('dev-2');
    expect(second.adopted).toBe(false);
    expect(second.reason).toBeTruthy();
  });

  it('the window expires, so a late device is refused', () => {
    let t = 1_000;
    const a = new DeviceAdoption(() => t, 5 * 60 * 1000);
    a.open();
    t += 5 * 60 * 1000 + 1;
    expect(a.announce('dev-1').adopted).toBe(false);
  });
});
