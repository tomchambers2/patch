import { describe, it, expect, afterEach } from 'vitest';
import { getDesktopBridge } from '../lib/desktopBridge.js';

afterEach(() => {
  delete (window as unknown as { patch?: unknown }).patch;
});

describe('getDesktopBridge', () => {
  it('returns undefined when window.patch is not set', () => {
    expect(getDesktopBridge()).toBeUndefined();
  });

  it('returns window.patch when set (Electron preload surface)', () => {
    const bridge = { openChat: () => {} };
    (window as unknown as { patch?: unknown }).patch = bridge;
    expect(getDesktopBridge()).toBe(bridge);
  });
});
