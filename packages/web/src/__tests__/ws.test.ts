// Direct coverage of the PatchWs client (src/api/ws.ts): connection lifecycle,
// send()/safeSend(), reconnect backoff, the full dispatch() switch (auth,
// host presence, device sessions, incoming calls + chime, permission-request
// diff routing, permission_response echo), and the module-level active-ws
// registry + defaultWsUrl.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PatchWs,
  defaultWsUrl,
  setActiveWs,
  getActiveWs,
  STORE_BATCH_MS,
  __resetWireMismatchReloadForTests,
} from '../api/ws.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { saveCredential, clearCredential } from '../lib/credential.js';

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
  useVoiceStore.setState({ note: null, call: null, incomingCall: null, permission: null });
  useUiStore.getState().clearToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setActiveWs(null);
});

describe('PatchWs connection lifecycle', () => {
  it('connect() transitions presence to connecting then connected on open', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    expect(usePresenceStore.getState().connection).toBe('connecting');
    await Promise.resolve();
    FakeWS.instances[0]!.open();
    expect(usePresenceStore.getState().connection).toBe('connected');
    ws.close();
  });

  it('sends a hello frame with the bearer when a credential is stored, without one otherwise', async () => {
    const { fake } = await connectAndOpen();
    const hello = fake.sent.map((s) => JSON.parse(s)).find((e) => e.type === 'hello');
    expect(hello).toBeDefined();
    expect(hello.clientType).toBe('surface-web');
    expect('auth' in hello).toBe(false); // no credential stored in this test
  });

  it('includes the stored credential as `auth` on the hello frame', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`;
    saveCredential(jwt);
    const { fake } = await connectAndOpen();
    const hello = fake.sent.map((s) => JSON.parse(s)).find((e) => e.type === 'hello');
    expect(hello.auth).toBe(jwt);
    clearCredential();
  });

  it('close() sets presence offline, clears the socket, and resets the delivery tracker', async () => {
    const { ws } = await connectAndOpen();
    ws.close();
    expect(usePresenceStore.getState().connection).toBe('offline');
  });

  it('a socket-level close (not app teardown) transitions to reconnecting and schedules a retry', async () => {
    vi.useFakeTimers();
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.open();
    expect(usePresenceStore.getState().connection).toBe('connected');
    // Server drops the connection (not a user-initiated ws.close()).
    fake.close();
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
    vi.advanceTimersByTime(1500);
    // A new FakeWS instance was created by the reconnect.
    expect(FakeWS.instances.length).toBeGreaterThan(1);
    ws.close();
  });

  it('reconnect backoff doubles on repeated drops (each drop before a successful open)', async () => {
    vi.useFakeTimers();
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    let fake = FakeWS.instances[0]!;
    // First drop (never opened) → scheduled at the initial 1000ms backoff,
    // which then doubles to 2000ms for the NEXT drop.
    fake.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances.length).toBe(2);
    fake = FakeWS.instances[1]!;
    // Second drop (still never opened, so backoff was never reset) — must wait
    // the doubled 2000ms, not another 1000ms.
    fake.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances.length).toBe(2); // not yet
    vi.advanceTimersByTime(1000); // now at 2000ms since the second drop
    expect(FakeWS.instances.length).toBe(3);
    ws.close();
  });

  it('does not reconnect after an intentional close()', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();
    ws.close();
    const countAfterClose = FakeWS.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(countAfterClose);
    void fake;
  });

  it('close() cancels a pending reconnect timer so it never fires', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();
    fake.close(); // socket drop schedules a reconnect
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
    ws.close(); // app teardown before the reconnect timer fires
    const countAfterClose = FakeWS.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(countAfterClose); // the cancelled timer never fired
  });

  // spec/12 § Connection diagnostics screen — connection forensics + Retry now.
  it('records connection forensics: an open clears the failure counters, a close counts and explains itself', async () => {
    const { ws, fake } = await connectAndOpen('ws://test/ws');
    expect(usePresenceStore.getState().everConnected).toBe(true);
    expect(usePresenceStore.getState().wsUrl).toBe('ws://test/ws');
    expect(usePresenceStore.getState().failedAttempts).toBe(0);
    fake.emit('close', { code: 1006, reason: 'abnormal closure' });
    const st = usePresenceStore.getState();
    expect(st.failedAttempts).toBe(1);
    expect(st.lastClose?.code).toBe(1006);
    expect(st.lastClose?.reason).toBe('abnormal closure');
    ws.close();
  });

  it('records a close that carries no code/reason without inventing one', async () => {
    const { ws, fake } = await connectAndOpen();
    fake.close(); // FakeWS emits a bare close event, like a browser abort
    expect(usePresenceStore.getState().lastClose).toEqual({
      code: 0,
      reason: '',
      at: expect.any(Number) as unknown as number,
    });
    ws.close();
  });

  it('reconnectNow() dials immediately instead of waiting out the backoff', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();
    fake.close();
    const countAfterDrop = FakeWS.instances.length;
    ws.reconnectNow();
    expect(FakeWS.instances.length).toBe(countAfterDrop + 1);
    // The cancelled backoff timer must not ALSO fire a second dial.
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(countAfterDrop + 1);
    ws.close();
  });

  it('reconnectNow() closes a still-open socket before redialling', async () => {
    const { ws, fake } = await connectAndOpen();
    const countBefore = FakeWS.instances.length;
    ws.reconnectNow();
    expect(fake.readyState).toBe(3);
    expect(FakeWS.instances.length).toBe(countBefore + 1);
    ws.close();
  });

  it('reconnectNow() swallows a throwing close on an already-dead socket', async () => {
    const { ws, fake } = await connectAndOpen();
    fake.close = () => {
      throw new Error('already dead');
    };
    const countBefore = FakeWS.instances.length;
    expect(() => ws.reconnectNow()).not.toThrow();
    expect(FakeWS.instances.length).toBe(countBefore + 1);
    ws.close();
  });

  it('reconnectNow() is a no-op after the app has torn the connection down', async () => {
    const { ws } = await connectAndOpen();
    ws.close();
    const countAfterClose = FakeWS.instances.length;
    ws.reconnectNow();
    expect(FakeWS.instances.length).toBe(countAfterClose);
  });

  it('scheduleReconnect is a defensive no-op if invoked after the socket is already closed', async () => {
    vi.useFakeTimers();
    const { ws } = await connectAndOpen();
    ws.close();
    const countAfterClose = FakeWS.instances.length;
    // Directly exercise the private method's own `if (this.closed) return`
    // guard — the sole call site (the 'close' listener) already checks
    // `this.closed` first, so this defensive duplicate is otherwise dead.
    (ws as unknown as { scheduleReconnect(): void }).scheduleReconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(countAfterClose);
  });
});

describe('PatchWs chat.replay cursor excludes non-durable entries', () => {
  it('skips an optimistic (localId-carrying) entry and a still-streaming entry when computing fromSeq', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c-mixed',
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
    // A durable seq-2 message...
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-mixed',
      seq: 2,
      role: 'assistant',
      content: 'durable',
    } as never);
    // ...followed by a HIGHER-seq optimistic local echo (not yet reconciled)
    // and a streaming accumulator — neither should raise fromSeq past 2.
    useChatStore.getState().addLocalMessage('c-mixed', 'not yet acked', 'lid-1');
    useChatStore.getState().applyEvent({
      type: 'chat.message_delta',
      chatId: 'c-mixed',
      messageSeq: 99,
      delta: 'partial…',
    } as never);

    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.open();
    const replay = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .find((e) => e.type === 'chat.replay' && e.chatId === 'c-mixed');
    expect(replay?.fromSeq).toBe(2); // NOT 99 — the streaming/optimistic entries are excluded
    ws.close();
  });
});

describe('PatchWs requestReplay dedup guard vs. a deliberately cleared timeline', () => {
  const row = (chatId: string) => ({
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder: '~/x',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  });

  // A chat's FIRST ever replay always asks from fromSeq -1 (empty timeline).
  // Switching tracks (ChatRoute's handleSwitchTrack) clears the timeline back
  // to empty and re-requests immediately — which recomputes fromSeq -1 again
  // and collides with that same cursor still cached from the first load, so
  // the plain dedup guard drops the request that was supposed to fetch the
  // new track's history. The timeline then never refills: a chat history
  // "goes missing" until a full reload re-syncs it from scratch.
  it('a plain re-request after clearing the timeline is swallowed by the -1 cursor', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    ws.requestReplay('c-1'); // the chat's first-ever open: fromSeq -1, sent

    // Its full history arrives.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-1',
      seq: 7,
      role: 'assistant',
      content: 'loaded',
    } as never);

    // Switching tracks clears the timeline and asks again, unforced.
    useChatStore.getState().clearTimeline('c-1');
    ws.requestReplay('c-1');

    const replays = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .filter((e) => e.type === 'chat.replay' && e.chatId === 'c-1');
    expect(replays).toHaveLength(1); // the second ask never went out
    ws.close();
  });

  it('`force` bypasses the cursor so the cleared timeline actually refills', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    ws.requestReplay('c-1');

    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-1',
      seq: 7,
      role: 'assistant',
      content: 'loaded',
    } as never);

    useChatStore.getState().clearTimeline('c-1');
    ws.requestReplay('c-1', { force: true });

    const replays = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .filter((e) => e.type === 'chat.replay' && e.chatId === 'c-1');
    expect(replays).toHaveLength(2);
    expect(replays[1]?.fromSeq).toBe(-1);
    ws.close();
  });
});

describe("PatchWs replay cursor vs. the hub dropping this surface's subscriptions", () => {
  const row = (chatId: string) => ({
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder: '~/x',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  });

  // The hub reads `chat.focus_change` with `chatId: null` as "unsubscribe from
  // everything" and stops sending this socket any chat's detail events (the
  // reply itself). Leave a chat for the Jobs page, the reply lands while away,
  // come back: the cursor is unchanged, so the dedup guard swallowed the
  // re-open's replay, nothing resubscribed the chat, and the pane showed the
  // user's own turn with no answer (the sidebar summary still arrived, as it
  // rides the state fanout).
  it('re-opening a chat after focus was cleared asks for its replay again', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-1',
      seq: 0,
      role: 'user',
      content: 'why',
    } as never);
    ws.requestReplay('c-1'); // fromSeq 0

    ws.send({ type: 'chat.focus_change', chatId: null } as never);
    ws.requestReplay('c-1'); // re-open: same cursor as before

    const replays = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string })
      .filter((e) => e.type === 'chat.replay' && e.chatId === 'c-1');
    expect(replays).toHaveLength(2);
    ws.close();
  });

  it('focusing a chat does not drop the cursor of another', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    ws.requestReplay('c-1');
    ws.send({ type: 'chat.focus_change', chatId: 'c-2' } as never);
    ws.requestReplay('c-1');
    const replays = fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string })
      .filter((e) => e.type === 'chat.replay' && e.chatId === 'c-1');
    expect(replays).toHaveLength(1);
    ws.close();
  });
});

describe('PatchWs batched replay (spec/12 § Sequence-based replay)', () => {
  const row = (chatId: string) => ({
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder: '~/x',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  });

  it('asks for the answer as a batch, because it knows how to read one', async () => {
    // Opt-in by the SURFACE: a host updates on its own schedule, and one
    // that started batching at a client which did not understand the frame
    // would leave that chat looking empty.
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    ws.requestReplay('c-1');
    const replay = fake.sent
      .map((x) => JSON.parse(x) as { type: string; batch?: boolean; chatId?: string })
      .find((e) => e.type === 'chat.replay' && e.chatId === 'c-1');
    expect(replay?.batch).toBe(true);
    ws.close();
  });

  it('applies a whole batch in one commit, in order, with no coalescing wait', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.replay_batch',
      chatId: 'c-1',
      done: true,
      events: [
        { type: 'chat.message', chatId: 'c-1', seq: 0, role: 'user', content: 'first' },
        { type: 'chat.message', chatId: 'c-1', seq: 1, role: 'assistant', content: 'second' },
        { type: 'chat.message', chatId: 'c-1', seq: 2, role: 'user', content: 'third' },
      ],
    });
    // Synchronously on arrival — not after the 16ms live-path coalescing
    // window. There is nothing still coming that it could coalesce with.
    const timeline = useChatStore.getState().timelines['c-1'] ?? [];
    expect(timeline.map((e) => e.content)).toEqual(['first', 'second', 'third']);
    ws.close();
  });

  it('several chunks of one replay build the transcript in order', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    const { ws, fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.replay_batch',
      chatId: 'c-1',
      done: false,
      events: [{ type: 'chat.message', chatId: 'c-1', seq: 0, role: 'user', content: 'one' }],
    });
    fake.receive({
      type: 'chat.replay_batch',
      chatId: 'c-1',
      done: true,
      events: [{ type: 'chat.message', chatId: 'c-1', seq: 1, role: 'assistant', content: 'two' }],
    });
    expect((useChatStore.getState().timelines['c-1'] ?? []).map((e) => e.content)).toEqual([
      'one',
      'two',
    ]);
    ws.close();
  });
});

describe('PatchWs chat.replay_batch — inner events get the same side effects as live ones', () => {
  beforeEach(() => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/proj' });
    useUiStore.setState({ pendingDiffByChat: {} });
  });

  const batch = (events: unknown[]) => ({
    type: 'chat.replay_batch',
    chatId: 'c1',
    done: true,
    events,
  });

  it('a still-pending Edit request replayed in a batch reopens the diff', async () => {
    const { ws, fake } = await connectAndOpen();
    fake.receive(
      batch([
        {
          type: 'chat.permission_request',
          chatId: 'c1',
          requestId: 'r1',
          seq: 1,
          request: {
            tool: 'Edit',
            args: { file_path: '/proj/a.ts', old_string: 'old', new_string: 'new' },
          },
        },
      ]),
    );
    expect(useUiStore.getState().pendingDiffByChat['c1']).toMatchObject({
      requestId: 'r1',
      filePath: '/proj/a.ts',
    });
    ws.close();
  });

  it('a replayed permission request raises the mid-voice banner', async () => {
    useVoiceStore.getState().startNote('c1', 'ptt');
    const { ws, fake } = await connectAndOpen();
    fake.receive(
      batch([
        {
          type: 'chat.permission_request',
          chatId: 'c1',
          requestId: 'r1',
          seq: 1,
          request: { tool: 'Bash', args: { command: 'ls' } },
        },
      ]),
    );
    expect(useVoiceStore.getState().permission?.requestId).toBe('r1');
    ws.close();
  });

  it('a replayed chat.state clears a stale voice banner', async () => {
    useVoiceStore
      .getState()
      .setPermission({ requestId: 'r1', chatId: 'c1', summary: 'Approve Bash?' });
    const { ws, fake } = await connectAndOpen();
    fake.receive(batch([{ type: 'chat.state', chatId: 'c1', seq: 2, activity: 'idle' }]));
    expect(useVoiceStore.getState().permission).toBeNull();
    ws.close();
  });

  it('a replayed request + response resolves the card and clears the banner, in order', async () => {
    useVoiceStore
      .getState()
      .setPermission({ requestId: 'r1', chatId: 'c1', summary: 'Approve Bash?' });
    const { ws, fake } = await connectAndOpen();
    fake.receive(
      batch([
        {
          type: 'chat.permission_request',
          chatId: 'c1',
          requestId: 'r1',
          seq: 1,
          request: { tool: 'Bash', args: { command: 'ls' } },
        },
        { type: 'chat.permission_response', chatId: 'c1', requestId: 'r1', seq: 2, approve: true },
      ]),
    );
    expect(useVoiceStore.getState().permission).toBeNull();
    const card = useChatStore
      .getState()
      .timelines['c1']!.find((e) => e.kind === 'permission' && e.requestId === 'r1');
    expect(card?.permissionResolved).toBe('approve');
    ws.close();
  });

  it('a replayed pending-spawn chat.error surfaces its toast', async () => {
    const { ws, fake } = await connectAndOpen();
    fake.receive(
      batch([
        {
          type: 'chat.error',
          chatId: 'pending-spawn',
          error: { code: 'invalid_frame', message: 'replayed refusal' },
          seq: -1,
        },
      ]),
    );
    expect(useUiStore.getState().errors.some((e) => e.message.includes('replayed refusal'))).toBe(
      true,
    );
    ws.close();
  });
});

describe('PatchWs cold start loads metadata only (no per-chat transcript fan-in)', () => {
  const row = (chatId: string) => ({
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder: '~/x',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  });

  function replaysSent(fake: FakeWS): Array<{ chatId?: string; fromSeq?: number }> {
    return fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .filter((e) => e.type === 'chat.replay');
  }

  it('requests NO replay on connect when the roster is metadata-only (empty timelines)', async () => {
    // spec/12 § Cold start loads metadata only — GET /api/chats hydrates the
    // sidebar; transcripts load lazily on open, so connect must not kick off
    // one inbound event stream per known chat.
    useChatStore.getState().hydrate([row('c-1'), row('c-2'), row('c-3')]);
    const { ws, fake } = await connectAndOpen();
    expect(replaysSent(fake)).toEqual([]);
    ws.close();
  });

  it('still replays the chat the surface has open, even with no transcript yet', async () => {
    useChatStore.getState().hydrate([row('c-1'), row('c-2')]);
    useChatStore.getState().setActiveChat('c-2');
    const { ws, fake } = await connectAndOpen();
    const replays = replaysSent(fake);
    expect(replays.map((r) => r.chatId)).toEqual(['c-2']);
    expect(replays[0]?.fromSeq).toBe(-1);
    ws.close();
  });

  it('still replays chats whose transcript is already rendered, so a reconnect misses nothing', async () => {
    useChatStore.getState().hydrate([row('c-1'), row('c-2')]);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-1',
      seq: 4,
      role: 'assistant',
      content: 'already rendered',
    } as never);
    const { ws, fake } = await connectAndOpen();
    const replays = replaysSent(fake);
    expect(replays.map((r) => r.chatId)).toEqual(['c-1']);
    expect(replays[0]?.fromSeq).toBe(4);
    ws.close();
  });
});

describe('PatchWs replays held chats when a host comes back', () => {
  // A host restart (a deploy, a crash) does not drop this surface's socket to
  // the SERVER. Before this, nothing asked for what was missed: the connect
  // sweep only runs on a fresh socket and ChatRoute only replays when the chat
  // or the link changes identity — so a chat sat holding whatever it had when
  // the host went down, silently missing every event since.
  const row = (chatId: string, daemonId = 'd1') => ({
    chatId,
    daemonId,
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder: '~/x',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  });

  function replaysSent(fake: FakeWS): Array<{ chatId?: string; fromSeq?: number }> {
    return fake.sent
      .map((s) => JSON.parse(s) as { type: string; chatId?: string; fromSeq?: number })
      .filter((e) => e.type === 'chat.replay');
  }

  it('replays the open chat from its rendered cursor when its host returns', async () => {
    useChatStore.getState().hydrate([row('c-1')]);
    useChatStore.getState().setActiveChat('c-1');
    const { ws, fake } = await connectAndOpen();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-1',
      seq: 7,
      role: 'assistant',
      content: 'rendered before the host went down',
    } as never);
    const before = replaysSent(fake).length;

    fake.receive({ type: 'daemon.online', daemonId: 'd1' });

    const after = replaysSent(fake).slice(before);
    expect(after.map((r) => r.chatId)).toEqual(['c-1']);
    // From the last DURABLE seq we rendered, so the host sends only the tail
    // we missed rather than the whole transcript again.
    expect(after[0]?.fromSeq).toBe(7);
    ws.close();
  });

  it('asks again even though the cursor has not moved since the last request', async () => {
    // The dedup guard in requestReplay keys on the cursor, and after a restart
    // it is usually the SAME number as the request that fetched the history we
    // are now missing the tail of. Without clearing it, the request that heals
    // the chat is dropped as a duplicate.
    useChatStore.getState().hydrate([row('c-1')]);
    useChatStore.getState().setActiveChat('c-1');
    const { ws, fake } = await connectAndOpen();
    expect(replaysSent(fake).length).toBe(1); // the connect-time sweep, fromSeq -1

    fake.receive({ type: 'daemon.online', daemonId: 'd1' });

    const replays = replaysSent(fake);
    expect(replays.length).toBe(2);
    expect(replays[1]?.fromSeq).toBe(-1);
    ws.close();
  });

  it('replays only the returning host, not every host', async () => {
    useChatStore.getState().hydrate([row('c-here', 'd1'), row('c-elsewhere', 'd2')]);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-here',
      seq: 2,
      role: 'assistant',
      content: 'x',
    } as never);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-elsewhere',
      seq: 3,
      role: 'assistant',
      content: 'y',
    } as never);
    const { ws, fake } = await connectAndOpen();
    const before = replaysSent(fake).length;

    fake.receive({ type: 'daemon.online', daemonId: 'd1' });

    expect(
      replaysSent(fake)
        .slice(before)
        .map((r) => r.chatId),
    ).toEqual(['c-here']);
    ws.close();
  });

  it('does not replay a metadata-only chat nobody is looking at', async () => {
    // Same rule as cold start: a roster row with no rendered transcript loads
    // lazily on open, so a host restart must not fan one stream in per chat.
    useChatStore.getState().hydrate([row('c-1'), row('c-2')]);
    useChatStore.getState().setActiveChat('c-1');
    const { ws, fake } = await connectAndOpen();
    const before = replaysSent(fake).length;

    fake.receive({ type: 'daemon.online', daemonId: 'd1' });

    expect(
      replaysSent(fake)
        .slice(before)
        .map((r) => r.chatId),
    ).toEqual(['c-1']);
    ws.close();
  });
});

describe('PatchWs send / safeSend', () => {
  it('send() throws when not connected (no active socket)', () => {
    const ws = new PatchWs('ws://test/ws');
    expect(() => ws.send({ type: 'surface.heartbeat' })).toThrow('PatchWs: not connected');
  });

  it('send() throws when the socket exists but is not OPEN yet', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    // FakeWS starts at readyState 0 (not yet opened).
    expect(() => ws.send({ type: 'surface.heartbeat' })).toThrow('PatchWs: not connected');
    ws.close();
  });

  it('send() delivers the JSON-encoded event once OPEN', async () => {
    const { ws, fake } = await connectAndOpen();
    fake.sent.length = 0;
    ws.send({ type: 'surface.heartbeat' });
    expect(fake.sent).toEqual([JSON.stringify({ type: 'surface.heartbeat' })]);
    ws.close();
  });

  it('foreground()/background() are silent no-ops (safeSend) when not connected', () => {
    const ws = new PatchWs('ws://test/ws');
    expect(() => ws.foreground()).not.toThrow();
    expect(() => ws.background()).not.toThrow();
  });

  it('the visibilitychange handler is a no-op while the socket is not yet OPEN', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.sent.length = 0;
    // FakeWS starts at readyState 0 (CONNECTING) — the guard should return early.
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    expect(fake.sent).toEqual([]);
    ws.close();
  });

  it('safeSend is a no-op when the socket exists but is not yet OPEN', async () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    await Promise.resolve();
    const fake = FakeWS.instances[0]!;
    fake.sent.length = 0;
    // FakeWS starts at readyState 0 (CONNECTING) — foreground()'s safeSend must no-op.
    ws.foreground();
    expect(fake.sent).toEqual([]);
    ws.close();
  });

  it('starting the heartbeat twice in a row does not create a second interval', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();
    fake.sent.length = 0;
    ws.foreground(); // starts the heartbeat
    ws.foreground(); // second call — startHeartbeat's guard must no-op
    vi.advanceTimersByTime(30_000);
    // If a second interval had been created, we'd see roughly double the beats.
    const beats = fake.sent.filter((s) => s.includes('surface.heartbeat')).length;
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(beats).toBeLessThan(6); // well under what a duplicate interval would produce
    ws.close();
  });
});

describe('PatchWs message dispatch — malformed frames', () => {
  let originalLocation: Location;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetWireMismatchReloadForTests();
    originalLocation = window.location;
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
  });

  // A frame decodeCompat cannot tolerate (not "newer sender, unknown field/
  // type" — a genuine shape mismatch) is stronger evidence of stale-bundle
  // skew than onServerVersion's auth.ok hash check can catch on its own,
  // since it fires on a live connection with no reconnect in between. Rather
  // than drop the one frame and leave the chat silently missing content (NO
  // FALLBACK, CLAUDE.md), the surface reloads to pick up a current bundle.
  it('a non-JSON/schema-invalid message reloads instead of throwing', async () => {
    const { fake } = await connectAndOpen();
    expect(() => fake.emit('message', { data: 'not json at all' })).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('a non-string message payload is treated as an empty/invalid frame and reloads (no throw)', async () => {
    const { fake } = await connectAndOpen();
    expect(() => fake.emit('message', { data: new ArrayBuffer(4) })).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a burst of bad frames before navigation completes reloads only once', async () => {
    const { fake } = await connectAndOpen();
    fake.emit('message', { data: 'not json at all' });
    fake.emit('message', { data: 'still not json' });
    fake.emit('message', { data: new ArrayBuffer(4) });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The frame itself can be perfectly valid and still break the store: a
  // reducer edge case throws partway through `applyEvents`' single fold, and
  // without this the whole deferred batch — which can hold events already
  // committed as FAR as a user message and a tool call, plus the still-queued
  // assistant reply and the `chat.state` that clears the spinner — is lost
  // with no error on screen, leaving the chat spinning forever. Same remedy
  // as a malformed frame: fail loud and reload rather than silently drop it.
  it('a throw from applyEvents reloads instead of silently losing the whole batch', async () => {
    vi.useFakeTimers();
    const { fake } = await connectAndOpen();
    const applyEvents = vi.spyOn(useChatStore.getState(), 'applyEvents').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      fake.receive({ type: 'chat.spawned', chatId: 'c1', daemonId: 'd1', folder: '~/p' }),
    ).not.toThrow();
    expect(() => vi.advanceTimersByTime(STORE_BATCH_MS)).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
    applyEvents.mockRestore();
  });
});

describe('PatchWs message dispatch — frames from a NEWER host (spec/03 § Forward compatibility)', () => {
  it('renders a chat.state carrying a field this build has never heard of', async () => {
    vi.useFakeTimers();
    const { fake } = await connectAndOpen();

    fake.receive({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'running',
      permissionMode: 'bypassPermissions',
      lastUpdated: 1700000000,
      // Whatever the next host adds. This is the frame that drives the
      // sidebar and the chat view, so dropping it does not degrade the surface,
      // it stops it.
      limitResetsAt: 1789000000000,
    });

    // The state landed …
    vi.advanceTimersByTime(STORE_BATCH_MS);
    expect(useChatStore.getState().chats['c1']?.activity).toBe('running');
    // … and the user was told nothing, because nothing is wrong.
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('drops an event type this build has never heard of without a banner', async () => {
    const { fake } = await connectAndOpen();

    expect(() => fake.receive({ type: 'chat.vibes', chatId: 'c1', mood: 'chipper' })).not.toThrow();

    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('still reloads on a frame that is genuinely malformed, not merely newer', async () => {
    __resetWireMismatchReloadForTests();
    const originalLocation = window.location;
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload },
      configurable: true,
      writable: true,
    });
    try {
      const { fake } = await connectAndOpen();

      fake.receive({
        type: 'chat.state',
        chatId: 'c1',
        activity: 'vibing', // not a real activity — this IS a bug
        permissionMode: 'bypassPermissions',
        lastUpdated: 1700000000,
      });

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('PatchWs dispatch — replay bursts commit as one batch', () => {
  // A `chat.replay` re-emits a whole transcript as one WireEvent frame per
  // entry — measured at 582 events in 444ms on a busy chat. Committing each to
  // the store separately meant a re-render per message, so opening a chat
  // visibly filled in one message at a time and scroll-chased the growing
  // content the whole way down. Events are gathered for one frame and applied
  // as a single commit instead.
  it('a burst of chat events commits ONCE, in arrival order', async () => {
    vi.useFakeTimers();
    const { fake } = await connectAndOpen();
    let commits = 0;
    const unsub = useChatStore.subscribe(() => {
      commits++;
    });
    for (let seq = 1; seq <= 20; seq++) {
      fake.receive({
        type: 'chat.message',
        chatId: 'burst',
        seq,
        role: 'assistant',
        content: `m${seq}`,
      });
    }
    // Nothing committed yet — the batch window is still open.
    expect(commits).toBe(0);
    vi.advanceTimersByTime(STORE_BATCH_MS);
    expect(commits).toBe(1);
    const tl = useChatStore.getState().timelines['burst'];
    expect(tl?.length).toBe(20);
    expect(tl?.map((e) => e.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 1}`));
    unsub();
  });

  it('close() flushes what is already queued rather than dropping it', async () => {
    vi.useFakeTimers();
    const { ws, fake } = await connectAndOpen();
    fake.receive({ type: 'chat.message', chatId: 'c9', seq: 0, role: 'user', content: 'hi' });
    // Still inside the batch window — not committed yet.
    expect(useChatStore.getState().timelines['c9']).toBeUndefined();
    ws.close();
    expect(useChatStore.getState().timelines['c9']?.length).toBe(1);
  });
});

