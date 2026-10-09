// Full-loop chat transcript integration suite (spec/03, spec/07, spec/12,
// spec/14 § Main chat panel).
//
// WHY THIS EXISTS: the server `test/e2e` suite asserts on WIRE EVENTS and never
// renders the UI — so "I sent a message and it never showed up in the
// transcript" (the voice-note bug) was structurally invisible to it. This suite
// drives the REAL web client — the real AppShell + real Zustand stores + the
// real `PatchWs` dispatch/reducer + the real client controllers (voiceController
// echo path, deliveryTracker) — and asserts on the RENDERED DOM (Testing
// Library). A turn that is accepted on the wire but never RENDERS therefore
// FAILS here.
//
// ARCHITECTURE (fallback, per the task's "acceptable fallback"): we keep the
// real client render + real stores + real controllers and fake ONLY the server
// boundary — a scriptable in-memory WebSocket (`FakeWs`, standing in for the
// browser global, exactly as the unit `ws.test.ts` does) plus a `fetch` stub for
// the cold-start `GET /api/chats`, plus the audio-session opener test seam
// (`__setAudioOpenerForTests`). We do NOT boot the real in-process server +
// host here because (a) jsdom ships no real WebSocket, and (b) the host
// AUDIO plane — which web voice notes stream through — is not bootable in-process
// (the server e2e `harness.ts` explicitly does not boot it). The real
// cross-process backend loop is already covered at the wire level by
// `packages/server/test/e2e`; this suite adds the missing RENDER-level
// assertions where the voice bug actually lived. See testing-strategy.md.

import type { JSX } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WireEvent, AttachmentRef } from '@patch/wire';
import { AppShell } from '../AppShell.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import {
  __setAudioOpenerForTests,
  __setRecorderFactoryForTests,
  startVoiceNote,
  sendVoiceNote,
  startVoiceCall,
} from '../lib/voiceController.js';
import { api } from '../api/rest.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';
import type {
  AudioSession,
  AudioSessionCallbacks,
  OpenAudioSessionOpts,
} from '../lib/audioSession.js';
import type { ChatRow } from '../stores/types.js';

// EditorRail lazy-loads @monaco-editor/react only when the diff editor mounts
// (we never open it here). Mock it so nothing can reach for the real Monaco
// bundle during a render, mirroring the established AppShell.test pattern.
// The EditorRail's lazy editor factories first pull in the self-hosted Monaco
// bootstrap (spec/14 § Startup cost — it moved off the entry chunk, so the rail
// now owns triggering it). That module imports the real `monaco-editor`, which
// jsdom cannot evaluate; stub it out alongside the editor wrapper below.
vi.mock('../lib/monaco-loader.js', () => ({
  ensureMonacoLoaded: async () => undefined,
}));

vi.mock('@monaco-editor/react', () => {
  const Noop = (): JSX.Element => <div data-testid="mock-monaco" />;
  return { DiffEditor: Noop, Editor: Noop };
});

