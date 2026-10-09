// spec/09 § Presence heuristic — the surface reports how long since the user
// last touched the computer, every 15s, whether or not Patch is on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs } from '../api/ws.js';
import {
  INPUT_REPORT_INTERVAL_MS,
  __setLastPageInputAt,
  listenForPageInput,
  readInputReport,
} from '../lib/inputPresence.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  url: string;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(name: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener(): void {}
  emit(name: string, data: unknown): void {
    for (const cb of this.listeners[name] ?? []) cb(data as MessageEvent);
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

const inputs = (f: FakeWS) =>
  f.sent.filter((s) => s.includes('"surface.input"')).map((s) => JSON.parse(s));

describe('input presence', () => {
  afterEach(() => {
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('in a browser, reports time since input on this page', async () => {
    __setLastPageInputAt(1_000);
    expect(await readInputReport(31_000)).toEqual({
      type: 'surface.input',
      idleMs: 30_000,
      scope: 'page',
    });
  });

  it('a key press on the page resets it', async () => {
    listenForPageInput();
    __setLastPageInputAt(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    const { idleMs } = await readInputReport(Date.now());
    expect(idleMs).toBeLessThan(1000);
  });

  it('in the desktop app, reports input anywhere on the machine', async () => {
    (window as unknown as { patch: unknown }).patch = { getSystemIdleMs: async () => 4200.4 };
    __setLastPageInputAt(0);
    expect(await readInputReport(10 * 60_000)).toEqual({
      type: 'surface.input',
      idleMs: 4200,
      scope: 'system',
    });
  });

  it('a shell that fails to say is an error, not the page answer in disguise', async () => {
    (window as unknown as { patch: unknown }).patch = {
      getSystemIdleMs: async () => {
        throw new Error('ipc gone');
      },
    };
    await expect(readInputReport()).rejects.toThrow('ipc gone');
  });
});

describe('PatchWs input reports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    (window as unknown as { patch: unknown }).patch = { getSystemIdleMs: async () => 3000 };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { patch?: unknown }).patch;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('reports on auth, then every 15s — and keeps going while the window is hidden', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    await vi.advanceTimersByTimeAsync(10);
    expect(inputs(fake)).toEqual([{ type: 'surface.input', idleMs: 3000, scope: 'system' }]);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(INPUT_REPORT_INTERVAL_MS * 2 + 10);
    expect(inputs(fake)).toHaveLength(3);
    ws.close();
  });

  it('stops reporting once closed', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    await vi.advanceTimersByTimeAsync(10);
    ws.close();
    const n = inputs(fake).length;
    await vi.advanceTimersByTimeAsync(INPUT_REPORT_INTERVAL_MS * 3);
    expect(inputs(fake)).toHaveLength(n);
  });
});