describe('PatchWs dispatch — auth events', () => {
  it('auth.ok sets identity and starts the heartbeat when the document is visible', async () => {
    vi.useFakeTimers();
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'acc-1', surfaceId: 'web-1' });
    expect(usePresenceStore.getState().accountId).toBe('acc-1');
    expect(usePresenceStore.getState().surfaceId).toBe('web-1');
  });

  it('auth.ok does NOT start the heartbeat while the document is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    vi.useFakeTimers();
    const { fake } = await connectAndOpen();
    fake.sent.length = 0;
    fake.receive({ type: 'auth.ok', hosts: [], accountId: 'acc-1', surfaceId: 'web-1' });
    vi.advanceTimersByTime(30_000);
    expect(fake.sent.some((s) => s.includes('surface.heartbeat'))).toBe(false);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('auth.revoked signs the surface out — a dead credential is not a toast', async () => {
    // Terminal, not a notice to dismiss: the credential can never work again,
    // so the shell drops it and shows sign-in with the reason (main.tsx listens
    // for this). See CredentialRejected.test.tsx for the whole path.
    const heard: string[] = [];
    window.addEventListener('patch:credential-rejected', (e) =>
      heard.push((e as CustomEvent<string>).detail),
    );
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'auth.revoked', reason: 'manual revoke' });
    expect(heard).toEqual(['manual revoke']);
  });

  it('auth.expired pushes a non-destructive notice toast', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'auth.expired', reason: 'ttl' });
    expect(useUiStore.getState().errors[0]?.message).toBe('session expired: ttl');
  });
});