// ---------------------------------------------------------------------------
// Fake server boundary — an in-memory WebSocket the test drives as "the server".
// Same shape as ws.test.ts's FakeWS: PatchWs sees a real WebSocket-ish object;
// the test opens it, captures outbound frames (`sent`), and pushes inbound wire
// events (`receive`).
// ---------------------------------------------------------------------------
class FakeWs {
  static OPEN = 1;
  static instances: FakeWs[] = [];
  readyState = 0;
  url: string;
  sent: string[] = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(name: string, cb: (e: unknown) => void): void {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener(): void {}
  private emit(name: string, data: unknown): void {
    for (const cb of this.listeners[name] ?? []) cb(data);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  /** Push an inbound wire event to the client (server → surface). */
  receive(event: WireEvent): void {
    this.emit('message', { data: JSON.stringify(event) });
  }
  /** Parsed outbound frames the client sent us. */
  outbound(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** The chat.input frames the client has emitted (for localId extraction). */
function sentInputs(fake: FakeWs): Array<{ chatId: string; message: string; localId: string }> {
  return fake.outbound().filter((e) => e.type === 'chat.input') as unknown as Array<{
    chatId: string;
    message: string;
    localId: string;
  }>;
}

// ---------------------------------------------------------------------------
// Fake audio-session opener (voice). Captures the callbacks voiceController
// wires up so a test can drive onTranscriptFinal exactly as the host's STT
// would — WITHOUT a real WSS / getUserMedia / the host audio plane.
// ---------------------------------------------------------------------------
let audioCallbacks: AudioSessionCallbacks | null = null;
function fakeOpener(opts: OpenAudioSessionOpts): Promise<AudioSession> {
  audioCallbacks = opts.callbacks;
  return Promise.resolve({
    sessionId: 'sess-int',
    chatId: opts.chatId,
    setMuted: () => {},
    setSessionMode: () => {},
    speak: () => {},
    sendPcm: () => {},
    isMuted: () => false,
    end: () => {},
  });
}

function makeRow(chatId: string, overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: chatId,
    folder: '/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    lastUserActivity: Date.now(),
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

/** Cold-start fetch: serve GET /api/chats; everything else is a benign {}. */
function makeFetch(chats: ChatRow[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (u === '/api/chats' && (!init || (init.method ?? 'GET') === 'GET')) {
      return json({
        chats: chats.map((c) => ({
          chatId: c.chatId,
          daemonId: 'd1',
          permissionMode: 'bypassPermissions' as const,
          name: c.name,
          preview: c.preview,
          folder: c.folder,
          activity: c.activity,
          status: c.status,
          pinned: c.pinned,
          pinnedAt: c.pinnedAt,
          disabled: false,
          lastUpdated: c.lastUpdated,
        })),
      });
    }
    if (u === '/api/notifications') return json({ items: [], unread: 0 });
    return json({});
  });
}

/**
 * Mount the REAL AppShell at `path`, cold-hydrating `chats`, then bring the
 * (fake) socket up and authenticate — so the client is in the exact live state
 * a real surface reaches after `GET /api/chats` + WS `hello`/`auth.ok`.
 */
async function mountApp(
  path: string,
  chats: ChatRow[],
): Promise<{ fake: FakeWs; unmount: () => void }> {
  vi.stubGlobal('fetch', makeFetch(chats));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // The socket is created in AppShell's mount effect.
  await waitFor(() => expect(FakeWs.instances.length).toBeGreaterThan(0));
  const fake = FakeWs.instances[FakeWs.instances.length - 1]!;
  await act(async () => {
    fake.open();
    fake.receive({
      type: 'auth.ok',
      hosts: [],
      accountId: 'acc-1',
      surfaceId: 'web-1',
    } as WireEvent);
    fake.receive({ type: 'daemon.online', daemonId: 'd1' } as WireEvent);
    await Promise.resolve();
  });
  // Cold-start hydrate landed.
  await waitFor(() => expect(useChatStore.getState().chats[chats[0]!.chatId]).toBeDefined());
  return { fake, unmount: utils.unmount };
}

/** All rendered message bubbles, in DOM (transcript) order. */
function bubbles(): HTMLElement[] {
  return screen.queryAllByTestId('msg');
}
/** The visible text of each rendered bubble, in transcript order. */
function bubbleTexts(): string[] {
  return bubbles().map((b) => within(b).getByTestId('msg-content').textContent ?? '');
}

// Voice NOTES use the record-and-upload path (D1): a fake recorder + a stubbed
// `api.voiceNote` returning the transcript in the HTTP response. This exercises
// the REAL prod path — NO `onTranscriptFinal` over the audio WSS — which is what
// the earlier fidelity-gap version got wrong.
let voiceNoteSpy: MockInstance<typeof api.voiceNote>;
function stubRecording(): VoiceRecording {
  return {
    onLevel: () => {},
    onPcm: () => {},
    stop: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
    cancel: () => {},
  };
}

beforeEach(() => {
  FakeWs.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = FakeWs;
  audioCallbacks = null;
  __setAudioOpenerForTests(fakeOpener);
  __setRecorderFactoryForTests(async () => stubRecording());
  voiceNoteSpy = vi
    .spyOn(api, 'voiceNote')
    .mockResolvedValue({ ok: true, transcript: '', text: '' });
  useChatStore.getState()._reset();
  useUiStore.getState().clearToasts();
  useVoiceStore.setState({
    note: null,
    call: null,
    incomingCall: null,
    permission: null,
    session: null,
  });
  usePresenceStore.setState({
    connection: 'offline',
    daemonOnline: false,
    accountId: null,
    surfaceId: null,
    hosts: {},
  });
  deliveryTracker.reset();
  setActiveWs(null);
});

afterEach(() => {
  cleanup();
  __setAudioOpenerForTests(null);
  __setRecorderFactoryForTests(null);
  voiceNoteSpy.mockRestore();
  deliveryTracker.reset();
  setActiveWs(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// Scenario 1 — a TYPED message renders the user bubble, then the reply, in order.
// ===========================================================================
describe('integration: typed message full loop', () => {
  it('renders the user bubble on send, then the assistant reply, in transcript order', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);

    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'hello host' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    // The user's own message renders immediately (optimistic echo) — the host
    // never live-echoes user input.
    await waitFor(() => expect(bubbleTexts()).toContain('hello host'));
    // And it went out on the wire as a chat.input.
    expect(sentInputs(fake).some((e) => e.message === 'hello host')).toBe(true);

    // The host streams back only the assistant reply.
    const localId = sentInputs(fake).find((e) => e.message === 'hello host')!.localId;
    act(() => {
      fake.receive({ type: 'chat.input_ack', chatId: 'c1', localId } as WireEvent);
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'assistant',
        content: 'hi, how can I help?',
      } as WireEvent);
    });

    await waitFor(() => {
      const texts = bubbleTexts();
      expect(texts).toEqual(['hello host', 'hi, how can I help?']);
    });
    const msgs = bubbles();
    expect(msgs[0]!.classList.contains('msg-user')).toBe(true);
    expect(msgs[1]!.classList.contains('msg-assistant')).toBe(true);
  });
});

// ===========================================================================
// Scenario 2 — a VOICE NOTE renders the transcribed user turn, then the reply.
// This is the regression this whole suite exists for: the host injects the
// transcript as a user turn but streams back ONLY the assistant reply, so
// without the client echo (voiceController.sendVoiceNote → addLocalMessage) the
// user's transcribed message NEVER renders. MUST fail before the echo fix.
// ===========================================================================
describe('integration: voice-note full loop (the bug)', () => {
  it('renders the transcribed user turn AND the assistant reply', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);

    // REAL PROD PATH (D1): the transcript comes back in the POST /api/voice/note
    // HTTP response — NOT streamed over the audio WSS. No onTranscriptFinal is
    // ever delivered here; that dependency is exactly what left prod broken.
    voiceNoteSpy.mockResolvedValue({
      ok: true,
      transcript: 'remind me to buy milk',
      text: 'remind me to buy milk',
    });
    await act(async () => {
      await startVoiceNote('c1', 'toggle');
    });
    // Commit the note (release / ⏎) → upload → echo the returned transcript.
    await act(async () => {
      await sendVoiceNote();
    });
    expect(voiceNoteSpy).toHaveBeenCalledWith('c1', expect.any(Blob), '');

    // THE ASSERTION: the transcribed user turn renders in the transcript.
    await waitFor(() => expect(bubbleTexts()).toContain('remind me to buy milk'));
    const userMsg = bubbles().find((b) => b.classList.contains('msg-user'));
    expect(userMsg).toBeDefined();
    // ...and it renders as a SENT message, not a perpetual "Sending…" spinner
    // (the utterance was committed to the host; delivery is confirmed).
    expect(screen.queryByTestId('delivery-pending')).not.toBeInTheDocument();

    // The host's reply to the voice turn streams back and renders after it.
    act(() => {
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'assistant',
        content: 'Added a reminder to buy milk.',
      } as WireEvent);
    });
    await waitFor(() =>
      expect(bubbleTexts()).toEqual(['remind me to buy milk', 'Added a reminder to buy milk.']),
    );
  });
});

