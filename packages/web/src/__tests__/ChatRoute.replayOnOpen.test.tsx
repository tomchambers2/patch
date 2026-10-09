// Regression: opening a chat that first appeared AFTER the socket connected
// (e.g. spawned on the phone, learned about via the always-on state-level
// fanout) must request its transcript on open. The connect-time replay loop
// only covers chats known when the socket opened; without a per-open replay
// such a chat renders "No messages yet" forever (spec/12 § Replay vs history
// cursors, spec/14 § Main chat panel).

import { it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { PatchWs, setActiveWs } from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

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
}

function replayFramesFor(fake: FakeWS, chatId: string): Array<{ fromSeq: number }> {
  return fake.sent
    .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
    .filter((e) => e.type === 'chat.replay' && e.chatId === chatId)
    .map((e) => ({ fromSeq: e.fromSeq as number }));
}

beforeEach(() => {
  FakeWS.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHostOnline('d1', true);
  setActiveWs(null);
});

afterEach(() => {
  cleanup();
  setActiveWs(null);
});

it('requests a replay when opening a chat that appeared after connect', async () => {
  const CHAT = 'c-from-phone';

  // 1. Socket connects with NO chats known yet — the connect-time replay loop
  //    has nothing to replay for this chat.
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;
  fake.open();
  expect(replayFramesFor(fake, CHAT)).toHaveLength(0);

  // 2. The chat now appears in the sidebar (state-level fanout from a spawn on
  //    another surface) — metadata + preview only, empty transcript.
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Petty Spurge Deep Dive',
      folder: 'portfolio',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);

  // 3. Opening it must request the transcript from scratch (fromSeq -1).
  render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );

  // Awaited, not synchronous: opening a chat now reads this device's cached
  // transcript first (spec/12 § Cold start) and only then asks the host, so
  // the ask carries a cursor past whatever the device already holds instead
  // of -1. With nothing cached — this test — the ask is the same one it
  // always was, a tick later.
  await waitFor(() => expect(replayFramesFor(fake, CHAT)).toHaveLength(1));
  expect(replayFramesFor(fake, CHAT)[0]!.fromSeq).toBe(-1);
});

// The other half of the same seam. A COLD start opens a chat before the socket
// is up: ChatRoute mounts and asks for the transcript, then the socket finishes
// connecting and the connect-time loop asks again for every held chat — the
// active chat included, its timeline still empty. Both requests computed
// `fromSeq: -1`, the host honoured both, and the entire transcript arrived
// twice, putting two of every message on screen.
it('asks for a chat’s transcript once when open and connect race on a cold start', async () => {
  const CHAT = 'c-cold-open';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const fake = FakeWS.instances[FakeWS.instances.length - 1]!;

  // Open the chat BEFORE the socket is up — the cold-start order.
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Cold open',
      folder: 'portfolio',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.getState().setActiveChat(CHAT);
  render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
  fake.open();

  expect(replayFramesFor(fake, CHAT)).toHaveLength(1);
});

// …but a genuine reconnect must still catch up, even from the same cursor: the
// previous request may have died with the old socket before a single event came
// back. The suppression is per-connection, not for all time.
it('asks again from the same cursor after a reconnect', async () => {
  const CHAT = 'c-reconnect';
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  await Promise.resolve();
  const first = FakeWS.instances[FakeWS.instances.length - 1]!;
  first.open();
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Reconnect',
      folder: 'portfolio',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.getState().setActiveChat(CHAT);
  ws.requestReplay(CHAT);
  expect(replayFramesFor(first, CHAT)).toHaveLength(1);

  // The socket drops before any event arrives; a new one comes up.
  first.emit('close', { code: 1006, reason: '' });
  ws.reconnectNow();
  await Promise.resolve();
  const second = FakeWS.instances[FakeWS.instances.length - 1]!;
  second.open();
  ws.requestReplay(CHAT);

  expect(replayFramesFor(second, CHAT)).toHaveLength(1);
});