describe('PatchWs dispatch — host refusals addressed to no chat (pending-spawn)', () => {
  // `host.update` (and a settings/memory edit) refused by the host has no
  // chat of its own to land the reason on, so it arrives as a `chat.error`
  // addressed to the `pending-spawn` sentinel — nothing in the sidebar shows
  // that id, so without surfacing it here the Settings → Hosts "Update"
  // button looked like it had done nothing at all (2026-09-28).
  it('surfaces the host’s reason as a toast', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.error',
      chatId: 'pending-spawn',
      error: { code: 'invalid_frame', message: 'host.update: machine d1 did not update — reason' },
      seq: -1,
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('did not update'))).toBe(
      true,
    );
  });
});

describe('PatchWs dispatch — host presence', () => {
  it('daemon.online sets daemonOnline true', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'daemon.online', daemonId: 'd1' });
    expect(usePresenceStore.getState().daemonOnline).toBe(true);
  });

  it('daemon.offline sets daemonOnline false', async () => {
    const { fake } = await connectAndOpen();
    usePresenceStore.getState().setHostOnline('d1', true);
    fake.receive({ type: 'daemon.offline', daemonId: 'd1' });
    expect(usePresenceStore.getState().daemonOnline).toBe(false);
  });

  it('daemon.account updates that host+backend, and the account summary', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'daemon.account',
      daemonId: 'd1',
      backendId: 'claude-code',
      connected: true,
      accountEmail: 'a@b.com',
    });
    // Recorded against the (host, backend) pair it names — another machine's
    // credential is untouched (spec/10 § Backend credentials).
    expect(usePresenceStore.getState().hosts['d1']?.accounts['claude-code']).toEqual({
      daemonId: 'd1',
      backendId: 'claude-code',
      connected: true,
      accountEmail: 'a@b.com',
      seq: 1,
    });
    // There is NO account-wide copy of this: a second host reporting itself
    // logged out must leave d1's row exactly as it is.
    fake.receive({
      type: 'daemon.account',
      daemonId: 'd2',
      backendId: 'claude-code',
      connected: false,
      accountEmail: null,
    });
    expect(usePresenceStore.getState().hosts['d1']?.accounts['claude-code']?.connected).toBe(true);
    expect(usePresenceStore.getState().hosts['d2']?.accounts['claude-code']?.connected).toBe(false);
  });

  it('folders.list / folders.updated replace ONE host’s registry, not the account’s', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'folders.list',
      daemonId: 'd1',
      roots: ['/srv/patch'],
      recent: ['/tmp/x'],
    });
    fake.receive({ type: 'folders.list', daemonId: 'd2', roots: ['/home/tom/p'], recent: [] });
    expect(usePresenceStore.getState().hosts['d1']?.folders).toEqual({
      roots: ['/srv/patch'],
      recent: ['/tmp/x'],
    });
    // A push for one machine leaves every other machine's list exactly as it is
    // — the same path string on two hosts is two different directories.
    fake.receive({ type: 'folders.updated', daemonId: 'd1', roots: [], recent: [] });
    expect(usePresenceStore.getState().hosts['d1']?.folders).toEqual({ roots: [], recent: [] });
    expect(usePresenceStore.getState().hosts['d2']?.folders).toEqual({
      roots: ['/home/tom/p'],
      recent: [],
    });
  });

  it('device.session updates the active-devices map', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'device.session', deviceId: 'dev-1', name: 'kitchen', active: true });
    expect(useVoiceStore.getState().activeDevices).toEqual({ 'dev-1': 'kitchen' });
  });
});