// ===========================================================================
// Scenario 3 — a VOICE CALL turn: the spoken YOU line renders in the transcript.
// Regression guard for the path that already works (voiceController startVoiceCall
// → onTranscriptFinal → addLocalMessage).
// ===========================================================================
describe('integration: voice-call turn renders the spoken line', () => {
  it('echoes the spoken YOU line into the transcript', async () => {
    await mountApp('/chats/c1', [makeRow('c1')]);

    await act(async () => {
      await startVoiceCall('c1');
    });
    expect(audioCallbacks).not.toBeNull();
    act(() => {
      audioCallbacks!.onTranscriptFinal('what is the weather today', true);
    });

    await waitFor(() => expect(bubbleTexts()).toContain('what is the weather today'));
    const userMsg = bubbles().find((b) => b.classList.contains('msg-user'));
    expect(userMsg?.textContent).toContain('what is the weather today');
  });
});

// ===========================================================================
// Scenario 4 — an image attachment on a user turn renders inline in the stream.
// ===========================================================================
describe('integration: image attachment renders in-stream', () => {
  it('renders an inline image for a user turn that carries an image attachment', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);
    const att: AttachmentRef = {
      id: 'img-1',
      name: 'sunset.png',
      mimeType: 'image/png',
      kind: 'image',
    };
    act(() => {
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'user',
        content: 'look at this',
        attachments: [att],
      } as WireEvent);
    });
    await waitFor(() => expect(bubbleTexts()).toContain('look at this'));
    // The image renders inline (spec/14 § Composer — attachments render inline).
    const img = await screen.findByTestId('msg-attachment-img');
    expect(within(img).getByRole('img')).toHaveAttribute('src', '/api/chats/c1/attachment/img-1');
  });
});

