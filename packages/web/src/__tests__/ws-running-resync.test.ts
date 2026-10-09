// A turn that is running on the open chat is re-synced from the cursor while
// it runs. The host records every event, but a live detail event that never
// reached this surface (a dropped subscription, a lost frame) left the pane
// frozen mid-turn with the spinner up until the user typed again. The replay
// both back-fills the missing events and re-subscribes the socket to the chat.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, RUNNING_RESYNC_MS } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 1;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(public url: string) {
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

const replays = (fake: FakeWS) =>
  fake.sent
    .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
    .filter((f) => f.type === 'chat.replay');

function seedChat(activity: 'running' | 'idle'): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'stuck',
      folder: 'foo',
      activity,
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
  useChatStore.setState({ activeChatId: 'c1' });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 105,
    tool: 'Bash',
    args: {},
    callId: 'k1',
  });
}

async function connect(): Promise<{ ws: PatchWs; fake: FakeWS }> {
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[0]!;
  fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
  return { ws, fake };
}

describe('PatchWs — running turn resync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  });
  afterEach(() => {
    vi.useRealTimers();
    useChatStore.getState()._reset();
  });

  it('re-asks the open chat for everything after its cursor while its turn is running', async () => {
    seedChat('running');
    const { ws, fake } = await connect();
    const before = replays(fake).length;
    vi.advanceTimersByTime(RUNNING_RESYNC_MS * 2);
    const after = replays(fake).slice(before);
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const r of after) expect(r).toMatchObject({ chatId: 'c1', fromSeq: 105 });
    ws.close();
  });

  it('stays quiet when the open chat is idle', async () => {
    seedChat('idle');
    const { ws, fake } = await connect();
    const before = replays(fake).length;
    vi.advanceTimersByTime(RUNNING_RESYNC_MS * 3);
    expect(replays(fake).length).toBe(before);
    ws.close();
  });

  it('stops asking once the socket is closed', async () => {
    seedChat('running');
    const { ws, fake } = await connect();
    ws.close();
    const before = fake.sent.length;
    vi.advanceTimersByTime(RUNNING_RESYNC_MS * 3);
    expect(fake.sent.length).toBe(before);
  });
});