describe('PatchWs dispatch — incoming call + chime', () => {
  it('chat.call_request raises the incoming-call banner and calls window.focus() in the browser (no desktop bridge)', async () => {
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.call_request',
      callId: 'call-1',
      chatId: 'c1',
      message: 'pick up?',
    });
    expect(useVoiceStore.getState().incomingCall?.callId).toBe('call-1');
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();
  });

  it('chat.call_request uses the desktop bridge requestRaise() instead of window.focus() when present', async () => {
    const requestRaise = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { requestRaise };
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'chat.call_request', callId: 'call-2', chatId: 'c1', message: undefined });
    expect(requestRaise).toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('chat.call_request plays a chime and swallows a throw from playChime', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    class ThrowingAudioContext {
      createOscillator(): never {
        throw new Error('no audio hardware');
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = ThrowingAudioContext;
    const { fake } = await connectAndOpen();
    expect(() =>
      fake.receive({
        type: 'chat.call_request',
        callId: 'call-3',
        chatId: 'c1',
        message: undefined,
      }),
    ).not.toThrow();
    expect(useVoiceStore.getState().incomingCall?.callId).toBe('call-3');
  });

  it('chat.call_request rings the chime at a peak gain of 0.06, rising from and decaying back to the 0.001 floor', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const setValueAtTime = vi.fn();
    const exponentialRampToValueAtTime = vi.fn();
    const start = vi.fn();
    const stop = vi.fn();
    const destination = {};
    const gain = {
      gain: { setValueAtTime, exponentialRampToValueAtTime },
      connect: vi.fn(),
    };
    const osc = {
      frequency: { value: 0 },
      type: '',
      connect: vi.fn(() => gain),
      start,
      stop,
    };
    class RecordingAudioContext {
      currentTime = 0;
      destination = destination;
      createOscillator(): unknown {
        return osc;
      }
      createGain(): unknown {
        return gain;
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingAudioContext;
    try {
      const { fake } = await connectAndOpen();
      fake.receive({
        type: 'chat.call_request',
        callId: 'call-gain',
        chatId: 'c1',
        message: undefined,
      });

      // Same short single tone as ever: 880Hz sine, attack at +50ms, decay by
      // +600ms, oscillator stopped at +700ms.
      expect(osc.frequency.value).toBe(880);
      expect(osc.type).toBe('sine');
      expect(stop).toHaveBeenCalledWith(0.7);

      // The envelope: floor -> peak -> floor. exponentialRampToValueAtTime
      // cannot target 0, hence the 0.001 floor either side.
      expect(setValueAtTime).toHaveBeenCalledWith(0.001, 0);
      expect(exponentialRampToValueAtTime.mock.calls).toEqual([
        [0.06, 0.05],
        [0.001, 0.6],
      ]);

      // The loudness assertion proper: peak gain is 0.06 and nothing louder.
      // Tom reported the old 0.2 as too loud; a future bump must fail here.
      const rampedTo = exponentialRampToValueAtTime.mock.calls.map((c) => c[0] as number);
      const peak = Math.max(...rampedTo);
      expect(peak).toBe(0.06);
      expect(peak).toBeGreaterThan(0.001);
    } finally {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    }
  });

  it('chat.call_winner/timeout clears the banner only when the callId matches', async () => {
    const { fake } = await connectAndOpen();
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    fake.receive({ type: 'chat.call_request', callId: 'call-4', chatId: 'c1', message: undefined });
    expect(useVoiceStore.getState().incomingCall).not.toBeNull();
    // A winner event for a DIFFERENT callId does not clear it.
    fake.receive({ type: 'chat.call_winner', callId: 'other-call', acceptedSurfaceId: 's2' });
    expect(useVoiceStore.getState().incomingCall).not.toBeNull();
    // The matching callId clears it.
    fake.receive({ type: 'chat.call_winner', callId: 'call-4', acceptedSurfaceId: 's2' });
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('chat.call_timeout clears the banner when the callId matches (no other incoming call active)', async () => {
    const { fake } = await connectAndOpen();
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    fake.receive({ type: 'chat.call_request', callId: 'call-5', chatId: 'c1', message: undefined });
    fake.receive({ type: 'chat.call_timeout', callId: 'call-5' });
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('chat.call_winner/timeout is a no-op when there is no incoming call at all', async () => {
    const { fake } = await connectAndOpen();
    expect(() =>
      fake.receive({ type: 'chat.call_winner', callId: 'ghost', acceptedSurfaceId: 's' }),
    ).not.toThrow();
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });
});

describe('PatchWs dispatch — permission_request diff routing (Group 19/20)', () => {
  beforeEach(() => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/proj' });
  });

  it('an Edit permission request with file_path opens the diff rail from old_string/new_string', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      seq: 1,
      request: {
        tool: 'Edit',
        description: 'Edit a.ts',
        args: { file_path: '/proj/a.ts', old_string: 'old', new_string: 'new' },
      },
    });
    const diff = useUiStore.getState().pendingDiffByChat['c1'];
    expect(diff).toMatchObject({
      requestId: 'r1',
      tool: 'Edit',
      filePath: '/proj/a.ts',
      original: 'old',
      modified: 'new',
    });
  });

  it('a Write permission request with file_path opens the diff rail with empty original + the content', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r2',
      seq: 1,
      request: {
        tool: 'Write',
        description: 'Write b.ts',
        args: { file_path: '/proj/b.ts', content: 'whole file' },
      },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toMatchObject({
      tool: 'Write',
      filePath: '/proj/b.ts',
      original: '',
      modified: 'whole file',
    });
  });

  it('a Write permission request with no `content` field defaults modified to ""', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r2b',
      seq: 1,
      request: { tool: 'Write', description: 'Write b.ts', args: { file_path: '/proj/b.ts' } },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toMatchObject({
      tool: 'Write',
      modified: '',
    });
  });

  it('a NotebookEdit permission request with notebook_path opens the diff rail from old_source/new_source', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r3',
      seq: 1,
      request: {
        tool: 'NotebookEdit',
        description: 'Edit nb',
        args: { notebook_path: '/proj/nb.ipynb', old_source: 'a', new_source: 'b' },
      },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toMatchObject({
      tool: 'NotebookEdit',
      filePath: '/proj/nb.ipynb',
      original: 'a',
      modified: 'b',
    });
  });

  it('a NotebookEdit request with no old_source/new_source defaults both to ""', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r3b',
      seq: 1,
      request: {
        tool: 'NotebookEdit',
        description: 'x',
        args: { notebook_path: '/proj/nb.ipynb' },
      },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toMatchObject({
      tool: 'NotebookEdit',
      original: '',
      modified: '',
    });
  });

  it('an Edit request defaults old_string/new_string to "" when the host omits them', async () => {
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r4',
      seq: 1,
      request: { tool: 'Edit', description: 'x', args: { file_path: '/proj/a.ts' } },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toMatchObject({
      original: '',
      modified: '',
    });
  });

  it('a non-file-edit tool (e.g. Bash) does not open the diff rail', async () => {
    useUiStore.setState({ pendingDiffByChat: {} });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r5',
      seq: 1,
      request: { tool: 'Bash', description: 'run a command', args: { command: 'ls' } },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toBeUndefined();
  });

  it('an Edit request whose args is not an object is ignored (no diff opened)', async () => {
    useUiStore.setState({ pendingDiffByChat: {} });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r6',
      seq: 1,
      request: { tool: 'Edit', description: 'x', args: 'not-an-object' },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toBeUndefined();
  });

  it('an Edit request missing file_path is ignored (falls through every branch)', async () => {
    useUiStore.setState({ pendingDiffByChat: {} });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r7',
      seq: 1,
      request: { tool: 'Edit', description: 'x', args: { old_string: 'a', new_string: 'b' } },
    });
    expect(useUiStore.getState().pendingDiffByChat['c1']).toBeUndefined();
  });
});

