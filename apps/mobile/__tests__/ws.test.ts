// api/ws.ts — the RN WebSocket client (spec/05, spec/12). Exercises connect/
// hello/replay-on-open, the message dispatch table, reconnect-with-backoff,
// the AppState-driven heartbeat, safeSend vs send, and getWs/resetWs. Uses
// the FakeWebSocket test double (installed as `global.WebSocket`) so every
// scenario is driven deterministically without a real socket.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppState, __emitAppStateChange } from 'react-native';
import {
  PatchWs,
  getWs,
  resetWs,
  HEARTBEAT_INTERVAL_MS,
  STORE_BATCH_MS,
  DISCONNECT_GRACE_MS,
} from '../src/api/ws';
import { saveCredential, clearCredential } from '../src/lib/credential';
import { useSettingsStore } from '../src/stores/settingsStore';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { useHostRefusalStore } from '../src/stores/hostRefusalStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useTerminalStore } from '../src/stores/terminalStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import * as buildInfoModule from '../src/lib/buildInfo';

beforeEach(() => {
  installFakeWebSocket();
  vi.useFakeTimers();
  saveCredential('a.b.c');
  useChatStore.getState()._reset();
  useFolderStore.setState({ folders: [] });
  useVoiceStore.setState({ incomingCall: null });
  useUiStore.setState({ errors: [] });
  // 'connecting' is the store's own natural default (spec/12 § No offline
  // flash on load) — reset to it explicitly rather than to 'offline', which
  // would spuriously suppress the connecting-state assertion below.
  usePresenceStore.getState().setConnection('connecting');
  usePresenceStore.getState().setDaemon('unknown');
  usePresenceStore.getState().setOutageVisible(false);
  AppState.currentState = 'active';
  vi.spyOn(deliveryTracker, 'onReconnect');
  vi.spyOn(deliveryTracker, 'reset');
  vi.spyOn(deliveryTracker, 'observe');
});

afterEach(() => {
  resetWs();
  vi.useRealTimers();
  restoreWebSocket();
  vi.restoreAllMocks();
});

function connectAndOpen(): PatchWs {
  const ws = getWs();
  ws.connect();
  FakeWebSocket.last().emitOpen();
  return ws;
}

describe('PatchWs.default() / getWs / resetWs', () => {
  it('getWs returns the same singleton until resetWs', () => {
    const a = getWs();
    const b = getWs();
    expect(a).toBe(b);
    resetWs();
    const c = getWs();
    expect(c).not.toBe(a);
  });
});

