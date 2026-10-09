// spec/09 § Chat completion — the server's PresenceTracker replaces the whole
// record on every `auth.ok` (`online()`), so a reconnect silently wipes
// `lastFocusedChatId` until the surface navigates again. `auth.ok` must
// resend the currently-open chat itself so the desktop doorbell's
// focused-surface suppression doesn't go stale between navigations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PatchWs } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';

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

function focusFrames(fake: FakeWS): unknown[] {
  return fake.sent
    .map((s) => JSON.parse(s) as { type: string })
    .filter((f) => f.type === 'chat.focus_change');
}

describe('PatchWs — auth.ok resends the currently-open chat focus', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  });
  afterEach(() => {
    useChatStore.getState()._reset();
  });

  it('resends chat.focus_change for the chat already open when the socket (re)authenticates', async () => {
    useChatStore.setState({ activeChatId: 'c-open' });
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    expect(focusFrames(fake)).toContainEqual({ type: 'chat.focus_change', chatId: 'c-open' });
    ws.close();
  });

  it('resends chatId: null when no chat is open', async () => {
    useChatStore.setState({ activeChatId: null });
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    expect(focusFrames(fake)).toContainEqual({ type: 'chat.focus_change', chatId: null });
    ws.close();
  });

  // The server treats `chat.focus_change {chatId: null}` as "unsubscribe from
  // everything" and clears the socket's watched chats — including the chat the
  // open-time replay had just subscribed. The pane then kept whatever it held
  // while the chat moved on. The replay must be (re)asked AFTER the focus
  // frame so the live subscription is real.
  it('asks for the held chat replay after the focus frame, so the subscription survives', async () => {
    useChatStore.setState({ activeChatId: null });
    useChatStore.getState().hydrate([
      {
        chatId: 'c-held',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'held',
        folder: 'foo',
        activity: 'idle',
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
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c-held',
      seq: 3,
      tool: 'Bash',
      args: {},
      callId: 'k1',
    });
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
    const types = fake.sent.map((x) => JSON.parse(x) as { type: string; chatId?: string });
    const focusAt = types.findIndex((f) => f.type === 'chat.focus_change');
    const replayAfter = types.findIndex(
      (f, i) => i > focusAt && f.type === 'chat.replay' && f.chatId === 'c-held',
    );
    expect(focusAt).toBeGreaterThan(-1);
    expect(replayAfter).toBeGreaterThan(focusAt);
    ws.close();
  });
});