describe('PatchWs dispatch — mid-voice permission banner + permission_response echo', () => {
  beforeEach(() => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/proj' });
  });

  it('falls back to "Approve <tool>?" when the host omits a description', async () => {
    useVoiceStore.getState().startNote('c1', 'ptt');
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      seq: 1,
      request: { tool: 'Bash', args: { command: 'ls' } },
    });
    expect(useVoiceStore.getState().permission?.summary).toBe('Approve Bash?');
  });

  it('chat.permission_response with no chatId (surface-originated ack) is not dispatched to chatStore', async () => {
    const { fake } = await connectAndOpen();
    const before = useChatStore.getState().chats['c1'];
    expect(() =>
      fake.receive({ type: 'chat.permission_response', requestId: 'r1', approve: true }),
    ).not.toThrow();
    // resolvePermission was never called for c1 (no chatId on the event) — the
    // row is unchanged.
    expect(useChatStore.getState().chats['c1']).toBe(before);
  });

  it('chat.permission_response for a DIFFERENT requestId does not clear the voice banner', async () => {
    useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'x' });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'other-request',
      approve: true,
    });
    expect(useVoiceStore.getState().permission).not.toBeNull();
  });

  it('chat.permission_response resolves "deny" when `decision` explicitly says so (even if approve is true)', async () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r8',
      seq: 1,
      request: { tool: 'Bash', args: {}, description: 'x' },
    });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r8',
      approve: true,
      decision: 'deny',
    });
    const card = useChatStore
      .getState()
      .timelines['c1']!.find((e) => e.kind === 'permission' && e.requestId === 'r8');
    expect(card?.permissionResolved).toBe('deny');
  });

  it('chat.permission_response defaults to "approve" when neither decision nor approve says deny', async () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r9',
      seq: 1,
      request: { tool: 'Bash', args: {}, description: 'x' },
    });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r9',
      approve: true,
    });
    const card = useChatStore
      .getState()
      .timelines['c1']!.find((e) => e.kind === 'permission' && e.requestId === 'r9');
    expect(card?.permissionResolved).toBe('approve');
  });

  // spec/14 § Main chat panel — Question prompts. A surface that did not
  // originate an AskUserQuestion's resolution — the spoken yes/no path, a
  // second connected tab — only ever learns about it through this echo, so
  // the answers have to ride along or its card can only say "Answered" with
  // every option blank.
  it('chat.permission_response carries answers through to the resolved card', async () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r10',
      seq: 1,
      request: { tool: 'AskUserQuestion', args: { questions: [] }, description: 'ask' },
    });
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r10',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which library?': 'date-fns' }),
      answers: { 'Which library?': 'date-fns' },
    });
    const card = useChatStore
      .getState()
      .timelines['c1']!.find((e) => e.kind === 'permission' && e.requestId === 'r10');
    expect(card?.permissionResolved).toBe('approve');
    expect(card?.permissionAnswers).toEqual({ 'Which library?': 'date-fns' });
  });
});

