// PatchWs dispatch for the frames the reorganised Settings depends on:
//   - `host.removed` — the server dropped a machine from the account (Settings
//     → Hosts → Remove on ANY surface); every surface forgets it.
//   - a `chat.error` with code `claude_settings_invalid` — a host refused a
//     settings.json / memory edit. It is out-of-band, with no real chat behind
//     it, so it must reach the person as a toast and must NOT conjure a phantom
//     chat row nobody opens.
// Driven through a fake WebSocket exactly as ws.test.ts does.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, setActiveWs, STORE_BATCH_MS } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { reportHost } from './presenceHelpers.js';

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
  useUiStore.getState().clearToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setActiveWs(null);
});

describe('PatchWs dispatch — host.removed', () => {
  it('drops that host from the presence store and leaves the others', async () => {
    const { ws, fake } = await connectAndOpen();
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });
    fake.receive({ type: 'daemon.online', daemonId: 'host-a' });
    expect(usePresenceStore.getState().daemonOnline).toBe(true);

    fake.receive({ type: 'host.removed', daemonId: 'host-a' });

    const { hosts, daemonOnline } = usePresenceStore.getState();
    expect(hosts['host-a']).toBeUndefined();
    expect(hosts['host-b']?.host?.hostName).toBe('beta');
    expect(daemonOnline).toBe(false);
    expect(useUiStore.getState().errors).toHaveLength(0);
    ws.close();
  });

  it('for a host this surface never knew is a quiet no-op', async () => {
    const { ws, fake } = await connectAndOpen();
    reportHost('host-a', { hostName: 'laptop' });
    fake.receive({ type: 'host.removed', daemonId: 'host-nope' });
    expect(Object.keys(usePresenceStore.getState().hosts)).toEqual(['host-a']);
    expect(useUiStore.getState().errors).toHaveLength(0);
    ws.close();
  });
});

describe('PatchWs dispatch — chat.error claude_settings_invalid', () => {
  it('says the host’s refusal as an error toast and touches no chat state', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();
    const chatsBefore = useChatStore.getState().chats;
    const timelinesBefore = useChatStore.getState().timelines;

    fake.receive({
      type: 'chat.error',
      chatId: 'claude-settings-host-a',
      seq: -1,
      error: {
        code: 'claude_settings_invalid',
        message: 'settings.json is not valid JSON: Unexpected token } at position 14',
      },
    });
    vi.advanceTimersByTime(STORE_BATCH_MS * 2);

    const errors = useUiStore.getState().errors;
    expect(errors.map((e) => e.message)).toEqual([
      'settings.json is not valid JSON: Unexpected token } at position 14',
    ]);
    expect(errors[0]?.level).toBe('error');
    const { chats, timelines } = useChatStore.getState();
    expect(chats['claude-settings-host-a']).toBeUndefined();
    expect(timelines['claude-settings-host-a']).toBeUndefined();
    expect(chats).toBe(chatsBefore);
    expect(timelines).toBe(timelinesBefore);
    ws.close();
    // Nothing was left in the batch queue for close() to flush either.
    expect(useChatStore.getState().chats['claude-settings-host-a']).toBeUndefined();
  });

  it('a chat.error with any other code still lands on its chat', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();

    fake.receive({
      type: 'chat.error',
      chatId: 'c1',
      seq: 4,
      error: { code: 'folder_not_found', message: 'no such folder: /work/gone' },
    });
    vi.advanceTimersByTime(STORE_BATCH_MS);

    expect(useChatStore.getState().chats['c1']).toBeDefined();
    expect(useChatStore.getState().chats['c1']?.lastSeq).toBe(4);
    expect((useChatStore.getState().timelines['c1'] ?? []).length).toBeGreaterThan(0);
    ws.close();
  });
});