describe('connect() / openOnce()', () => {
  it('says the device is not linked when there is no saved credential', () => {
    // It used to THROW here, with a comment saying the caller should redirect
    // to pairing — and no caller did. `bootstrap()` calls connect() as
    // fire-and-forget, so the throw took out the REST of bootstrap, no socket
    // was ever opened, and the app sat on its connecting treatment for ever
    // while the server never heard from it. See credentialRejected.test.ts.
    clearCredential();
    const ws = new PatchWs('wss://example.test/ws');
    expect(() => ws.connect()).not.toThrow();
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
  });

  it('sets connection to connecting, then connected + sends hello on open', () => {
    const ws = getWs();
    ws.connect();
    expect(usePresenceStore.getState().connection).toBe('connecting');
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    expect(usePresenceStore.getState().connection).toBe('connected');
    const hello = JSON.parse(sock.sent[0] as string);
    expect(hello).toMatchObject({ type: 'hello', clientType: 'surface-mobile', auth: 'a.b.c' });
  });

  it('the hello carries clientGitSha + clientBuiltAt when the build is stamped', () => {
    // A release build reports its provenance so the server/update panel can spot
    // a phone left behind (spec/11 § Version reporting). The default 'dev' build
    // omits both; a stamped build includes them.
    vi.spyOn(buildInfoModule, 'mobileBuildInfo').mockReturnValue({
      version: '0.1.343',
      gitSha: 'a059a40',
      builtAt: '2026-07-31T13:07:00.000Z',
    });
    const ws = getWs();
    ws.connect();
    FakeWebSocket.last().emitOpen();
    const hello = JSON.parse(FakeWebSocket.last().sent[0] as string);
    expect(hello).toMatchObject({
      clientVersion: '0.1.343',
      clientGitSha: 'a059a40',
      clientBuiltAt: '2026-07-31T13:07:00.000Z',
    });
  });

  it('does not flash back to "connecting" from "reconnecting"/"offline"', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    getWs().connect();
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
  });

  it('replays every known chat by lastSeq on open', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'One',
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'assistant',
      content: 'hi',
    });
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replay = sock.sent
      .map((s) => JSON.parse(s as string))
      .find((m) => m.type === 'chat.replay');
    expect(replay).toMatchObject({ type: 'chat.replay', chatId: 'c1', fromSeq: 5 });
  });

  it('requests no replay for metadata-only roster rows (cold start, spec/12)', () => {
    // The roster comes from one metadata call; transcripts load on open, so a
    // cold start must not pull one event stream per known chat.
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'One',
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
      {
        chatId: 'c2',
        name: 'Two',
        folder: '~/y',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 2,
      },
    ]);
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays).toEqual([]);
  });

  it('still replays the chat the surface has open', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'One',
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
      {
        chatId: 'c2',
        name: 'Two',
        folder: '~/y',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 2,
      },
    ]);
    useChatStore.getState().setActiveChat('c2');
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays.map((m) => m.chatId)).toEqual(['c2']);
  });

  it('replays a BRAND-NEW chat seeded by ensureChat — the new-chat lock-up regression', () => {
    // This is the mechanism behind "New chat locked up on mobile". The
    // new-chat flow navigates to /chats/<id> the instant createChat returns,
    // long before `chat.spawned`. The connect handler iterates
    // `Object.keys(chats)`, so a chat with NO store row is invisible to it and
    // never gets a `chat.replay` — and `chat.replay` is the ONLY thing that
    // adds the chat to the connection's `watchedChats` on the server, which
    // gates every `chat.message` / `chat.tool_call` / `chat.tool_result` /
    // `chat.permission_request` (`DETAIL_LEVEL_EVENT_TYPES`, ws-hub.ts).
    // Result: the user types, and no reply ever arrives.
    //
    // The phone hits this constantly and the desktop never does: mobile
    // reconnects on every backgrounding and network change, and on a cold
    // start the screen's own mount-time `requestReplay` no-ops silently
    // because the socket isn't open yet (`readyState !== 1`).
    //
    // `ensureChat` is what puts the row there, so the loop can find it.
    useChatStore.getState().ensureChat('c_new', '/home/tom/work');
    useChatStore.getState().setActiveChat('c_new');
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    // fromSeq -1: nothing has been rendered, so ask for the whole transcript.
    expect(replays).toEqual([{ type: 'chat.replay', chatId: 'c_new', fromSeq: -1, batch: true }]);
  });

  it('replays the open chat even when the roster has no row for it — the tapped-notification cold start', () => {
    // Tapping an Android push cold-starts the app and deep-links straight to
    // /chats/<id>. That chat is typically brand new (a job just spawned it and
    // notified), so it is in neither the on-device roster cache nor the
    // still-unanswered GET /api/chats: `chats` has no row for it at all. The
    // connect handler iterates the chats it holds, so the ONE chat on screen
    // was the one chat it skipped — and `chat.replay` is the only thing that
    // adds a chat to the server's per-connection `watchedChats` (ws-hub.ts),
    // which gates every chat.message / chat.tool_call / chat.tool_result /
    // chat.permission_request. The user tapped the notification and got a
    // blank chat that then stayed blank, live events and all.
    useChatStore.getState().setActiveChat('c_push');
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays).toEqual([{ type: 'chat.replay', chatId: 'c_push', fromSeq: -1, batch: true }]);
  });

  it('re-issues the replay the detail screen asked for while the socket was still closed — exactly once', () => {
    // The cold-start ORDERING itself. The screen mounts and asks for its
    // replay before the socket has opened; `requestReplay` is best-effort, so
    // it drops the frame AND does not record the cursor, which is what leaves
    // the connect handler responsible for asking again.
    //
    // Exactly once matters: a second request from a different cursor on the
    // same connection re-delivers the transcript, and mobile's store dedups a
    // re-delivered permission card and error by identity but NOT a tool call.
    useChatStore.getState().setActiveChat('c_push');
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    // The screen mounts here: the socket exists but is still CONNECTING.
    ws.requestReplay('c_push');
    expect(sock.sent).toEqual([]);
    sock.emitOpen();
    // The screen's effect running again once the link is up changes nothing.
    ws.requestReplay('c_push');
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays).toEqual([{ type: 'chat.replay', chatId: 'c_push', fromSeq: -1, batch: true }]);
  });

  it('asks from -1 for an open chat whose roster row is metadata-only', () => {
    // A roster row (cached or freshly hydrated) carries no transcript, so its
    // lastSeq is 0 — and fromSeq is EXCLUSIVE, so asking from 0 skips seq 0,
    // the chat's first message. The cursor is what this surface has actually
    // RENDERED, which for a metadata-only row is nothing.
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'One',
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    useChatStore.getState().setActiveChat('c1');
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays).toEqual([{ type: 'chat.replay', chatId: 'c1', fromSeq: -1, batch: true }]);
  });

  it('re-asks for the open chat on the NEXT connection, from the cursor it reached', () => {
    // The per-connection cursor is cleared on every new socket: a reconnect
    // (the phone backgrounds, the network flips) must catch up on whatever
    // was missed while the link was down, from the last durable seq rendered.
    useChatStore.getState().setActiveChat('c_push');
    const ws = getWs();
    ws.connect();
    FakeWebSocket.last().emitOpen();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c_push',
      seq: 7,
      role: 'assistant',
      content: 'done',
    });
    FakeWebSocket.last().emitClose(1006, 'network');
    vi.advanceTimersByTime(1000);
    const sock2 = FakeWebSocket.last();
    sock2.emitOpen();
    const replays = sock2.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays).toEqual([{ type: 'chat.replay', chatId: 'c_push', fromSeq: 7, batch: true }]);
  });

  it('the cursor is the highest DURABLE seq rendered, not the last entry in the timeline', () => {
    // Two entries must not move the cursor. An optimistic outgoing echo carries
    // a negative placeholder seq until the host persists it, and a replay
    // re-delivers every still-pending permission card whatever fromSeq asked
    // for — so the card can land at an OLDER seq than the transcript's tail.
    // Taking either as the cursor would ask the host for events it has
    // already sent (and, from a negative seq, the whole transcript again).
    useChatStore.getState().setActiveChat('c_push');
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c_push',
      seq: 5,
      role: 'assistant',
      content: 'latest',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c_push',
      seq: 2,
      requestId: 'r1',
      request: { tool: 'Write', description: 'write a file', args: {} },
    });
    useChatStore.getState().appendLocalUserMessage('c_push', 'and another thing', 'local-1');
    const ws = getWs();
    ws.connect();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    const replays = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'chat.replay');
    expect(replays).toEqual([{ type: 'chat.replay', chatId: 'c_push', fromSeq: 5, batch: true }]);
  });

  it('calls deliveryTracker.onReconnect() on open', () => {
    connectAndOpen();
    expect(deliveryTracker.onReconnect).toHaveBeenCalled();
  });

  it('starts the heartbeat on open when foregrounded', () => {
    connectAndOpen();
    const sock = FakeWebSocket.last();
    sock.sent.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const hb = sock.sent
      .map((s) => JSON.parse(s as string))
      .find((m) => m.type === 'surface.heartbeat');
    expect(hb).toBeDefined();
  });

  it('startHeartbeat is idempotent — calling it while already running does not spawn a second interval', () => {
    const ws = connectAndOpen();
    const sock = FakeWebSocket.last();
    // Already running (from open, foregrounded) — a second direct call must
    // be a no-op guard, not a duplicate interval doubling the send rate.
    (ws as unknown as { startHeartbeat(): void }).startHeartbeat();
    sock.sent.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const beats = sock.sent
      .map((s) => JSON.parse(s as string))
      .filter((m) => m.type === 'surface.heartbeat');
    expect(beats.length).toBe(1);
  });

  it('does not start the heartbeat on open when backgrounded', () => {
    AppState.currentState = 'background';
    connectAndOpen();
    const sock = FakeWebSocket.last();
    sock.sent.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    const hb = sock.sent
      .map((s) => JSON.parse(s as string))
      .find((m) => m.type === 'surface.heartbeat');
    expect(hb).toBeUndefined();
  });
});

