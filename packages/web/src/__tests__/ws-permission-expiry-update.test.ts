// spec/02 § Questions are not approvals: `chat.permission_expiry_update`
// moves an already-drawn question card's countdown to a fresh deadline the
// host just reset (`chat.focus_change` touched its chat). Same dispatch
// shape as `ws-voice-permission.test.ts`'s `chat.permission_response` case.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PatchWs, STORE_BATCH_MS } from '../api/ws.js';
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

const QUESTION = {
  type: 'chat.permission_request',
  chatId: 'c1',
  requestId: 'req-1',
  request: { tool: 'AskUserQuestion', args: { questions: [] } },
  seq: 3,
  expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
};

function settleStoreBatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, STORE_BATCH_MS + 5));
}

function cardExpiry(): { at: number; windowMs: number } | undefined {
  const entry = useChatStore.getState().timelines['c1']?.find((e) => e.kind === 'permission');
  return (entry as { permissionExpiry?: { at: number; windowMs: number } } | undefined)
    ?.permissionExpiry;
}

describe('ws chat.permission_expiry_update', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    /* no globals stubbed here beyond WebSocket, replaced fresh each test */
  });

  it('moves the card to the reset deadline once it is already in the timeline', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.receive(QUESTION);
    await settleStoreBatch();
    expect(cardExpiry()).toEqual({ at: 1_700_000_060_000, windowMs: 60_000 });

    fake.receive({
      type: 'chat.permission_expiry_update',
      chatId: 'c1',
      requestId: 'req-1',
      expiry: { at: 1_700_000_120_000, windowMs: 60_000 },
      seq: 4,
    });
    expect(cardExpiry()).toEqual({ at: 1_700_000_120_000, windowMs: 60_000 });
    ws.close();
  });

  it('still lands correctly when the request and the reset arrive in the same batch window', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    // Deliberately no settle between the two — the reset must not race ahead
    // of the request that creates the card it is meant to update.
    fake.receive(QUESTION);
    fake.receive({
      type: 'chat.permission_expiry_update',
      chatId: 'c1',
      requestId: 'req-1',
      expiry: { at: 1_700_000_120_000, windowMs: 60_000 },
      seq: 4,
    });
    expect(cardExpiry()).toEqual({ at: 1_700_000_120_000, windowMs: 60_000 });
    ws.close();
  });
});