// ===========================================================================
// Scenario 5 — multi-turn ordering: two user turns and two replies interleave
// in the correct transcript order.
// ===========================================================================
describe('integration: multi-turn ordering', () => {
  it('renders alternating user/assistant turns in send order', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);
    const input = await screen.findByTestId('composer-input');

    fireEvent.change(input, { target: { value: 'first question' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(bubbleTexts()).toContain('first question'));
    act(() => {
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'assistant',
        content: 'first answer',
      } as WireEvent);
    });
    await waitFor(() => expect(bubbleTexts()).toContain('first answer'));

    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(bubbleTexts()).toContain('second question'));
    act(() => {
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'assistant',
        content: 'second answer',
      } as WireEvent);
    });

    await waitFor(() =>
      expect(bubbleTexts()).toEqual([
        'first question',
        'first answer',
        'second question',
        'second answer',
      ]),
    );
    void fake;
  });
});

// ===========================================================================
// Scenario 5b — Stop: a bare-stopped turn (nothing queued) says it was
// stopped and offers Continue (spec/14 § Running-turn controls). The host
// answers a bare stop with `chat.state{idle}` THEN `chat.stopped` (spec/09 §
// A turn the user stopped — the aborted run's own settle reaches idle before
// the stop announces), which is what tells the reducer this was a bare stop
// rather than a promote.
// ===========================================================================
describe('integration: stopping a turn with nothing queued marks it stopped and offers Continue', () => {
  it('renders the stopped status, settles the partial reply, and sends a fresh nudge on Continue', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);
    const input = await screen.findByTestId('composer-input');

    fireEvent.change(input, { target: { value: 'refactor the scheduler' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(bubbleTexts()).toContain('refactor the scheduler'));
    const firstLocalId = sentInputs(fake).find(
      (e) => e.message === 'refactor the scheduler',
    )!.localId;

    // The turn starts and half-streams a reply.
    act(() => {
      fake.receive({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity: 'running',
        lastUpdated: Date.now() + 1000,
      } as WireEvent);
      fake.receive({
        type: 'chat.message_delta',
        chatId: 'c1',
        messageSeq: 0,
        delta: 'Reading the',
      } as WireEvent);
    });

    // Tom hits Stop.
    fireEvent.click(await screen.findByTestId('stop-btn'));
    expect(fake.outbound().some((e) => e.type === 'chat.stop_request')).toBe(true);

    // The host interrupts and reports it — nothing else. A BARE stop settles
    // idle before announcing the stop (spec/09 § A turn the user stopped).
    act(() => {
      fake.receive({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: Date.now() + 2000,
      } as WireEvent);
      fake.receive({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' } as WireEvent);
    });

    const stopped = await screen.findByTestId('turn-stopped');
    expect(stopped).toHaveTextContent('Stopped.');
    // The partial reply is settled — no caret still promising more text.
    expect(document.querySelector('.stream-caret')).toBeNull();

    // Continue sends a FRESH nudge turn, not a resend of the stopped message.
    fireEvent.click(screen.getByTestId('turn-stopped-continue'));
    await waitFor(() => expect(sentInputs(fake).some((e) => e.message === 'Continue')).toBe(true));
    const nudge = sentInputs(fake).find((e) => e.message === 'Continue')!;
    expect(nudge.localId).not.toBe(firstLocalId);
    expect(sentInputs(fake).filter((e) => e.message === 'refactor the scheduler').length).toBe(1);
  });
});

// ===========================================================================
// Scenario 6 — send-while-running: a second turn sent while the chat is running
// renders QUEUED, then drains; both replies render (spec/04 ## Message queueing).
// ===========================================================================
describe('integration: send-while-running queues then drains', () => {
  it('renders the queued turn, drains it, and shows both replies', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);
    const input = await screen.findByTestId('composer-input');

    // Turn 1 — sent, chat goes running.
    fireEvent.change(input, { target: { value: 'turn one' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(bubbleTexts()).toContain('turn one'));
    act(() => {
      fake.receive({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity: 'running',
        lastUpdated: Date.now() + 1000,
      } as WireEvent);
    });

    // Turn 2 — sent WHILE running → the host queues it behind turn one.
    fireEvent.change(input, { target: { value: 'turn two' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(bubbleTexts()).toContain('turn two'));
    const turnTwoId = sentInputs(fake).find((e) => e.message === 'turn two')!.localId;
    act(() => {
      fake.receive({
        type: 'chat.queued',
        chatId: 'c1',
        localId: turnTwoId,
        message: 'turn two',
        queueSeq: 0,
      } as WireEvent);
    });
    // Turn two renders with the Queued chip.
    await waitFor(() => expect(screen.getByTestId('queued-badge')).toBeInTheDocument());

    // Turn one's reply arrives; then turn two dequeues (runs) and replies.
    act(() => {
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'assistant',
        content: 'answer one',
      } as WireEvent);
      fake.receive({
        type: 'chat.dequeued',
        chatId: 'c1',
        localId: turnTwoId,
        reason: 'running',
      } as WireEvent);
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'assistant',
        content: 'answer two',
      } as WireEvent);
    });

    // spec/04 ## Message queueing: the queued "turn two" stays BELOW the live
    // transcript while parked — it does not interleave above "answer one" (turn
    // one's reply, produced after turn two was queued) — and takes its place
    // once it dequeues and runs, so its position reflects when the agent became
    // aware of it, not when it was sent.
    await waitFor(() =>
      expect(bubbleTexts()).toEqual(['turn one', 'answer one', 'turn two', 'answer two']),
    );
    // The queue chip is gone once it dequeued.
    expect(screen.queryByTestId('queued-badge')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// Scenario 7 — reconnect/replay rebuilds the transcript INCLUDING the voice
// message, reconciling the optimistic echo against the persisted (tagged) copy
// so the voice turn is NOT shown twice (spec/12 § replay, chatStore reconcile).
// ===========================================================================
describe('integration: cold start loads metadata only (spec/12)', () => {
  it('hydrates the whole roster from ONE GET /api/chats and replays only the open chat', async () => {
    const rows = [makeRow('c1'), makeRow('c2'), makeRow('c3'), makeRow('c4')];
    const { fake } = await mountApp('/chats/c1', rows);

    // Every row is in the store — from the single metadata call, not from a
    // per-chat transcript stream.
    await waitFor(() => {
      for (const r of rows) expect(useChatStore.getState().chats[r.chatId]).toBeDefined();
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const rosterCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url) === '/api/chats' &&
        (!init || ((init as RequestInit).method ?? 'GET') === 'GET'),
    );
    expect(rosterCalls).toHaveLength(1);

    // Only the chat actually open asked for a transcript — the other three
    // metadata-only rows must not each pull an inbound event stream.
    const replayed = fake
      .outbound()
      .filter((e) => e.type === 'chat.replay')
      .map((e) => e.chatId);
    expect([...new Set(replayed)]).toEqual(['c1']);
  });

  it('replays nothing at all when no chat is open', async () => {
    const rows = [makeRow('c1'), makeRow('c2'), makeRow('c3')];
    const { fake } = await mountApp('/chats/new', rows);
    await waitFor(() => expect(useChatStore.getState().chats['c3']).toBeDefined());
    expect(fake.outbound().filter((e) => e.type === 'chat.replay')).toEqual([]);
  });
});

describe('integration: reconnect replay rebuilds transcript (voice turn reconciles)', () => {
  it('reconnects, replays persisted history, and does not duplicate the optimistic voice echo', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);

    // A voice note lands its optimistic echo in the transcript (upload path).
    voiceNoteSpy.mockResolvedValue({
      ok: true,
      transcript: 'book the dentist',
      text: 'book the dentist',
    });
    await act(async () => {
      await startVoiceNote('c1', 'toggle');
    });
    await act(async () => {
      await sendVoiceNote();
    });
    await waitFor(() => expect(bubbleTexts()).toContain('book the dentist'));

    // The socket drops — the client goes reconnecting and dials a NEW socket
    // after the backoff. Fake timers make the backoff advance deterministic (no
    // real 1s wait, no timeout-race under load).
    const before = FakeWs.instances.length;
    vi.useFakeTimers();
    act(() => {
      fake.close();
    });
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();
    expect(FakeWs.instances.length).toBeGreaterThan(before);
    const reconnected = FakeWs.instances[FakeWs.instances.length - 1]!;
    act(() => {
      reconnected.open();
      reconnected.receive({
        type: 'auth.ok',
        hosts: [],
        accountId: 'acc-1',
        surfaceId: 'web-1',
      } as WireEvent);
      reconnected.receive({ type: 'daemon.online', daemonId: 'd1' } as WireEvent);
    });
    // On reconnect the client asked to replay this chat.
    expect(reconnected.outbound().some((e) => e.type === 'chat.replay' && e.chatId === 'c1')).toBe(
      true,
    );

    // The host replays the PERSISTED history: the voice user turn (tagged
    // `[voice • web]`) + its reply. The tagged copy must reconcile against the
    // optimistic echo by content, not duplicate it.
    act(() => {
      reconnected.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'user',
        content: '[voice • web] book the dentist',
      } as WireEvent);
      reconnected.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'assistant',
        content: 'Booked for Tuesday.',
      } as WireEvent);
    });

    await waitFor(() => expect(bubbleTexts()).toEqual(['book the dentist', 'Booked for Tuesday.']));
    // Exactly ONE user bubble for the voice turn — the persisted copy reconciled.
    const userBubbles = bubbles().filter((b) => b.classList.contains('msg-user'));
    expect(userBubbles).toHaveLength(1);
  });
});