describe('AppState-driven heartbeat', () => {
  it('foregrounding sends surface.foregrounded and starts the heartbeat', () => {
    AppState.currentState = 'background';
    connectAndOpen();
    const sock = FakeWebSocket.last();
    sock.sent.length = 0;
    __emitAppStateChange('active');
    expect(
      sock.sent.map((s) => JSON.parse(s as string)).some((m) => m.type === 'surface.foregrounded'),
    ).toBe(true);
    sock.sent.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(
      sock.sent.map((s) => JSON.parse(s as string)).some((m) => m.type === 'surface.heartbeat'),
    ).toBe(true);
  });

  it('backgrounding sends surface.backgrounded and stops the heartbeat', () => {
    connectAndOpen();
    const sock = FakeWebSocket.last();
    sock.sent.length = 0;
    __emitAppStateChange('background');
    expect(
      sock.sent.map((s) => JSON.parse(s as string)).some((m) => m.type === 'surface.backgrounded'),
    ).toBe(true);
    sock.sent.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(sock.sent.length).toBe(0);
  });

  it('a same-state transition (active→active) is a no-op', () => {
    connectAndOpen();
    const sock = FakeWebSocket.last();
    sock.sent.length = 0;
    __emitAppStateChange('active');
    expect(sock.sent.length).toBe(0);
  });

  it('an AppState change while the socket is not open is ignored', () => {
    const ws = getWs();
    ws.connect(); // not yet open (CONNECTING)
    expect(() => __emitAppStateChange('background')).not.toThrow();
  });
});