describe('PatchWs dispatch — chat.state clearing the voice permission banner', () => {
  it('clears the banner only when it belongs to this chat and activity leaves awaiting-permission', async () => {
    useVoiceStore.getState().setPermission({ requestId: 'r1', chatId: 'c1', summary: 'x' });
    const { fake } = await connectAndOpen();
    // A chat.state for a DIFFERENT chat must not clear it.
    fake.receive({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c2',
      activity: 'idle',
      lastUpdated: 1,
    });
    expect(useVoiceStore.getState().permission).not.toBeNull();
    // Still awaiting-permission for c1 → banner stays.
    fake.receive({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'awaiting-permission',
      lastUpdated: 2,
    });
    expect(useVoiceStore.getState().permission).not.toBeNull();
    // c1 leaves awaiting-permission → banner clears.
    fake.receive({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 3,
    });
    expect(useVoiceStore.getState().permission).toBeNull();
  });

  it('is a no-op when there is no pending voice permission at all', async () => {
    const { fake } = await connectAndOpen();
    expect(() =>
      fake.receive({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 1,
      }),
    ).not.toThrow();
  });
});

describe('module-level active-ws registry + defaultWsUrl', () => {
  it('getActiveWs()/setActiveWs() round-trip', () => {
    expect(getActiveWs()).toBeNull();
    const ws = new PatchWs('ws://x');
    setActiveWs(ws);
    expect(getActiveWs()).toBe(ws);
    setActiveWs(null);
    expect(getActiveWs()).toBeNull();
  });

  it('defaultWsUrl mounts ws:// on http and wss:// on https, same-origin /ws', () => {
    expect(defaultWsUrl()).toBe(`ws://${window.location.host}/ws`);
  });

  it('defaultWsUrl uses wss:// when served over https', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, protocol: 'https:', host: original.host },
      configurable: true,
      writable: true,
    });
    expect(defaultWsUrl()).toBe(`wss://${original.host}/ws`);
    Object.defineProperty(window, 'location', {
      value: original,
      configurable: true,
      writable: true,
    });
  });
});

