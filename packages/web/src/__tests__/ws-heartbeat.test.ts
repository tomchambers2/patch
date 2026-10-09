// Surface heartbeat: spec/05 line 71 — surface emits surface.heartbeat
// every 10s while foregrounded. This test exercises the timer cadence + the
// document-visibility pause/resume contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, HEARTBEAT_INTERVAL_MS, HEARTBEAT_LIVENESS_TIMEOUT_MS } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

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

describe('PatchWs heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('emits surface.heartbeat every 10s once authenticated', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve(); // flush microtask "open"
    const fake = FakeWS.instances[0]!;
    // Server sends auth.ok; that triggers heartbeat start.
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    // Tick 35s — expect 3 heartbeats.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3 + 100);
    const heartbeats = fake.sent.filter((s) => s.includes('"surface.heartbeat"'));
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    ws.close();
  });

  it('pauses heartbeats when document hidden, resumes on visible', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 50);
    const beforeHide = fake.sent.filter((s) => s.includes('"surface.heartbeat"')).length;
    expect(beforeHide).toBeGreaterThanOrEqual(1);

    // Simulate background.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    const afterHide = fake.sent.filter((s) => s.includes('"surface.heartbeat"')).length;
    expect(afterHide).toBe(beforeHide); // no new heartbeats while hidden
    expect(fake.sent.some((s) => s.includes('"surface.backgrounded"'))).toBe(true);

    // Foreground again.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 50);
    const afterShow = fake.sent.filter((s) => s.includes('"surface.heartbeat"')).length;
    expect(afterShow).toBeGreaterThan(afterHide);
    expect(fake.sent.some((s) => s.includes('"surface.foregrounded"'))).toBe(true);
    ws.close();
  });

  it('background()/foreground() explicitly gate the heartbeat (menu-bar dropdown open/close)', async () => {
    // spec/05 ## Menu-bar surface: Electron BrowserWindow.hide() does NOT fire
    // the renderer visibilitychange, so the menu-bar surface drives these
    // directly off the popover show/hide IPC. background() must stop the beat;
    // foreground() must resume it — independent of document.hidden.
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 50);
    const afterOpen = fake.sent.filter((s) => s.includes('"surface.heartbeat"')).length;
    expect(afterOpen).toBeGreaterThanOrEqual(1);

    // Dropdown closed.
    ws.background();
    expect(fake.sent.some((s) => s.includes('"surface.backgrounded"'))).toBe(true);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    const afterClose = fake.sent.filter((s) => s.includes('"surface.heartbeat"')).length;
    expect(afterClose).toBe(afterOpen); // no new beats while closed

    // Dropdown reopened.
    ws.foreground();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 50);
    const afterReopen = fake.sent.filter((s) => s.includes('"surface.heartbeat"')).length;
    expect(afterReopen).toBeGreaterThan(afterClose);
    ws.close();
  });
});

// patch/todo.md "Test with slow, unreliable train internet": on flaky mobile
// data a socket can go HALF-OPEN — TCP silently dies, the browser never fires
// `close`, `readyState` stays OPEN — so the surface sits "connected" forever
// while nothing flows. The surface must detect this via missing heartbeat acks
// (the server pongs each heartbeat) and force-reconnect the zombie socket.
describe('PatchWs zombie-socket liveness watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    usePresenceStore.setState({ connection: 'offline' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('force-reconnects a half-open socket when heartbeat acks stop arriving', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve(); // flush microtask "open"
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    // The server pongs at least once — this ARMS the watchdog (proves the
    // server supports acks, so their absence is meaningful).
    fake.receive({ type: 'surface.heartbeat_ack' });
    expect(FakeWS.instances.length).toBe(1);

    // Train enters a tunnel: the socket goes half-open. No further inbound
    // frames, but readyState stays OPEN and no `close` ever fires on its own.
    vi.advanceTimersByTime(HEARTBEAT_LIVENESS_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS * 2);

    // The watchdog must have torn down the zombie socket and reconnected.
    expect(fake.readyState).toBe(3); // CLOSED
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2); // a fresh socket was opened
    ws.close();
  });

  it('does NOT reconnect while heartbeat acks keep arriving (healthy but slow link)', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });

    // Five heartbeat cycles, each answered by a pong — the link is alive.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      fake.receive({ type: 'surface.heartbeat_ack' });
    }

    expect(FakeWS.instances.length).toBe(1); // never reconnected
    expect(fake.readyState).toBe(1); // still OPEN
    ws.close();
  });

  it('does NOT force-reconnect before ever seeing an ack (server without pong support)', async () => {
    // Back-compat: if the server never pongs, the watchdog stays disarmed and
    // must never tear a working socket down on its own.
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    // No pong ever. Advance well past the liveness timeout.
    vi.advanceTimersByTime(HEARTBEAT_LIVENESS_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS * 3);
    expect(FakeWS.instances.length).toBe(1); // untouched
    expect(fake.readyState).toBe(1); // still OPEN
    ws.close();
  });
});

describe('PatchWs chat.replay cursor (I1-d1/d2)', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useChatStore.getState()._reset();
  });

  it('requests fromSeq=-1 for the open chat with no rendered timeline (so seq 0 is not skipped)', async () => {
    // A chat from GET /api/chats carries no stream state — emptyRow seeds
    // lastSeq:0 but the timeline is empty. chat.replay.fromSeq is EXCLUSIVE,
    // so replaying from 0 would drop the seq-0 user message (spec/12: pass -1
    // when the surface has seen nothing; 0 deliberately skips seq 0).
    // The chat is the OPEN one because a metadata-only roster row is no longer
    // replayed on connect at all (spec/12 § Cold start loads metadata only).
    useChatStore.getState().hydrate([
      {
        chatId: 'c-cold',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    useChatStore.getState().setActiveChat('c-cold');
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    const replay = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .find((e) => e.type === 'chat.replay' && e.chatId === 'c-cold');
    expect(replay).toBeDefined();
    expect(replay?.fromSeq).toBe(-1);
    ws.close();
  });

  it('requests fromSeq=<max durable seq> for a chat that already rendered events', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c-warm',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    // Render durable seq 0 and 1.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-warm',
      seq: 0,
      role: 'user',
      content: 'hi',
      ts: 1,
    } as never);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-warm',
      seq: 1,
      role: 'assistant',
      content: 'yo',
      ts: 2,
    } as never);
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    const replay = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .find((e) => e.type === 'chat.replay' && e.chatId === 'c-warm');
    expect(replay?.fromSeq).toBe(1);
    ws.close();
  });
});
