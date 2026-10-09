// PatchWs dispatch for server-owned composer drafts (spec/14 § Composer):
//   - `composer_draft.list` — the cold-start snapshot, sent once after auth.ok
//   - `composer_draft.updated` / `composer_draft.cleared` — live per-chat
//   - `auth.ok` also flushes any draft the server never confirmed
// Driven through a fake WebSocket exactly as ws-settings-events.test.ts does.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, setActiveWs } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  url: string;
  sent: string[] = [];
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
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
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

async function connectAndOpen(url = 'ws://test/ws'): Promise<{ ws: PatchWs; fake: FakeWS }> {
  const ws = new PatchWs(url);
  // Mirrors AppShell.tsx: setActiveWs before connect, so a handler running
  // off the very first frame (auth.ok's reconnect-flush) can reach it.
  setActiveWs(ws);
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.open();
  return { ws, fake };
}

beforeEach(() => {
  FakeWS.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  useChatStore.getState()._reset();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'offline',
    daemonOnline: false,
    wsUrl: null,
    everConnected: false,
    failedAttempts: 0,
    lastClose: null,
    accountId: null,
    surfaceId: null,
    hosts: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setActiveWs(null);
});

function authOk(fake: FakeWS): void {
  fake.receive({ type: 'auth.ok', accountId: 'acc', surfaceId: 'srf', hosts: [] });
}

describe('PatchWs dispatch — composer_draft.list', () => {
  it('seeds every draft the account currently has', async () => {
    const { ws, fake } = await connectAndOpen();
    authOk(fake);
    fake.receive({
      type: 'composer_draft.list',
      drafts: [
        { chatId: 'c1', text: 'first', updatedAt: 1 },
        { chatId: 'c2', text: 'second', updatedAt: 2 },
      ],
    });
    expect(useComposerDraftStore.getState().drafts).toEqual({ c1: 'first', c2: 'second' });
    ws.close();
  });
});

describe('PatchWs dispatch — composer_draft.updated / composer_draft.cleared', () => {
  it('an update from another surface appears live', async () => {
    const { ws, fake } = await connectAndOpen();
    authOk(fake);
    fake.receive({
      type: 'composer_draft.updated',
      chatId: 'c1',
      text: 'typed elsewhere',
      updatedAt: 5,
    });
    expect(useComposerDraftStore.getState().get('c1')).toBe('typed elsewhere');
    ws.close();
  });

  it('a clear from another surface empties this one’s copy', async () => {
    const { ws, fake } = await connectAndOpen();
    authOk(fake);
    useComposerDraftStore.getState().applyDraftUpdated('c1', 'hello', 1);
    fake.receive({ type: 'composer_draft.cleared', chatId: 'c1', updatedAt: 5 });
    expect(useComposerDraftStore.getState().get('c1')).toBe('');
    ws.close();
  });
});

describe('PatchWs — auth.ok flushes drafts the server never confirmed', () => {
  it('resends a draft typed before this connection existed', async () => {
    vi.useFakeTimers();
    useComposerDraftStore.getState().setDraft('c1', 'typed while offline');
    const { ws, fake } = await connectAndOpen();
    authOk(fake);
    const sent = fake.sent.map((s) => JSON.parse(s) as { type: string });
    expect(
      sent.some(
        (e) => e.type === 'composer_draft.set' && (e as { chatId?: string }).chatId === 'c1',
      ),
    ).toBe(true);
    ws.close();
  });
});