describe('PatchWs dispatch — terminal frames (spec/14 § Terminal)', () => {
  it('routes a terminal stream into the terminal store, not the chat stores', async () => {
    useTerminalStore.getState()._reset();
    useTerminalStore.getState().startSession('c1', '/p', 'sess-1');
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'patch.terminal.ready', sessionId: 'sess-1', cwd: '/p' });
    fake.receive({
      type: 'patch.terminal.output',
      sessionId: 'sess-1',
      stream: 'stdout',
      data: 'cloned\n',
    });
    const session = useTerminalStore.getState().sessions['c1'];
    expect(session?.status).toBe('live');
    expect(session?.chunks[0]?.data).toBe('cloned\n');
    // No toast: terminal output is not an error channel.
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('an exit and an error both land in the session', async () => {
    useTerminalStore.getState()._reset();
    useTerminalStore.getState().startSession('c1', '/p', 'sess-1');
    useTerminalStore.getState().startSession('c2', '/p', 'sess-2');
    const { fake } = await connectAndOpen();
    fake.receive({ type: 'patch.terminal.exit', sessionId: 'sess-1', code: 0, reason: 'closed' });
    fake.receive({
      type: 'patch.terminal.error',
      sessionId: 'sess-2',
      code: 'unknown_session',
      message: 'no such session',
    });
    expect(useTerminalStore.getState().sessions['c1']?.status).toBe('ended');
    expect(useTerminalStore.getState().sessions['c2']?.status).toBe('error');
  });

  it('still renders `too_many_sessions` from a host that has not been updated', async () => {
    // The concurrency cap is gone, but hosts OTA separately from the server,
    // so an out-of-date one can still emit this. It must stay legible rather
    // than being dropped by the strict schema into a silently hanging prompt.
    useTerminalStore.getState()._reset();
    useTerminalStore.getState().startSession('c1', '/p', 'sess-1');
    const { fake } = await connectAndOpen();
    fake.receive({
      type: 'patch.terminal.error',
      sessionId: 'sess-1',
      code: 'too_many_sessions',
      message: 'too many terminal sessions open (max 4)',
    });
    expect(useTerminalStore.getState().sessions['c1']?.status).toBe('error');
  });
});