// ===========================================================================
// Scenario 8 — daemon-offline send renders "queued — will send when the agent
// reconnects", then delivers once the host is back (spec/12 § delivery).
// ===========================================================================
describe('integration: daemon-offline send renders queued then delivers', () => {
  it('shows the offline-queued affordance, then clears it and shows the reply on delivery', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);
    // Host goes offline (link still up).
    act(() => {
      fake.receive({ type: 'daemon.offline', daemonId: 'd1' } as WireEvent);
    });
    expect(usePresenceStore.getState().daemonOnline).toBe(false);

    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'send me later' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    // The turn renders with the daemon-offline queued affordance (NOT a bare
    // spinner, NOT lost).
    const pending = await screen.findByTestId('delivery-pending');
    expect(pending).toHaveTextContent(/queued.*reconnect/i);
    expect(pending).toHaveAttribute('data-daemon-offline', 'true');
    const localId = sentInputs(fake).find((e) => e.message === 'send me later')!.localId;

    // Host comes back — the surface redelivers (spec/12) and the host acks +
    // replies. The queued affordance clears and the reply renders.
    act(() => {
      fake.receive({ type: 'daemon.online', daemonId: 'd1' } as WireEvent);
      fake.receive({ type: 'chat.input_ack', chatId: 'c1', localId } as WireEvent);
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 0,
        role: 'assistant',
        content: 'got it, will do',
      } as WireEvent);
    });

    await waitFor(() => expect(screen.queryByTestId('delivery-pending')).not.toBeInTheDocument());
    // The ack clears the pending affordance synchronously, but the reply is a
    // STORE event and those are coalesced by one frame (ws.ts STORE_BATCH_MS),
    // so the bubble lands a tick after the affordance goes. Wait for it rather
    // than reading in the gap between the two.
    await waitFor(() => expect(bubbleTexts()).toEqual(['send me later', 'got it, will do']));
    // The redelivery went back out on the wire (same localId; host dedups).
    expect(sentInputs(fake).filter((e) => e.localId === localId).length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// spec/02 § System-reminder disclosure — a host restart cut a turn off and
// the resumed host re-sent it with a restart `<system-reminder>`, captured as
// `systemContext` on the re-send. The re-send folds onto the bubble the turn
// already has (spec/12), and the disclosure must come with it: the restart
// notice was being dropped in the fold, so it never rendered anywhere.
// ===========================================================================
describe('integration: a restart re-send shows its system context at the turn', () => {
  it('renders one bubble, retried once, with a collapsed restart disclosure that opens', async () => {
    const { fake } = await mountApp('/chats/c1', [makeRow('c1')]);

    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'tidy the garden notes' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(bubbleTexts()).toContain('tidy the garden notes'));
    const localId = sentInputs(fake).find((e) => e.message === 'tidy the garden notes')!.localId;

    act(() => {
      fake.receive({ type: 'chat.input_ack', chatId: 'c1', localId } as WireEvent);
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 2,
        role: 'user',
        content: 'tidy the garden notes',
        localId,
      } as WireEvent);
      // The host died mid-turn; the new one re-sends it.
      fake.receive({
        type: 'chat.message',
        chatId: 'c1',
        seq: 5,
        role: 'user',
        content: 'Carry on',
        retryOfSeq: 2,
        systemContext: [
          {
            source: 'patch',
            label: 'Turn interrupted by restart',
            text: 'This turn was already running when the host restarted.',
          },
        ],
      } as WireEvent);
    });

    await waitFor(() => expect(screen.getByTestId('system-context')).toBeInTheDocument());
    expect(bubbles()).toHaveLength(1);
    const bubble = bubbles()[0]!;
    expect(within(bubble).getByTestId('msg-meta-retries')).toHaveTextContent('Retried once');
    expect(within(bubble).getByTestId('system-context')).toHaveAttribute('data-open', 'false');
    expect(within(bubble).getByTestId('system-context-summary')).toHaveTextContent(
      'Turn interrupted by restart',
    );
    expect(screen.queryByTestId('system-context-detail')).not.toBeInTheDocument();

    fireEvent.click(within(bubble).getByTestId('system-context-summary'));
    expect(screen.getByTestId('system-context-detail')).toHaveTextContent(
      'This turn was already running when the host restarted.',
    );
  });
});