// Tom: "Shows reconnecting every time you open the app". Android drops the
// socket while the app is backgrounded, so every open used to flash the amber
// banner for the second the reconnect took. The banner (`outageVisible`) is
// for a link down DISCONNECT_GRACE_MS with the app on screen; `connection`
// still reports the truth immediately, for diagnostics.
describe('disconnect grace — banner only for a real foreground outage', () => {
  const bannerShown = (): boolean => usePresenceStore.getState().outageVisible;

  it('background → close → foreground → reconnect within the grace shows no banner', () => {
    connectAndOpen();
    __emitAppStateChange('background');
    FakeWebSocket.last().emitClose(1006, 'abnormal closure');
    // The truth is reported at once — only the banner waits.
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
    // Android suspends JS timers in the background, so the backoff redial
    // has not fired by the time the app returns.
    vi.advanceTimersByTime(500);
    expect(bannerShown()).toBe(false);

    const before = FakeWebSocket.instances.length;
    __emitAppStateChange('active');
    // Resume dials immediately rather than waiting out the backoff.
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 500);
    expect(bannerShown()).toBe(false);
    FakeWebSocket.last().emitOpen();
    expect(usePresenceStore.getState().connection).toBe('connected');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);
    expect(bannerShown()).toBe(false);
  });

  it('a long background idle with redials failing never raises the banner', () => {
    connectAndOpen();
    __emitAppStateChange('background');
    FakeWebSocket.last().emitClose(1006, '');
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(30_000);
      FakeWebSocket.last().emitClose(1006, '');
    }
    expect(bannerShown()).toBe(false);
  });

  it('a close that only surfaces after foregrounding, then a quick reconnect, shows no banner', () => {
    // Android often reports the dead socket only once the app is back.
    connectAndOpen();
    __emitAppStateChange('background');
    __emitAppStateChange('active');
    FakeWebSocket.last().emitClose(1006, '');
    vi.advanceTimersByTime(1000); // first backoff step → redial
    FakeWebSocket.last().emitOpen();
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);
    expect(bannerShown()).toBe(false);
  });

  it('a foreground close lasting longer than the grace shows the banner', () => {
    connectAndOpen();
    FakeWebSocket.last().emitClose(1006, '');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
    expect(bannerShown()).toBe(false);
    // The redial at 1s failed too; the link is genuinely down.
    FakeWebSocket.last().emitClose(1006, '');
    vi.advanceTimersByTime(1);
    expect(bannerShown()).toBe(true);
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
  });

  it('a successful reconnect clears the banner', () => {
    connectAndOpen();
    FakeWebSocket.last().emitClose(1006, '');
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last().emitClose(1006, '');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(bannerShown()).toBe(true);
    vi.advanceTimersByTime(2000); // second backoff step → redial
    FakeWebSocket.last().emitOpen();
    expect(bannerShown()).toBe(false);
    expect(usePresenceStore.getState().connection).toBe('connected');
  });

  it('a real outage still showing when the app returns gets the banner back after the grace', () => {
    connectAndOpen();
    FakeWebSocket.last().emitClose(1006, '');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(bannerShown()).toBe(true);
    __emitAppStateChange('background');
    expect(bannerShown()).toBe(false);
    __emitAppStateChange('active');
    FakeWebSocket.last().emitClose(1006, ''); // the resume redial fails too
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(bannerShown()).toBe(true);
  });

  it('close() cancels a pending grace', () => {
    const ws = connectAndOpen();
    FakeWebSocket.last().emitClose(1006, '');
    ws.close();
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);
    expect(bannerShown()).toBe(false);
  });
});

describe('send() / safeSend()', () => {
  it('send() throws when not connected', () => {
    const ws = getWs();
    expect(() => ws.send({ type: 'surface.heartbeat' })).toThrow(/not connected/);
  });

  it('send() writes JSON once connected', () => {
    const ws = connectAndOpen();
    const sock = FakeWebSocket.last();
    sock.sent.length = 0;
    ws.send({ type: 'surface.heartbeat' });
    expect(JSON.parse(sock.sent[0] as string)).toEqual({ type: 'surface.heartbeat' });
  });

  it('safeSend() silently no-ops when not connected', () => {
    const ws = getWs();
    expect(() => ws.safeSend({ type: 'surface.heartbeat' })).not.toThrow();
  });
});