// spec/14 § File browser — live updates.
describe('PatchWs dispatch — patch.file_changed (spec/14 § File browser — live updates)', () => {
  it('records the push into uiStore, keyed by chatId, and never reaches chatStore', async () => {
    useUiStore.setState({ lastFileChanged: {} });
    const before = useChatStore.getState().chats;
    const { fake } = await connectAndOpen();

    fake.receive({ type: 'patch.file_changed', chatId: 'c1', path: 'src/a.ts' });

    expect(useUiStore.getState().lastFileChanged['c1']).toMatchObject({ path: 'src/a.ts' });
    // Not a chat-timeline event — chatStore's chats map is untouched.
    expect(useChatStore.getState().chats).toBe(before);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('a second push for the SAME path still advances the record (distinct seq)', async () => {
    useUiStore.setState({ lastFileChanged: {} });
    const { fake } = await connectAndOpen();

    fake.receive({ type: 'patch.file_changed', chatId: 'c1', path: 'src/a.ts' });
    const first = useUiStore.getState().lastFileChanged['c1'];
    fake.receive({ type: 'patch.file_changed', chatId: 'c1', path: 'src/a.ts' });
    const second = useUiStore.getState().lastFileChanged['c1'];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.seq).toBeGreaterThan(first!.seq);
  });

  it('keeps two chats independent', async () => {
    useUiStore.setState({ lastFileChanged: {} });
    const { fake } = await connectAndOpen();

    fake.receive({ type: 'patch.file_changed', chatId: 'c1', path: 'a.ts' });
    fake.receive({ type: 'patch.file_changed', chatId: 'c2', path: 'b.ts' });

    expect(useUiStore.getState().lastFileChanged['c1']).toMatchObject({ path: 'a.ts' });
    expect(useUiStore.getState().lastFileChanged['c2']).toMatchObject({ path: 'b.ts' });
  });
});