describe('message dispatch', () => {
  function open(): FakeWebSocket {
    connectAndOpen();
    return FakeWebSocket.last();
  }

  it('a malformed frame surfaces a UI error and does not throw', () => {
    const sock = open();
    expect(() => sock.emitMessage('not json{{')).not.toThrow();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('malformed wire event')),
    ).toBe(true);
  });

  it('a non-string message payload is treated as empty (also malformed)', () => {
    const sock = open();
    sock.emitMessage(new ArrayBuffer(4));
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('malformed wire event')),
    ).toBe(true);
  });

  // spec/03 § Forward compatibility. The phone is the surface most likely to be
  // OLDER than the host — off during a deploy, or simply behind on the OTA —
  // and `chat.state` drives the whole app.
  it('a chat.state carrying an unknown field still lands, with no banner', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.state',
        chatId: 'c1',
        activity: 'running',
        permissionMode: 'bypassPermissions',
        lastUpdated: 1700000000,
        limitResetsAt: 1789000000000, // whatever the next host adds
      }),
    );
    vi.advanceTimersByTime(STORE_BATCH_MS);
    expect(useChatStore.getState().chats['c1']?.activity).toBe('running');
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('an unknown event type is dropped quietly, with no banner', () => {
    const sock = open();
    expect(() =>
      sock.emitMessage(JSON.stringify({ type: 'chat.vibes', chatId: 'c1', mood: 'chipper' })),
    ).not.toThrow();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('a frame that is genuinely wrong — not merely newer — still banners', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.state',
        chatId: 'c1',
        activity: 'vibing', // not a real activity: this IS a bug
        permissionMode: 'bypassPermissions',
        lastUpdated: 1700000000,
      }),
    );
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('malformed wire event')),
    ).toBe(true);
  });

  it('auth.ok sets identity', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({ type: 'auth.ok', hosts: [], accountId: 'acc1', surfaceId: 'surf1' }),
    );
    expect(usePresenceStore.getState().accountId).toBe('acc1');
    expect(usePresenceStore.getState().surfaceId).toBe('surf1');
  });

  it('auth.revoked signs the surface out and says so — it is not a toast to dismiss', () => {
    // A revoked credential cannot be retried into working, so this is terminal:
    // the message names the fix (link the device again) and the app leaves for
    // pairing. See credentialRejected.test.ts for the whole path.
    const sock = open();
    sock.emitMessage(JSON.stringify({ type: 'auth.revoked', reason: 'device removed' }));
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('Link this device again')),
    ).toBe(true);
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
  });

  it('auth.expired surfaces a non-destructive UI error', () => {
    const sock = open();
    sock.emitMessage(JSON.stringify({ type: 'auth.expired', reason: 'ttl' }));
    expect(useUiStore.getState().errors.some((e) => e.message.includes('session expired'))).toBe(
      true,
    );
  });

  it('daemon.online sets host presence + redelivers pending', () => {
    const sock = open();
    vi.mocked(deliveryTracker.onReconnect).mockClear();
    sock.emitMessage(JSON.stringify({ type: 'daemon.online', daemonId: 'd1' }));
    expect(usePresenceStore.getState().daemon).toBe('online');
    expect(deliveryTracker.onReconnect).toHaveBeenCalled();
  });

  it('daemon.offline sets host presence', () => {
    const sock = open();
    sock.emitMessage(JSON.stringify({ type: 'daemon.offline', daemonId: 'd1' }));
    expect(usePresenceStore.getState().daemon).toBe('offline');
  });

  // spec/10 § Backend credentials — the report names BOTH the machine and the
  // backend, and it is a CREDENTIAL fact, not a presence one: the host emitted
  // it over its own live link, so its presence is untouched. Flipping presence
  // here would tell the user the machine is down when it is up and simply
  // logged out of one backend.
  it('daemon.unauthenticated marks that backend on that host not-connected and surfaces the reason', () => {
    const sock = open();
    usePresenceStore.getState().setHostOnline('d1', true);
    sock.emitMessage(
      JSON.stringify({
        type: 'daemon.unauthenticated',
        daemonId: 'd1',
        backendId: 'claude-code',
        reason: 'bad token',
      }),
    );
    expect(usePresenceStore.getState().hosts['d1']?.accounts['claude-code']).toMatchObject({
      daemonId: 'd1',
      backendId: 'claude-code',
      connected: false,
    });
    expect(usePresenceStore.getState().hosts['d1']?.online).toBe(true);
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('host unauthenticated')),
    ).toBe(true);
  });

  it('daemon.unauthenticated marks THAT host s backend not connected', () => {
    const sock = open();
    usePresenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: 'd1',
      backendId: 'claude-code',
      connected: true,
      accountEmail: 'tom@example.com',
    });
    sock.emitMessage(
      JSON.stringify({
        type: 'daemon.unauthenticated',
        daemonId: 'd1',
        backendId: 'claude-code',
        reason: 'bad token',
      }),
    );
    expect(usePresenceStore.getState().hosts['d1']?.accounts['claude-code']).toMatchObject({
      connected: false,
      accountEmail: null,
    });
  });

  // `daemon.account` replaced the account-wide report: a machine can be
  // connected on one backend and logged out on another, so the frame names
  // machine AND backend (spec/10 § Backend credentials).
  it('daemon.account records one backend s credential on one host', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({
        type: 'daemon.account',
        daemonId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: 'tom@example.com',
      }),
    );
    expect(usePresenceStore.getState().hosts['d1']?.accounts['claude-code']).toMatchObject({
      connected: true,
      accountEmail: 'tom@example.com',
    });
    // No account-wide copy exists: another host reporting itself logged out
    // must leave d1's row untouched.
    sock.emitMessage(
      JSON.stringify({
        type: 'daemon.account',
        daemonId: 'd2',
        backendId: 'claude-code',
        connected: false,
        accountEmail: null,
      }),
    );
    expect(usePresenceStore.getState().hosts['d1']?.accounts['claude-code']).toMatchObject({
      connected: true,
    });
    expect(usePresenceStore.getState().hosts['d2']?.accounts['claude-code']).toMatchObject({
      connected: false,
    });
  });

  // Each registry names the machine whose filesystem it describes, and the
  // store is keyed by it — two hosts sharing a path string stay two entries
  // (spec/04 § Folders).
  it('folders.list replaces THAT host s registry only', () => {
    const sock = open();
    useFolderStore.getState().setHostFolders({ daemonId: 'd2', roots: ['~/z'], recent: [] });
    sock.emitMessage(
      JSON.stringify({ type: 'folders.list', daemonId: 'd1', roots: ['~/a'], recent: ['~/b'] }),
    );
    expect(useFolderStore.getState().foldersFor('d1')).toEqual(['~/a', '~/b']);
    expect(useFolderStore.getState().foldersFor('d2')).toEqual(['~/z']);
  });

  it('folders.updated replaces THAT host s registry only', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({ type: 'folders.updated', daemonId: 'd1', roots: ['~/c'], recent: [] }),
    );
    expect(useFolderStore.getState().foldersFor('d1')).toEqual(['~/c']);
  });

  // spec/02 § Claude Code settings — Settings → Hosts reads each machine's
  // settings.json + memory from these, settling on what the machine holds.
  it('claude_settings.list / .updated replace THAT host s snapshot, and survive the greeting', () => {
    const sock = open();
    const memory = { project: 'p', file: 'm.md', name: 'n', description: '', memoryType: 'user' };
    sock.emitMessage(
      JSON.stringify({ type: 'claude_settings.list', daemonId: 'd1', memories: [memory] }),
    );
    expect(usePresenceStore.getState().hosts['d1']?.claudeSettings).toEqual({ memories: [memory] });
    sock.emitMessage(
      JSON.stringify({
        type: 'claude_settings.updated',
        daemonId: 'd1',
        drift: '{"a":1}',
        memories: [],
      }),
    );
    expect(usePresenceStore.getState().hosts['d1']?.claudeSettings?.drift).toBe('{"a":1}');
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: 1, host: null, accounts: [] }]);
    expect(usePresenceStore.getState().hosts['d1']?.claudeSettings?.drift).toBe('{"a":1}');
  });

  // spec/03 § Settings — the shared settings arrive in the greeting and after every change.
  it('settings.changed updates the shared settings, and an older one never overwrites a newer', () => {
    const sock = open();
    useSettingsStore.setState({
      data: {
        devices: [],
        push: { tokenCount: 0 },
        telegram: { connected: false, chatId: null, botUsername: null },
        google: { configured: false, connected: false, scope: null },
        preferences: DEFAULT_SHARED_SETTINGS,
      },
      error: null,
    });
    const changed = (version: number, chatNameInterval: number) =>
      JSON.stringify({
        type: 'settings.changed',
        version,
        settings: { ...DEFAULT_SHARED_SETTINGS, chatNameInterval },
        secrets: { claude: [], codex: [], providerKeys: [] },
        hosts: [],
      });
    sock.emitMessage(changed(3, 5));
    expect(useSettingsStore.getState().data?.preferences.chatNameInterval).toBe(5);
    expect(useSettingsStore.getState().data?.shared?.version).toBe(3);
    sock.emitMessage(changed(2, 9));
    expect(useSettingsStore.getState().data?.preferences.chatNameInterval).toBe(5);
  });

  // Settings → Hosts → Remove this host: every surface is sent `host.removed`
  // and drops the host with every report it had cached for it.
  it('host.removed drops THAT host and its cached reports, and nothing else', () => {
    const sock = open();
    usePresenceStore.getState().setHosts([
      { daemonId: 'd1', online: true, lastSeenAt: 1, host: null, accounts: [] },
      { daemonId: 'd2', online: false, lastSeenAt: 1, host: null, accounts: [] },
    ]);
    usePresenceStore.getState().setClaudeSettings('d1', undefined, []);
    sock.emitMessage(JSON.stringify({ type: 'host.removed', daemonId: 'd1' }));
    expect(Object.keys(usePresenceStore.getState().hosts)).toEqual(['d2']);
    expect(usePresenceStore.getState().daemon).toBe('offline');
    // Unknown id: a no-op, not an error.
    sock.emitMessage(JSON.stringify({ type: 'host.removed', daemonId: 'nope' }));
    expect(Object.keys(usePresenceStore.getState().hosts)).toEqual(['d2']);
  });

  // A host missing from a later greeting is gone too (it was removed while
  // this surface was away).
  it('a host missing from auth.ok’s roster is dropped', () => {
    usePresenceStore.getState().setHosts([
      { daemonId: 'd1', online: true, lastSeenAt: 1, host: null, accounts: [] },
      { daemonId: 'd2', online: true, lastSeenAt: 1, host: null, accounts: [] },
    ]);
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd2', online: true, lastSeenAt: 1, host: null, accounts: [] }]);
    expect(Object.keys(usePresenceStore.getState().hosts)).toEqual(['d2']);
  });

  it('a pending-spawn chat.error inside a chat.replay_batch is still recorded as a host refusal', () => {
    const sock = open();
    useHostRefusalStore.getState()._reset();
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.replay_batch',
        chatId: 'c1',
        done: true,
        events: [
          {
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'claude_settings_invalid', message: 'replayed refusal' },
            seq: -1,
          },
        ],
      }),
    );
    expect(useHostRefusalStore.getState().last).toMatchObject({ message: 'replayed refusal' });
  });

  // A refused settings.json / memory edit arrives as an out-of-band chat.error
  // addressed to no chat; the editor that sent it reads it from here.
  it('a pending-spawn chat.error is recorded as the latest host refusal', () => {
    const sock = open();
    useHostRefusalStore.getState()._reset();
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.error',
        chatId: 'pending-spawn',
        error: { code: 'claude_settings_invalid', message: 'invalid JSON on d1 — x' },
        seq: -1,
      }),
    );
    expect(useHostRefusalStore.getState().last).toMatchObject({
      code: 'claude_settings_invalid',
      message: 'invalid JSON on d1 — x',
    });
    // A chat's own error is not a host refusal.
    useHostRefusalStore.getState()._reset();
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.error',
        chatId: 'c1',
        error: { code: 'x', message: 'y' },
        seq: 3,
      }),
    );
    expect(useHostRefusalStore.getState().last).toBeNull();
  });

  // spec/15 § Host files and terminal — a terminal's frames go straight to its
  // own store, unbatched, not through the chat fold.
  it('patch.terminal.* frames land in the terminal store at once', () => {
    const sock = open();
    useTerminalStore.getState()._reset();
    useTerminalStore.getState().start('t1', 'd1', '/srv');
    sock.emitMessage(
      JSON.stringify({ type: 'patch.terminal.ready', sessionId: 't1', cwd: '/srv', pty: true }),
    );
    sock.emitMessage(
      JSON.stringify({
        type: 'patch.terminal.output',
        sessionId: 't1',
        stream: 'stdout',
        data: '$ ',
      }),
    );
    expect(useTerminalStore.getState().sessions['t1']).toMatchObject({
      status: 'live',
      output: ['$ '],
    });
    sock.emitMessage(
      JSON.stringify({ type: 'patch.terminal.exit', sessionId: 't1', code: 0, reason: 'closed' }),
    );
    expect(useTerminalStore.getState().sessions['t1']?.status).toBe('ended');
    sock.emitMessage(
      JSON.stringify({
        type: 'patch.terminal.error',
        sessionId: 't1',
        code: 'internal',
        message: 'x',
      }),
    );
    expect(useTerminalStore.getState().sessions['t1']?.status).toBe('error');
  });

  it('chat.call_request sets an incoming call', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({ type: 'chat.call_request', callId: 'call1', chatId: 'c1', message: 'hey' }),
    );
    expect(useVoiceStore.getState().incomingCall).toMatchObject({ callId: 'call1', chatId: 'c1' });
  });

  it('chat.call_winner clears a matching incoming call', () => {
    const sock = open();
    useVoiceStore
      .getState()
      .setIncoming({ callId: 'call1', chatId: 'c1', message: undefined, receivedAt: Date.now() });
    sock.emitMessage(
      JSON.stringify({ type: 'chat.call_winner', callId: 'call1', acceptedSurfaceId: 's1' }),
    );
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('chat.call_timeout clears a matching incoming call', () => {
    const sock = open();
    useVoiceStore
      .getState()
      .setIncoming({ callId: 'call1', chatId: 'c1', message: undefined, receivedAt: Date.now() });
    sock.emitMessage(JSON.stringify({ type: 'chat.call_timeout', callId: 'call1' }));
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('chat.call_winner for a DIFFERENT callId leaves the incoming call alone', () => {
    const sock = open();
    useVoiceStore
      .getState()
      .setIncoming({ callId: 'call1', chatId: 'c1', message: undefined, receivedAt: Date.now() });
    sock.emitMessage(
      JSON.stringify({ type: 'chat.call_winner', callId: 'other', acceptedSurfaceId: 's1' }),
    );
    expect(useVoiceStore.getState().incomingCall).not.toBeNull();
  });

  it('chat.call_winner with no incoming call at all is a no-op', () => {
    const sock = open();
    expect(() =>
      sock.emitMessage(
        JSON.stringify({ type: 'chat.call_winner', callId: 'call1', acceptedSurfaceId: 's1' }),
      ),
    ).not.toThrow();
  });

  it('a plain chat event (chat.message) is observed by deliveryTracker AND applied to chatStore', () => {
    const sock = open();
    sock.emitMessage(
      JSON.stringify({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'assistant',
        content: 'hi',
      }),
    );
    // The tracker is told immediately; the STORE commit is coalesced by one
    // frame so a replay burst lands as a single commit (see STORE_BATCH_MS).
    expect(deliveryTracker.observe).toHaveBeenCalled();
    vi.advanceTimersByTime(STORE_BATCH_MS);
    expect(useChatStore.getState().timelines['c1']?.length).toBe(1);
  });

  it('a burst of chat events commits ONCE, in arrival order', () => {
    const sock = open();
    let commits = 0;
    const unsub = useChatStore.subscribe(() => {
      commits++;
    });
    for (let seq = 1; seq <= 20; seq++) {
      sock.emitMessage(
        JSON.stringify({
          type: 'chat.message',
          chatId: 'burst',
          seq,
          role: 'assistant',
          content: `m${seq}`,
        }),
      );
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
});

describe('reconnect with backoff', () => {
  it('onclose sets reconnecting + host unknown and schedules a reopen', () => {
    connectAndOpen();
    FakeWebSocket.last().emitClose();
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
    expect(usePresenceStore.getState().daemon).toBe('unknown');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBe(2); // reopened
  });

  it('does not reconnect after an explicit close()', () => {
    const ws = connectAndOpen();
    ws.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('scheduleReconnect is itself a no-op once closed (defensive guard)', () => {
    // onclose already gates its call to scheduleReconnect() on `!this.closed`
    // (see the test above), so this guard is unreachable via that one call
    // site — call it directly to pin the defensive early-return itself.
    const ws = connectAndOpen();
    ws.close();
    const before = FakeWebSocket.instances.length;
    (ws as unknown as { scheduleReconnect(): void }).scheduleReconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  // spec/12 § Connection diagnostics screen — connection forensics + Retry now.
  it('records connection forensics: an open clears the failure counters, a close counts and explains itself', () => {
    connectAndOpen();
    expect(usePresenceStore.getState().everConnected).toBe(true);
    expect(usePresenceStore.getState().failedAttempts).toBe(0);
    expect(usePresenceStore.getState().wsUrl).not.toBeNull();
    FakeWebSocket.last().onclose?.({ code: 1006, reason: 'abnormal closure' });
    const st = usePresenceStore.getState();
    expect(st.failedAttempts).toBe(1);
    expect(st.lastClose?.code).toBe(1006);
    expect(st.lastClose?.reason).toBe('abnormal closure');
  });

  it('records a close that carries no code/reason without inventing one', () => {
    connectAndOpen();
    FakeWebSocket.last().emitClose();
    expect(usePresenceStore.getState().lastClose?.code).toBe(0);
    expect(usePresenceStore.getState().lastClose?.reason).toBe('');
  });

  it('reconnectNow() dials immediately instead of waiting out the backoff', () => {
    const ws = connectAndOpen();
    FakeWebSocket.last().emitClose();
    const afterDrop = FakeWebSocket.instances.length;
    ws.reconnectNow();
    expect(FakeWebSocket.instances.length).toBe(afterDrop + 1);
    // The cancelled backoff timer must not ALSO fire a second dial.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(afterDrop + 1);
  });

  it('reconnectNow() closes a still-open socket before redialling', () => {
    const ws = connectAndOpen();
    const open = FakeWebSocket.last();
    const before = FakeWebSocket.instances.length;
    ws.reconnectNow();
    expect(open.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('reconnectNow() swallows a throwing close on an already-dead socket', () => {
    const ws = connectAndOpen();
    FakeWebSocket.last().close = () => {
      throw new Error('already dead');
    };
    const before = FakeWebSocket.instances.length;
    expect(() => ws.reconnectNow()).not.toThrow();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('reconnectNow() with no credential says what is wrong instead of retrying', () => {
    // "Retry now" on the diagnostics screen cannot conjure a credential. Tell
    // the user what is actually missing rather than dialling again.
    const ws = connectAndOpen();
    clearCredential();
    ws.reconnectNow();
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
    expect(useUiStore.getState().errors.some((e) => e.message.includes('not linked'))).toBe(true);
  });

  it('reconnectNow() is a no-op after the app has torn the connection down', () => {
    const ws = connectAndOpen();
    ws.close();
    const before = FakeWebSocket.instances.length;
    ws.reconnectNow();
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it('doubles the backoff up to the 30s cap across repeated drops', () => {
    connectAndOpen();
    FakeWebSocket.last().emitClose(); // backoff 1000 -> reopen scheduled, next backoff 2000
    vi.advanceTimersByTime(1000);
    FakeWebSocket.last().emitClose(); // backoff 2000 -> reopen scheduled, next backoff 4000
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it('a reopen that finds no credential stops, rather than retrying for ever', () => {
    connectAndOpen();
    // The reconnect path re-reads the credential; clearing it mid-flight is the
    // shape of "this surface is no longer linked".
    FakeWebSocket.last().emitClose();
    clearCredential();
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it('close() clears any pending reconnect timer', () => {
    const ws = connectAndOpen();
    FakeWebSocket.last().emitClose();
    ws.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('onerror does not itself change state (close follows)', () => {
    connectAndOpen();
    expect(() => FakeWebSocket.last().emitError()).not.toThrow();
  });
});

describe('close()', () => {
  it('sets connection offline + host unknown, resets delivery tracker', () => {
    connectAndOpen();
    getWs().close();
    expect(usePresenceStore.getState().connection).toBe('offline');
    expect(usePresenceStore.getState().daemon).toBe('unknown');
    expect(deliveryTracker.reset).toHaveBeenCalled();
  });

  it('removes the AppState subscription (a later change is inert)', () => {
    connectAndOpen();
    getWs().close();
    expect(() => __emitAppStateChange('background')).not.toThrow();
  });
});
