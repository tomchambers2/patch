// Regression: ChatRoute must NOT throw React #185 (depth guard) when the
// timelines map has no entry for the active chatId. The bug was the
// selector returning a fresh `[]` on every call, breaking Object.is and
// causing infinite re-render. Hoisted EMPTY_TIMELINE fixes it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { api, ApiError, type ChatSummaryRow } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker.js';
import { useToolsStore } from '../stores/toolsStore.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

// G3-1/G3-4: opening the diff for a tool-call line fetches the FULL current
// on-disk file content (modified side) from the host so Save commits a whole
// file, not just the agent's edit hunk. Mock the content fetch.
// `ApiError` is kept REAL (re-exported from the actual module): ChatNotFound
// tells a 404 from any other failure with `instanceof`, so a stubbed class
// would never match and every failure would read as "chat not found".
vi.mock('../api/rest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/rest.js')>();
  return {
    ApiError: actual.ApiError,
    api: {
      markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
      getFileContent: vi.fn(async (_chatId: string, _path: string) => ({
        path: _path,
        content: 'const a = 2;\nconst b = 3;\n',
        size: 0,
      })),
      getFileContentAtHead: vi.fn(async (_chatId: string, _path: string) => ({
        path: _path,
        content: 'const a = 1;\nconst b = 3;\n',
        size: 0,
      })),
      // Looked up by ChatNotFound once the roster has landed without this chat.
      getChat: vi.fn((_chatId: string): Promise<unknown> => {
        throw new Error('api.getChat not stubbed for this test');
      }),
      checkHooks: vi.fn(async () => ({ decision: 'pass' as const, results: [] })),
      getSweepRuns: vi.fn(async () => ({ runs: [] })),
      checkSweepNow: vi.fn(async () => ({ fired: false })),
    },
  };
});

function seedChat(
  chatId: string,
  timeline: ChatEventEntry[],
  opts: { jobId?: string; activity?: 'idle' | 'running' } = {},
): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: opts.activity ?? 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: timeline } }));
}

// The card's own Approve button. "Approve all outstanding" is only drawn when
// the chat has more than one request outstanding (spec/14 § Permission
// prompts), so a single-card test resolves through this.
function clickApprove(card: HTMLElement = screen.getByTestId('permission')): void {
  const [approveBtn] = card.querySelectorAll('button');
  fireEvent.click(approveBtn!);
}

function renderChat(chatId: string, ws: Parameters<typeof ChatRoute>[0]['ws'] = null) {
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute regression', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.getState().clearFileDiff();
    useUiStore.setState({ pendingDiffByChat: {} });
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    permissionDeliveryTracker.reset();
    setActiveWs(null);
  });

  it('renders the empty state for an unknown chatId without crashing', () => {
    render(
      <MemoryRouter initialEntries={['/chats/does-not-exist']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>,
    );
    // The roster has not landed (`_reset()` in beforeEach), so this is the
    // loading state, not the dead end — see the "unknown chat" suite below.
    expect(screen.getByTestId('chat-main-loading')).toBeInTheDocument();
  });

  it('renders timeline and composer for a known chatId without re-render storm', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'one',
        folder: 'foo',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 0,
      },
    ]);
    render(
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('chat-main')).toBeInTheDocument();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('shows a read-only mirror (no composer) for thread_speakers (spec/06 composer policy)', () => {
    const chatId = 'thread_speakers';
    useChatStore.getState().hydrate([
      {
        chatId,
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'speakers',
        folder: 'speakers',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 0,
      },
    ]);
    render(
      <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('composer-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-readonly').textContent).toContain('voice device');
  });

  it('keeps the full composer for the Manager thread (spec/06 composer policy)', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'Manager',
        folder: 'manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 1,
        disabled: false,
        lastUpdated: 0,
      },
    ]);
    render(
      <MemoryRouter initialEntries={['/chats/thread_manager']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-readonly')).not.toBeInTheDocument();
  });

  // G5-d1: opening a long chat lands the stream on the LATEST message (bottom),
  // not the top of history. jsdom has no layout engine, so we fake the scroll
  // geometry and assert the route drove scrollTop to scrollHeight on mount.
  it('scrolls the stream to the latest message on open (G5-d1)', async () => {
    const longTimeline: ChatEventEntry[] = Array.from({ length: 60 }, (_v, i) => ({
      seq: i,
      kind: 'message' as const,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message number ${i}`,
      at: 0,
    }));
    seedChat('c-long', longTimeline);
    renderChat('c-long');
    const stream = screen.getByTestId('chat-stream');
    // Fake a viewport far smaller than the content (a long history).
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    // A new message arriving while in follow mode (fresh open) pins to bottom.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-long']: [
          ...longTimeline,
          { seq: 60, kind: 'message', role: 'assistant', content: 'latest', at: 0 },
        ],
      },
    }));
    // The follow effect schedules scrollToBottom via rAF.
    await waitFor(() => expect(stream.scrollTop).toBe(12000));
  });

  // G5-d1 corollary: once the user scrolls UP to read history, an incoming
  // message must NOT yank the view back to the bottom (follow disengages).
  it('does not auto-scroll when the user has scrolled up to read history', async () => {
    const base: ChatEventEntry[] = Array.from({ length: 40 }, (_v, i) => ({
      seq: i,
      kind: 'message' as const,
      role: 'user' as const,
      content: `m${i}`,
      at: 0,
    }));
    seedChat('c-hist', base);
    renderChat('c-hist');
    const stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    // Let the mount-time pin (and its self-scroll guard rAF) settle first.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // User scrolls up to the middle of history → follow turns off.
    stream.scrollTop = 2000;
    stream.dispatchEvent(new Event('scroll'));
    // A new message arrives.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-hist']: [
          ...base,
          { seq: 40, kind: 'message', role: 'assistant', content: 'new', at: 0 },
        ],
      },
    }));
    // Give rAF a chance; the view must STAY where the user parked it.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(2000);
  });

  // spec/14 § Main chat panel: sending a message re-pins to the bottom even if
  // the user had scrolled up — the sent turn + reply must be in view.
  it('scrolls to the bottom when the user sends a message, even after scrolling up', async () => {
    const base: ChatEventEntry[] = Array.from({ length: 40 }, (_v, i) => ({
      seq: i,
      kind: 'message' as const,
      role: 'user' as const,
      content: `m${i}`,
      at: 0,
    }));
    seedChat('c-send-scroll', base);
    renderChat('c-send-scroll');
    const stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // User scrolls up → follow off.
    stream.scrollTop = 2000;
    stream.dispatchEvent(new Event('scroll'));
    // User SENDS: an optimistic user turn (carries a `localId`) is appended.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-send-scroll']: [
          ...base,
          { seq: 40, kind: 'message', role: 'user', content: 'hello', localId: 'L-new', at: 0 },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // Re-pinned to the bottom despite the earlier scroll-up.
    expect(stream.scrollTop).toBe(12000);
  });

  // The echo is the last entry only at the instant it is appended. Anything the
  // turn emits next — here the permission-mode marker (spec/02 § Permission
  // mode) — shares the commit, and a re-pin that only ever reads
  // `timeline[length - 1]` stops firing the moment that happens.
  it('re-pins on send even when the sent echo is not the last timeline entry', async () => {
    const base: ChatEventEntry[] = Array.from({ length: 40 }, (_v, i) => ({
      seq: i,
      kind: 'message' as const,
      role: 'user' as const,
      content: `m${i}`,
      at: 0,
    }));
    seedChat('c-send-not-last', base);
    renderChat('c-send-not-last');
    const stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    stream.scrollTop = 2000;
    stream.dispatchEvent(new Event('scroll'));
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-send-not-last']: [
          ...base,
          { seq: 40, kind: 'message', role: 'user', content: 'hello', localId: 'L-nl', at: 0 },
          {
            seq: 41,
            kind: 'permission_mode',
            content: 'Permission mode: plan',
            permissionMode: 'plan',
            at: 0,
          },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(12000);
  });

  // Searching backwards for the newest still-pending echo must not re-yank the
  // stream when a NEWER echo reconciles away and an older unacked one becomes
  // the newest again — that turn was sent long ago and has already been
  // scrolled to.
  it('does not re-yank when a newer echo reconciles and an older pending one resurfaces', async () => {
    const base: ChatEventEntry[] = [
      { seq: 0, kind: 'message', role: 'user', content: 'first', localId: 'L-a', at: 0 },
      { seq: 1, kind: 'message', role: 'user', content: 'second', localId: 'L-b', at: 0 },
    ];
    seedChat('c-send-two', base);
    renderChat('c-send-two');
    const stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // The user goes back to read history → follow off.
    stream.scrollTop = 2000;
    stream.dispatchEvent(new Event('scroll'));
    // The SECOND send's persisted copy lands and clears its localId, making the
    // first send's still-pending echo the newest one carrying a localId again.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-send-two']: [
          base[0]!,
          { seq: 9, kind: 'message', role: 'user', content: 'second', at: 0 },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(2000);
  });

  it('ignores a scroll event that echoes our own programmatic scroll (self-scroll guard)', async () => {
    const base: ChatEventEntry[] = [
      { seq: 0, kind: 'message', role: 'user', content: 'hi', at: 0 },
    ];
    seedChat('c-self-scroll', base);
    renderChat('c-self-scroll');
    const stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    // A message arrives while following: the component scrolls to 12000.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-self-scroll']: [
          ...base,
          { seq: 1, kind: 'message', role: 'assistant', content: 'x', at: 0 },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(12000);
    // Fire a scroll event IMMEDIATELY that echoes exactly what we just set
    // scrollTop to — this must be ignored: it must NOT be misread as the user
    // scrolling away and disengaging follow mode.
    stream.dispatchEvent(new Event('scroll'));
    // Proof the echo was ignored (not proof by inspecting an internal ref):
    // follow mode is still engaged, so further growth keeps auto-scrolling.
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 15000 });
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-self-scroll']: [
          ...s.timelines['c-self-scroll']!,
          { seq: 2, kind: 'message', role: 'assistant', content: 'y', at: 0 },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(15000);
  });

  // Todoist: "when sending a message, does not reliably scroll all the way
  // to the bottom, still have to scroll down a bit further". Root cause: the
  // self-scroll guard used to clear itself on a fixed one-frame timer, on the
  // ASSUMPTION that the browser's own 'scroll' event for our assignment
  // always arrives before that timer fires. When it arrives late instead
  // (main thread busy right after a send — uploading-indicator layout,
  // markdown/tool-block measurement, etc.) the guard has already reopened,
  // so the late echo gets misread as the user scrolling away, permanently
  // disengaging follow mode even though the user never touched the scroll
  // position themselves — leaving the transcript short of the true bottom
  // until they scroll manually. The fix compares the event's scrollTop
  // against the exact value we last set (value-based), which holds
  // regardless of how many frames the browser takes to dispatch the echo.
  it('does not disengage follow mode when our own scroll echo is dispatched several frames late', async () => {
    const base: ChatEventEntry[] = [
      { seq: 0, kind: 'message', role: 'user', content: 'hi', at: 0 },
    ];
    seedChat('c-late-echo', base);
    renderChat('c-late-echo');
    const stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 9000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });

    // A message arrives while following: the component scrolls to 9000.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-late-echo']: [
          ...base,
          { seq: 1, kind: 'message', role: 'assistant', content: 'x', at: 0 },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(9000);

    // Let several more frames pass — long enough that a fixed one-frame
    // timing guard would already have reopened — before the browser's
    // 'scroll' event for that assignment actually arrives. Meanwhile more
    // content has arrived below the fold (scrollHeight grew) but nothing has
    // moved scrollTop yet, so this late echo still reports 9000.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    stream.dispatchEvent(new Event('scroll'));

    // Follow mode must still be engaged: the next timeline change re-pins to
    // the new bottom instead of leaving the view stranded at 9000.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-late-echo']: [
          ...s.timelines['c-late-echo']!,
          { seq: 2, kind: 'message', role: 'assistant', content: 'y', at: 0 },
        ],
      },
    }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(12000);
  });

  // Todoist: "when a response is streaming in and you try and scroll up to see
  // what's already loaded it's very juttery because you're fighting it trying
  // to pull down ... once you start to scroll up it should cancel scrolling to
  // the bottom". Two independent things made an upward scroll loseable, and
  // both are covered below.
  //
  // 1. The user's wheel delta and a re-pin can land in the same frame. The pin
  //    puts scrollTop back at the bottom and records it as OUR value, so the
  //    single scroll event the browser then dispatches echoes the pin exactly
  //    and is (correctly) swallowed by the self-scroll guard — the user's
  //    scroll is never seen at all. Intent has to be read from the INPUT, which
  //    nothing can race.
  describe('cancelling follow mode the instant the user scrolls up (spec/14 § Main chat panel)', () => {
    function seedStreamingChat(chatId: string): HTMLElement {
      seedChat(chatId, [{ seq: 0, kind: 'message', role: 'user', content: 'hi', at: 0 }]);
      renderChat(chatId);
      const stream = screen.getByTestId('chat-stream');
      Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
      Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
      return stream;
    }

    /** One more streaming chunk: the transcript grows and the bottom moves. */
    async function streamMore(chatId: string, seq: number, height: number): Promise<void> {
      Object.defineProperty(screen.getByTestId('chat-stream'), 'scrollHeight', {
        configurable: true,
        value: height,
      });
      useChatStore.setState((s) => ({
        timelines: {
          ...s.timelines,
          [chatId]: [
            ...s.timelines[chatId]!,
            { seq, kind: 'message', role: 'assistant', content: `chunk ${seq}`, at: 0 },
          ],
        },
      }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }

    it('a wheel up stops the auto-scroll even before the browser reports the new position', async () => {
      const stream = seedStreamingChat('c-wheel-up');
      await streamMore('c-wheel-up', 1, 12000);
      expect(stream.scrollTop).toBe(12000);

      // The user spins the wheel up. No 'scroll' event yet — this is the frame
      // in which the re-pin would otherwise swallow the whole gesture.
      stream.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));

      // The stream keeps growing. It must NOT pull the view down with it.
      await streamMore('c-wheel-up', 2, 15000);
      expect(stream.scrollTop).toBe(12000);
    });

    it('a wheel DOWN leaves follow mode alone', async () => {
      const stream = seedStreamingChat('c-wheel-down');
      await streamMore('c-wheel-down', 1, 12000);
      stream.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
      await streamMore('c-wheel-down', 2, 15000);
      expect(stream.scrollTop).toBe(15000);
    });

    it('a scroll-up key stops the auto-scroll', async () => {
      const stream = seedStreamingChat('c-key-up');
      await streamMore('c-key-up', 1, 12000);
      stream.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }));
      await streamMore('c-key-up', 2, 15000);
      expect(stream.scrollTop).toBe(12000);
    });

    // 2. The position test alone can't see a scroll up mid-stream: the content
    //    is growing under the user, so the first notch of a deliberate scroll
    //    up is still inside the 50px at-bottom band. A scroll event whose
    //    scrollTop moved UP is a user scroll wherever it lands — we only ever
    //    scroll DOWN, to the bottom.
    it('a scroll that moved UP disengages follow even while still within the at-bottom band', async () => {
      const stream = seedStreamingChat('c-small-scroll-up');
      await streamMore('c-small-scroll-up', 1, 12000);
      expect(stream.scrollTop).toBe(12000);

      // 20px up — comfortably inside the 50px "at bottom" slop.
      stream.scrollTop = 11980;
      stream.dispatchEvent(new Event('scroll'));

      await streamMore('c-small-scroll-up', 2, 15000);
      expect(stream.scrollTop).toBe(11980);
    });

    it('scrolling back down to the bottom re-engages follow', async () => {
      const stream = seedStreamingChat('c-scroll-back-down');
      await streamMore('c-scroll-back-down', 1, 12000);
      stream.scrollTop = 4000;
      stream.dispatchEvent(new Event('scroll'));
      await streamMore('c-scroll-back-down', 2, 15000);
      expect(stream.scrollTop).toBe(4000);

      // Back to the bottom under the user's own hand → following again.
      stream.scrollTop = 15000;
      stream.dispatchEvent(new Event('scroll'));
      await streamMore('c-scroll-back-down', 3, 18000);
      expect(stream.scrollTop).toBe(18000);
    });
  });

  it('renders a tool call collapsed by default and expands to full args (spec/14)', () => {
    seedChat('c-tool', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: {
          command: 'ls -la /secret/path',
          description: 'List the release files',
          timeout: 120000,
        },
        at: 0,
      },
    ]);
    renderChat('c-tool');
    const tc = screen.getByTestId('tool-call');
    // Collapsed: the summary says what the call is DOING (spec/14 — the call's
    // own description where it has one), not a bare "Bash".
    expect(tc.getAttribute('data-open')).toBe('false');
    expect(screen.queryByTestId('tool-call-detail')).not.toBeInTheDocument();
    expect(tc.textContent).toContain('Bash List the release files');
    // Everything the summary didn't name still waits for the expansion.
    expect(tc.textContent).not.toContain('/secret/path');
    expect(tc.textContent).not.toContain('120000');
    // Expand → full args appear.
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    expect(screen.getByTestId('tool-call-detail').textContent).toContain('/secret/path');
  });

  // A single call outside a run reads the same way a call inside one does —
  // the derivation is shared, so the row can't drift back to name-only.
  it('an ungrouped tool call with no description names what it acted on (spec/14)', () => {
    seedChat('c-tool-target', [
      { seq: 1, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'src/poll.ts' }, at: 0 },
    ]);
    renderChat('c-tool-target');
    expect(screen.getByTestId('tool-call').textContent).toContain('Read poll.ts');
  });

  it('an ungrouped tool call with nothing nameable stays the bare tool name (spec/14)', () => {
    seedChat('c-tool-bare', [
      { seq: 1, kind: 'tool_call', tool: 'TodoWrite', toolArgs: { todos: [] }, at: 0 },
    ]);
    renderChat('c-tool-bare');
    expect(screen.getByTestId('tool-call').textContent?.trim()).toBe('▸TodoWrite');
  });

  // The expanded detail formats args as key/value fields (ToolFields), not a
  // raw JSON blob — no braces/quotes-as-punctuation, one row per field.
  it('formats expanded tool-call args as key/value rows, not raw JSON', () => {
    seedChat('c-tool-fields', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: { command: 'ls -la', timeout: 5000 },
        at: 0,
      },
    ]);
    renderChat('c-tool-fields');
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    const detail = screen.getByTestId('tool-call-detail');
    // No JSON punctuation — this used to be JSON.stringify output.
    expect(detail.textContent).not.toContain('{');
    expect(detail.textContent).not.toContain('"command"');
    // Each field renders as its own row: key, then value.
    const rows = detail.querySelectorAll('.tool-field-row');
    expect(rows).toHaveLength(2);
    expect(detail.querySelector('.tool-field-key')?.textContent).toBe('command');
    expect(detail.textContent).toContain('ls -la');
    expect(detail.textContent).toContain('5000');
  });

  // A nested object/array value recurses into its own indented field list
  // rather than falling back to a JSON blob for that one field.
  it('formats a nested object arg as its own indented field list', () => {
    seedChat('c-tool-nested', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Fetch',
        toolArgs: { url: 'https://example.com', headers: { Authorization: 'Bearer x' } },
        at: 0,
      },
    ]);
    renderChat('c-tool-nested');
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    const detail = screen.getByTestId('tool-call-detail');
    expect(detail.textContent).not.toContain('{');
    // Outer row for "headers", inner row for "Authorization" nested inside it.
    const outerKeys = [...detail.querySelectorAll('.tool-field-key')].map((el) => el.textContent);
    expect(outerKeys).toEqual(expect.arrayContaining(['url', 'headers', 'Authorization']));
    expect(detail.textContent).toContain('Bearer x');
    // The nested list actually sits inside the "headers" row's value cell.
    const headersValue = [...detail.querySelectorAll('.tool-field-row')]
      .find((row) => row.querySelector('.tool-field-key')?.textContent === 'headers')
      ?.querySelector('.tool-field-value');
    expect(headersValue?.querySelector('.tool-fields')).not.toBeNull();
  });

  // An Anthropic image content block in a tool result renders as an actual
  // picture, not a dumped base64 string (Tom: "is it trying to show an
  // image?" — spec/14 § Tool calls).
  it('renders an image content block in a tool result as a picture, not raw base64', () => {
    seedChat('c-tool-image-result', [
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'Read',
        toolResult: {
          content: [
            { type: 'text', text: 'screenshot.png' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZS1wbmc=' },
            },
          ],
        },
        at: 0,
      },
    ]);
    renderChat('c-tool-image-result');
    fireEvent.click(screen.getByTestId('tool-result-summary'));
    const detail = screen.getByTestId('tool-result-detail');
    // No raw base64 text dumped anywhere in the detail pane.
    expect(detail.textContent).not.toContain('ZmFrZS1wbmc=');
    const img = screen.getByTestId('tool-field-image').querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,ZmFrZS1wbmc=');
    // Clicking it opens the same in-app lightbox a message attachment uses.
    fireEvent.click(screen.getByTestId('tool-field-image'));
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
  });

  // spec/04 § History — blobs. Replay sends tool output as a REFERENCE, never
  // a body: tool output is 85-99% of a long chat's bytes and these rows draw
  // collapsed. These cover what the surface does with a reference.
  it('renders a blob-backed image from its URL, with its box reserved before it loads', () => {
    const sha = 'a'.repeat(64);
    seedChat('c-tool-image-blob', [
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'Read',
        toolResult: {
          content: [
            { type: 'text', text: 'screenshot.png' },
            {
              type: 'image',
              source: {
                type: 'blob',
                $blob: sha,
                media_type: 'image/png',
                bytes: 4096,
                width: 390,
                height: 844,
              },
            },
          ],
        },
        at: 0,
      },
    ]);
    renderChat('c-tool-image-blob');
    fireEvent.click(screen.getByTestId('tool-result-summary'));
    const img = screen.getByTestId('tool-field-image').querySelector('img');
    expect(img?.getAttribute('src')).toBe(`/api/chats/c-tool-image-blob/blob/${sha}`);
    // The real pixel size, so nothing below the picture moves when it lands.
    expect(img?.getAttribute('width')).toBe('390');
    expect(img?.getAttribute('height')).toBe('844');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('fetches the body the moment the row is opened — no second click to read a tool result', async () => {
    const sha = 'b'.repeat(64);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stdout: 'the whole thing' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    seedChat('c-tool-blob-body', [
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'Bash',
        toolResult: { $blob: sha, bytes: 2_200_000, preview: 'the first part of it' },
        at: 0,
      },
    ]);
    renderChat('c-tool-blob-body');
    // Collapsed: the detail pane is not mounted, so nothing is fetched for a
    // row nobody opens — which is the whole reason replay omits the bodies.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('tool-result-summary'));
    expect(fetchMock).toHaveBeenCalledWith(`/api/chats/c-tool-blob-body/blob/${sha}`);
    // The preview and the cost are shown while it is in flight, not a blank.
    expect(screen.getByTestId('tool-blob')).toHaveTextContent('the first part of it');
    expect(screen.getByTestId('tool-blob-load')).toHaveTextContent('2.1 MB');
    await screen.findByText('the whole thing');
    vi.unstubAllGlobals();
  });

  it('says so when a blob body cannot be loaded, instead of passing the preview off as the whole result', async () => {
    const sha = 'c'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'host_offline' }),
    );
    seedChat('c-tool-blob-fail', [
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'Bash',
        toolResult: { $blob: sha, bytes: 1024, preview: 'start' },
        at: 0,
      },
    ]);
    renderChat('c-tool-blob-fail');
    fireEvent.click(screen.getByTestId('tool-result-summary'));
    fireEvent.click(screen.getByTestId('tool-blob-load'));
    const err = await screen.findByTestId('tool-blob-error');
    expect(err).toHaveTextContent('503');
    // And it offers to try again rather than silently settling for the preview.
    expect(screen.getByTestId('tool-blob-load')).toHaveTextContent('Retry');
    vi.unstubAllGlobals();
  });

  // Same image-block detection applies to a tool CALL's args, not just a
  // result's — e.g. an agent-composed image passed as input.
  it("renders an image content block in a tool call's args as a picture", () => {
    seedChat('c-tool-image-call', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'SomeTool',
        toolArgs: {
          image: {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
          },
        },
        at: 0,
      },
    ]);
    renderChat('c-tool-image-call');
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    const img = screen.getByTestId('tool-field-image').querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,abc123');
  });

  // G3-1: clicking a file-edit tool-call line opens the Monaco diff editor in
  // the right rail (not an inline diff in the stream). We assert the uiStore
  // fileDiff is populated with the correct change set; the EditorRail render
  // path is covered in EditorRail.test.tsx.
  it('opens the diff editor on the right rail when a file-edit tool call is clicked (spec/14 § Diff editor)', async () => {
    useUiStore.getState().clearFileDiff();
    seedChat('c-edit', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: {
          file_path: '/private/tmp/proj/src/a.ts',
          old_string: 'const a = 1;\nconst b = 3;\n',
          new_string: 'const a = 2;\nconst b = 3;\n',
        },
        at: 0,
      },
    ]);
    // Pin the chat to a folder so the absolute tool-call path resolves to a
    // chat-folder-relative path (the file.write contract).
    useChatStore.setState((s) => ({
      chats: { ...s.chats, ['c-edit']: { ...s.chats['c-edit']!, folder: '/private/tmp/proj' } },
    }));
    renderChat('c-edit');
    fireEvent.click(screen.getByTestId('tool-call-open-diff'));
    await waitFor(() => expect(useUiStore.getState().fileDiff).not.toBeNull());
    const fileDiff = useUiStore.getState().fileDiff;
    expect(fileDiff?.chatId).toBe('c-edit');
    const active = fileDiff!.changeSet[fileDiff!.activeIndex];
    // Path is RELATIVE to the chat folder (G3-4: host writes inside the folder).
    expect(active?.path).toBe('src/a.ts');
    // original = the agent's recorded baseline (old_string).
    expect(active?.original).toBe('const a = 1;\nconst b = 3;\n');
    // modified = the FULL current file content on disk, NOT the edit hunk
    // (so Save commits the whole file).
    expect(active?.modified).toBe('const a = 2;\nconst b = 3;\n');
  });

  it('a failure while opening the diff editor surfaces "editor: …" rather than throwing', async () => {
    useUiStore.getState().clearFileDiff();
    // The clicked entry (Edit on a.ts) decodes entirely from the stream (no
    // fetch needed). To exercise a genuine fetch failure, the SAME turn also
    // touches a second file via a whole-file Write (`content`, no old/new
    // string) — that file's baseline comes from git HEAD, which DOES fetch.
    vi.mocked(api.getFileContentAtHead).mockRejectedValueOnce(new Error('host unreachable'));
    seedChat('c-edit-fail', [
      { seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 },
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Write',
        toolArgs: { file_path: '/private/tmp/proj/src/newfile.ts', content: 'fresh content' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/src/a.ts', old_string: 'a', new_string: 'b' },
        at: 0,
      },
    ]);
    useChatStore.setState((s) => ({
      chats: {
        ...s.chats,
        ['c-edit-fail']: { ...s.chats['c-edit-fail']!, folder: '/private/tmp/proj' },
      },
    }));
    renderChat('c-edit-fail');
    fireEvent.click(screen.getByTestId('tool-call-open-diff'));
    await waitFor(() => {
      expect(
        useUiStore.getState().errors.some((e) => /editor: host unreachable/i.test(e.message)),
      ).toBe(true);
    });
    expect(useUiStore.getState().fileDiff).toBeNull();
  });

  it('renders a file-edit tool call collapsed by default, with a chevron to reveal the inline diff (spec/14 § Main chat panel — Diffs)', () => {
    seedChat('c-inline', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: {
          file_path: 'note.txt',
          old_string: 'hello world\n',
          new_string: 'hello patch\n',
        },
        at: 0,
      },
    ]);
    renderChat('c-inline');
    // Collapsed by default: no diff, same as every other tool call.
    expect(screen.queryByTestId('inline-diff')).toBeNull();
    const toggle = screen.getByTestId('tool-call-diff-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const diff = screen.getByTestId('inline-diff');
    expect(diff.getAttribute('data-path')).toBe('note.txt');
    const del = screen.getByTestId('diff-del-line');
    const add = screen.getByTestId('diff-add-line');
    expect(del.textContent).toContain('hello world');
    expect(add.textContent).toContain('hello patch');
    expect(del.classList.contains('diff-del')).toBe(true);
    expect(add.classList.contains('diff-add')).toBe(true);
    // Read-only preview: no inputs/buttons inside the inline diff itself.
    expect(diff.querySelector('input,textarea,button')).toBeNull();

    // Collapses again on a second click.
    fireEvent.click(toggle);
    expect(screen.queryByTestId('inline-diff')).toBeNull();
  });

  // Transcript redesign (spec/14 ## Main chat panel — two-sided conversation).
  // The USER / ASSISTANT caps labels are gone; user and assistant messages
  // render with distinct treatment, and the content sits in a capped, centred
  // reading column.
  it('renders a two-sided transcript with NO USER/ASSISTANT caps labels', () => {
    seedChat('c-two-sided', [
      { seq: 0, kind: 'message', role: 'user', content: 'hello there', at: 0 },
      { seq: 1, kind: 'message', role: 'assistant', content: 'hi, how can I help?', at: 0 },
    ]);
    const { container } = renderChat('c-two-sided');

    // The old caps-label element is gone entirely — nothing renders the literal
    // "user"/"assistant" role text as a label.
    expect(container.querySelector('.role')).toBeNull();

    // User and assistant messages carry their distinct role classes so they can
    // be styled as two sides (tinted bubble right vs flowing text left).
    const msgs = screen.getAllByTestId('msg');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.classList.contains('msg-user')).toBe(true);
    expect(msgs[1]?.classList.contains('msg-assistant')).toBe(true);

    // The readable-measure container wraps the transcript content.
    expect(container.querySelector('.chat-stream-content')).not.toBeNull();
  });

  // G2-d1: a user message containing internal [[…]] control markers must NOT
  // render the raw token as visible text in the bubble.
  it('does not leak [[edit]] / [[permission]] control tokens into a user bubble (G2-d1)', () => {
    seedChat('c-tokens', [
      { seq: 0, kind: 'message', role: 'user', content: 'please [[edit]] the file', at: 0 },
      { seq: 1, kind: 'message', role: 'user', content: 'now [[permission]] please', at: 0 },
    ]);
    renderChat('c-tokens');
    const bubbles = screen.getAllByTestId('msg-content');
    const text = bubbles.map((b) => b.textContent ?? '').join('\n');
    expect(text).not.toContain('[[edit]]');
    expect(text).not.toContain('[[permission]]');
    expect(text).not.toMatch(/\[\[[a-z]/i);
    // The surrounding human-readable text survives.
    expect(text).toContain('please the file');
    expect(text).toContain('now please');
  });

  // G2-d3/d4: a permission is shown by BOTH the inline card and the right-rail
  // DiffPanel; resolving the inline card must clear the right-rail pending diff
  // so there is no stale, still-actionable Approve/Deny (and no Monaco editor
  // left to dispose on click).
  it('clears the right-rail pending diff when the inline permission card is resolved (G2-d3/d4)', () => {
    seedChat('c-perm-diff', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-diff',
        permissionDescription: 'edit src/layout.ts',
        at: 0,
      },
    ]);
    // Mirror the ws.ts path that also populates the file tab's diff for the
    // same request.
    useUiStore.getState().setPendingDiff({
      requestId: 'req-diff',
      chatId: 'c-perm-diff',
      tool: 'Edit',
      filePath: 'src/layout.ts',
      original: 'const a = 1;',
      modified: 'const a = 2;',
    });
    expect(useUiStore.getState().pendingDiffByChat['c-perm-diff']).not.toBeUndefined();
    const ws = { send() {}, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm-diff', ws);
    clickApprove();
    // Inline card resolved AND the file tab's diff cleared (no orphaned control).
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
    expect(useUiStore.getState().pendingDiffByChat['c-perm-diff']).toBeUndefined();
  });

  it('renders a permission card with 1/3 affordances that resolve (spec/14)', () => {
    seedChat('c-perm', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-1',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    const ws = { send() {}, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm', ws);
    const card = screen.getByTestId('permission');
    const labels = Array.from(card.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.join(' ')).toContain('1');
    expect(labels.join(' ')).toContain('3');
    // Approve (1) resolves the prompt optimistically.
    clickApprove();
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
  });

  // spec/02 § Permission mode — while the SDK is mid Plan-Mode (the agent's
  // own `EnterPlanMode`, not a user choice), the permission card grows a 4th,
  // right-aligned escape hatch: approve this one AND drop the chat back to
  // bypass for what comes after, in one click.
  it('shows an "Approve & resume bypass" escape hatch only while the chat reads plan mode', () => {
    const send = vi.fn();
    useChatStore.getState().hydrate([
      {
        chatId: 'c-perm-plan',
        daemonId: 'd1',
        permissionMode: 'plan' as const,
        name: 'c-perm-plan',
        folder: 'foo',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 0,
      },
    ]);
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        'c-perm-plan': [
          {
            seq: 1,
            kind: 'permission',
            tool: 'Bash',
            requestId: 'req-plan-1',
            permissionDescription: 'git rev-parse --show-toplevel',
            at: 0,
          },
        ],
      },
    }));
    const ws = { send, requestReplay() {} } as unknown as Parameters<typeof ChatRoute>[0]['ws'];
    // The escape hatch sends over `getActiveWs()` (same pattern as the
    // Composer's mode dropdown), which in production is the same connection
    // as the `ws` prop (`AppShell.tsx` wires both to one instance) — mirror
    // that here rather than only passing `ws` as a prop.
    setActiveWs(ws);
    renderChat('c-perm-plan', ws);
    const card = screen.getByTestId('permission');
    const labels = Array.from(card.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Approve 1', 'Deny 3', 'Approve & resume bypass 4']);

    fireEvent.click(screen.getByTestId('permission-approve-resume-bypass'));
    expect(card.getAttribute('data-resolved')).toBe('approve');
    expect(send.mock.calls.map(([f]) => f).filter((f) => !f.type.startsWith('meeting.'))).toEqual([
      {
        type: 'chat.permission_response',
        chatId: 'c-perm-plan',
        requestId: 'req-plan-1',
        approve: true,
      },
      { type: 'chat.settings', chatId: 'c-perm-plan', permissionMode: 'bypassPermissions' },
    ]);
  });

  // Tom, Todoist: "what does approve all actually do in patch, need to be
  // clearer" → on a lone approval the sweep is indistinguishable from Approve,
  // and its old name read like a mode. It is not drawn at all here.
  it('hides the approve-all sweep while only one request is outstanding (spec/14)', () => {
    seedChat('c-perm-one', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-only',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    renderChat('c-perm-one');
    expect(screen.queryByTestId('permission-approve-all')).toBeNull();
    const labels = Array.from(screen.getByTestId('permission').querySelectorAll('button')).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Approve 1', 'Deny 3']);
  });

  it('offers "Approve all outstanding" on every card once two requests are outstanding, and sweeps both (spec/14)', () => {
    const send = vi.fn();
    seedChat('c-perm-two', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-a', at: 0 },
      { seq: 2, kind: 'permission', tool: 'Bash', requestId: 'req-b', at: 0 },
    ]);
    renderChat('c-perm-two', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    const sweeps = screen.getAllByTestId('permission-approve-all');
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]!.textContent).toBe('Approve all outstanding 2');

    fireEvent.click(sweeps[0]!);
    expect(screen.getAllByTestId('permission').map((c) => c.getAttribute('data-resolved'))).toEqual(
      ['approve', 'approve'],
    );
    expect(send.mock.calls.map(([f]) => f)).toEqual([
      { type: 'chat.permission_response', chatId: 'c-perm-two', requestId: 'req-a', approve: true },
      { type: 'chat.permission_response', chatId: 'c-perm-two', requestId: 'req-b', approve: true },
    ]);
  });

  it('drops the sweep again once resolving leaves a single request outstanding (spec/14)', () => {
    seedChat('c-perm-two-then-one', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-c', at: 0 },
      { seq: 2, kind: 'permission', tool: 'Bash', requestId: 'req-d', at: 0 },
    ]);
    renderChat('c-perm-two-then-one', {
      send: vi.fn(),
      requestReplay() {},
    } as unknown as Parameters<typeof ChatRoute>[0]['ws']);
    expect(screen.getAllByTestId('permission-approve-all')).toHaveLength(2);
    // Answer one on its own: a resolved request is no longer outstanding, so
    // the remaining card is back to a plain Approve / Deny.
    clickApprove(screen.getAllByTestId('permission')[0]!);
    expect(screen.queryByTestId('permission-approve-all')).toBeNull();
  });

  it('auto-focuses the permission card so 1/2/3 chords fire without a click (spec/14 § Keyboard shortcuts, "Permission shown")', async () => {
    seedChat('c-perm-focus', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-focus',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    const ws = { send() {}, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm-focus', ws);
    const card = screen.getByTestId('permission');
    // The card grabs focus on mount so the documented shortcuts work immediately.
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it('resolves a permission via the 1 (approve) keyboard chord on the focused card (spec/14)', () => {
    seedChat('c-perm-key-approve', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-key-a',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    const ws = { send() {}, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm-key-approve', ws);
    const card = screen.getByTestId('permission');
    fireEvent.keyDown(card, { key: '1' });
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
  });

  it('resolves a permission via the 3 (deny) keyboard chord on the focused card (spec/14)', () => {
    seedChat('c-perm-key-deny', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-key-d',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    const ws = { send() {}, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm-key-deny', ws);
    const card = screen.getByTestId('permission');
    fireEvent.keyDown(card, { key: '3' });
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('deny');
  });

  it('resolves a permission via the 2 (approve-all) keyboard chord on the focused card', () => {
    seedChat('c-perm-key-2', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-key-2',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    const ws = { send() {}, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm-key-2', ws);
    const card = screen.getByTestId('permission');
    fireEvent.keyDown(card, { key: '2' });
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
  });

  it('ignores keyboard chords once the permission is already resolved, or has no requestId', () => {
    seedChat('c-perm-resolved-key', [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-resolved',
        permissionDescription: 'edit src/a.ts',
        permissionResolved: 'approve',
        at: 0,
      },
    ]);
    const ws = { send: vi.fn(), requestReplay: vi.fn() } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws'];
    renderChat('c-perm-resolved-key', ws);
    const card = screen.getByTestId('permission');
    fireEvent.keyDown(card, { key: '1' });
    // Still approve (unchanged) — no re-send, no crash.
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
    expect((ws as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('resolves a permission via the single Approve button (not approve-all)', () => {
    const send = vi.fn();
    seedChat('c-perm-single-approve', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-sa', at: 0 },
    ]);
    renderChat('c-perm-single-approve', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    const [approveBtn] = screen.getByTestId('permission').querySelectorAll('button');
    fireEvent.click(approveBtn!);
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
    expect(send).toHaveBeenCalledWith({
      type: 'chat.permission_response',
      chatId: 'c-perm-single-approve',
      requestId: 'req-sa',
      approve: true,
    });
  });

  it('resolves a permission via the single Deny button', () => {
    const send = vi.fn();
    seedChat('c-perm-single-deny', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-sd', at: 0 },
    ]);
    renderChat('c-perm-single-deny', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    const buttons = screen.getByTestId('permission').querySelectorAll('button');
    const denyBtn = buttons[buttons.length - 1];
    fireEvent.click(denyBtn!);
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('deny');
    expect(send).toHaveBeenCalledWith({
      type: 'chat.permission_response',
      chatId: 'c-perm-single-deny',
      requestId: 'req-sd',
      approve: false,
    });
  });

  it('renders a permission card with no description (no trailing " — ..." suffix)', () => {
    seedChat('c-perm-nodesc', [
      { seq: 1, kind: 'permission', tool: 'Bash', requestId: 'req-nd', at: 0 },
    ]);
    renderChat('c-perm-nodesc');
    expect(screen.getByTestId('permission').textContent).toBe('BashApprove 1Deny 3');
  });

  it('a permission approve with no connected ws surfaces "not connected" and stays unresolved', () => {
    seedChat('c-perm-nows', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-nows', at: 0 },
    ]);
    renderChat('c-perm-nows', null);
    clickApprove();
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBeNull();
    expect(useUiStore.getState().errors.some((e) => /not connected/i.test(e.message))).toBe(true);
  });

  it('a permission approve whose ws.send throws still resolves optimistically and is held for redelivery', () => {
    // Tom, Todoist: "questions are timing out after I answer them" — a send
    // that fails at the moment of the tap (a zombie link, a mid-reconnect
    // socket) used to block the card AND surface an error the user could do
    // nothing useful with. It now resolves the card like any other answer and
    // lets `permissionDeliveryTracker` redeliver once the link is good,
    // rather than leaving an already-answered question stuck looking pending.
    const send = vi.fn(() => {
      throw new Error('socket gone');
    });
    seedChat('c-perm-throws', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-throws', at: 0 },
    ]);
    renderChat('c-perm-throws', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    clickApprove();
    expect(screen.getByTestId('permission').getAttribute('data-resolved')).toBe('approve');
    expect(useUiStore.getState().errors.some((e) => /permission failed/i.test(e.message))).toBe(
      false,
    );
    // Still pending delivery — the host never actually heard the first
    // attempt land.
    expect(permissionDeliveryTracker.size()).toBe(1);
  });

  it('resolving a permission with no matching pending diff leaves it untouched (both no-diff and mismatched-request cases)', () => {
    // Case 1: no pending diff at all.
    seedChat('c-perm-nodiff', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-nodiff', at: 0 },
    ]);
    renderChat('c-perm-nodiff', { send: vi.fn(), requestReplay: vi.fn() } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    clickApprove();
    expect(useUiStore.getState().pendingDiffByChat['c-perm-nodiff']).toBeUndefined();
  });

  it('resolving a permission whose requestId does not match the pending diff leaves the diff untouched', () => {
    seedChat('c-perm-mismatch', [
      { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-mismatch', at: 0 },
    ]);
    useUiStore.getState().setPendingDiff({
      requestId: 'some-other-request',
      chatId: 'c-perm-mismatch',
      tool: 'Edit',
      filePath: 'src/x.ts',
      original: 'a',
      modified: 'b',
    });
    renderChat('c-perm-mismatch', {
      send: vi.fn(),
      requestReplay: vi.fn(),
    } as unknown as Parameters<typeof ChatRoute>[0]['ws']);
    clickApprove();
    expect(useUiStore.getState().pendingDiffByChat['c-perm-mismatch']?.requestId).toBe(
      'some-other-request',
    );
  });

  // ---- Composer wiring: send / stop / unqueue / retry ----

  it('sends a message through the composer: optimistic echo + ws chat.input', async () => {
    const send = vi.fn();
    seedChat('c-send', []);
    renderChat('c-send', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hello host' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat.input', chatId: 'c-send', message: 'hello host' }),
      ),
    );
    const timeline = useChatStore.getState().timelines['c-send'];
    expect(
      timeline?.some(
        (e) => e.kind === 'message' && e.role === 'user' && e.content === 'hello host',
      ),
    ).toBe(true);
  });

  it('carries the per-chat Tools panel OFF set onto the chat.input (patch/todo — turn tools off)', async () => {
    const send = vi.fn();
    useToolsStore.getState()._reset();
    useToolsStore.getState().toggle('c-tools-send', 'Bash');
    seedChat('c-tools-send', []);
    renderChat('c-tools-send', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'run something' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat.input', disabledTools: ['Bash'] }),
      ),
    );
    useToolsStore.getState()._reset();
  });

  it('sends no disabledTools when every tool is on (default)', async () => {
    const send = vi.fn();
    useToolsStore.getState()._reset();
    seedChat('c-tools-none', []);
    renderChat('c-tools-none', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      expect.not.objectContaining({ disabledTools: expect.anything() }),
    );
  });

  it('sending with no connected ws surfaces "not connected" and does not touch the timeline', () => {
    seedChat('c-send-nows', []);
    renderChat('c-send-nows', null);
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(useUiStore.getState().errors.some((e) => /not connected/i.test(e.message))).toBe(true);
    expect(useChatStore.getState().timelines['c-send-nows']?.length ?? 0).toBe(0);
  });

  it('Stop button sends chat.stop_request while the chat is running', () => {
    const send = vi.fn();
    seedChat('c-stop', [{ seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    useChatStore.setState((s) => ({
      chats: { ...s.chats, ['c-stop']: { ...s.chats['c-stop']!, activity: 'running' } },
    }));
    renderChat('c-stop', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    fireEvent.click(screen.getByTestId('stop-btn'));
    expect(send).toHaveBeenCalledWith({ type: 'chat.stop_request', chatId: 'c-stop' });
  });

  it('Stop with no connected ws surfaces "not connected"', () => {
    seedChat('c-stop-nows', [{ seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    useChatStore.setState((s) => ({
      chats: { ...s.chats, ['c-stop-nows']: { ...s.chats['c-stop-nows']!, activity: 'running' } },
    }));
    renderChat('c-stop-nows', null);
    fireEvent.click(screen.getByTestId('stop-btn'));
    expect(useUiStore.getState().errors.some((e) => /not connected/i.test(e.message))).toBe(true);
  });

  it('Stop whose ws.send throws surfaces "stop failed: …"', () => {
    const send = vi.fn(() => {
      throw new Error('closed');
    });
    seedChat('c-stop-throws', [{ seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    useChatStore.setState((s) => ({
      chats: {
        ...s.chats,
        ['c-stop-throws']: { ...s.chats['c-stop-throws']!, activity: 'running' },
      },
    }));
    renderChat('c-stop-throws', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    fireEvent.click(screen.getByTestId('stop-btn'));
    expect(
      useUiStore
        .getState()
        .errors.some((e) => /stop failed. try again. closed/i.test(`${e.message} ${e.detail}`)),
    ).toBe(true);
  });

  it('removes a queued (type-ahead) turn via its × affordance and fires chat.unqueue_request', () => {
    const send = vi.fn();
    seedChat('c-unqueue', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'queued turn',
        queued: true,
        localId: 'Q1',
        at: 0,
      },
    ]);
    renderChat('c-unqueue', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    expect(screen.getByTestId('queued-badge')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('queued-remove'));
    expect(send).toHaveBeenCalledWith({
      type: 'chat.unqueue_request',
      chatId: 'c-unqueue',
      localId: 'Q1',
    });
    expect(useChatStore.getState().timelines['c-unqueue']?.some((e) => e.localId === 'Q1')).toBe(
      false,
    );
  });

  it('unqueue with no ws still removes locally, without throwing', () => {
    seedChat('c-unqueue-nows', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', queued: true, localId: 'Q2', at: 0 },
    ]);
    renderChat('c-unqueue-nows', null);
    fireEvent.click(screen.getByTestId('queued-remove'));
    expect(
      useChatStore.getState().timelines['c-unqueue-nows']?.some((e) => e.localId === 'Q2'),
    ).toBe(false);
  });

  it('unqueue whose ws.send throws surfaces "unqueue failed: …" (local removal already happened)', () => {
    const send = vi.fn(() => {
      throw new Error('down');
    });
    seedChat('c-unqueue-throws', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', queued: true, localId: 'Q3', at: 0 },
    ]);
    renderChat('c-unqueue-throws', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    fireEvent.click(screen.getByTestId('queued-remove'));
    expect(
      useUiStore
        .getState()
        .errors.some((e) => /unqueue failed. try again. down/i.test(`${e.message} ${e.detail}`)),
    ).toBe(true);
  });

  // spec/04 ## Message queueing § Promote — the ↑ affordance on a queued turn.
  it('promotes a queued turn via its ↑ affordance: fires chat.promote_request WITHOUT reordering the queued block', () => {
    const send = vi.fn();
    seedChat('c-promote', [
      { seq: 1, kind: 'message', role: 'user', content: 'settled', at: 0 },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: 'first',
        queued: true,
        localId: 'Q1',
        at: 0,
      },
      {
        seq: 3,
        kind: 'message',
        role: 'user',
        content: 'second',
        queued: true,
        localId: 'Q2',
        at: 0,
      },
    ]);
    renderChat('c-promote', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    // Promote the SECOND queued turn.
    fireEvent.click(screen.getAllByTestId('queued-promote')[1]!);
    expect(send).toHaveBeenCalledWith({
      type: 'chat.promote_request',
      chatId: 'c-promote',
      localId: 'Q2',
    });
    const ids = useChatStore.getState().timelines['c-promote']?.map((e) => e.localId);
    // Q1 (queued above Q2) is pushed along with it too, not shoved behind it —
    // the host is the sole authority on queue order, so nothing local moves.
    expect(ids).toEqual([undefined, 'Q1', 'Q2']);
  });

  it('promote with no ws does not throw, and does not reorder the queue', () => {
    seedChat('c-promote-nows', [
      { seq: 1, kind: 'message', role: 'user', content: 'a', queued: true, localId: 'P1', at: 0 },
      { seq: 2, kind: 'message', role: 'user', content: 'b', queued: true, localId: 'P2', at: 0 },
    ]);
    renderChat('c-promote-nows', null);
    fireEvent.click(screen.getAllByTestId('queued-promote')[1]!);
    expect(useChatStore.getState().timelines['c-promote-nows']?.map((e) => e.localId)).toEqual([
      'P1',
      'P2',
    ]);
  });

  it('promote whose ws.send throws surfaces "promote failed: …"', () => {
    const send = vi.fn(() => {
      throw new Error('down');
    });
    seedChat('c-promote-throws', [
      { seq: 1, kind: 'message', role: 'user', content: 'a', queued: true, localId: 'R1', at: 0 },
      { seq: 2, kind: 'message', role: 'user', content: 'b', queued: true, localId: 'R2', at: 0 },
    ]);
    renderChat('c-promote-throws', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    fireEvent.click(screen.getAllByTestId('queued-promote')[1]!);
    expect(
      useUiStore
        .getState()
        .errors.some((e) => /promote failed. try again. down/i.test(`${e.message} ${e.detail}`)),
    ).toBe(true);
  });

  // spec/04 ## Message queueing — sending never interrupts. 2026-09-29: every
  // message Tom sent into a running turn killed it 1-2s later, via ⌘↵'s
  // send-and-promote or a second ↵ in the emptied composer promoting the
  // message just sent. Only Stop, Esc and a queued message's ↑ interrupt.
  // `dev-harness.tsx` renders ChatRoute with `ws={null}`, so the frames are
  // only observable here.
  describe('sending while a turn runs only queues (spec/04 § Message queueing)', () => {
    function wsMock(send: ReturnType<typeof vi.fn>) {
      return { send, requestReplay() {} } as unknown as Parameters<typeof ChatRoute>[0]['ws'];
    }
    const types = (send: ReturnType<typeof vi.fn>): string[] =>
      send.mock.calls.map((c) => (c[0] as { type: string }).type);

    it('⌘↵ and Ctrl+↵ with text send the input and nothing else', async () => {
      const send = vi.fn();
      seedChat('c-cmd-running', [{ seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 }], {
        activity: 'running',
      });
      renderChat('c-cmd-running', wsMock(send));
      const composer = screen.getByTestId('composer-input');
      fireEvent.change(composer, { target: { value: 'actually do this' } });
      fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
      fireEvent.change(composer, { target: { value: 'and this' } });
      fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(types(send).filter((t) => t === 'chat.input')).toHaveLength(2));
      expect(types(send)).not.toContain('chat.promote_request');
      expect(types(send)).not.toContain('chat.stop_request');
    });

    it('↵ then another ↵ (or ⌘↵) on the emptied composer sends once and interrupts nothing', async () => {
      const send = vi.fn();
      seedChat(
        'c-double-enter',
        [
          { seq: 1, kind: 'message', role: 'user', content: 'running', at: 0 },
          {
            seq: 2,
            kind: 'message',
            role: 'user',
            content: 'first',
            queued: true,
            localId: 'H1',
            at: 0,
          },
        ],
        { activity: 'running' },
      );
      renderChat('c-double-enter', wsMock(send));
      const composer = screen.getByTestId('composer-input');
      fireEvent.change(composer, { target: { value: 'still slow' } });
      fireEvent.keyDown(composer, { key: 'Enter' });
      fireEvent.keyDown(composer, { key: 'Enter' });
      fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
      await waitFor(() => expect(types(send).filter((t) => t === 'chat.input')).toHaveLength(1));
      expect(types(send)).not.toContain('chat.promote_request');
    });

    it('the queued ↑ still promotes — the deliberate interrupt stays', () => {
      const send = vi.fn();
      seedChat(
        'c-up-still',
        [
          { seq: 1, kind: 'message', role: 'user', content: 'running', at: 0 },
          {
            seq: 2,
            kind: 'message',
            role: 'user',
            content: 'first',
            queued: true,
            localId: 'U1',
            at: 0,
          },
        ],
        { activity: 'running' },
      );
      renderChat('c-up-still', wsMock(send));
      const up = screen.getByTestId('queued-promote');
      expect(up).toHaveAttribute('title', 'Run next');
      fireEvent.click(up);
      expect(send).toHaveBeenCalledWith({
        type: 'chat.promote_request',
        chatId: 'c-up-still',
        localId: 'U1',
      });
    });
  });

  it('a queued message with no localId shows the Queued badge but no remove control', () => {
    seedChat('c-queued-nolocal', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', queued: true, at: 0 },
    ]);
    renderChat('c-queued-nolocal');
    expect(screen.getByTestId('queued-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('queued-remove')).not.toBeInTheDocument();
  });

  // spec/04 ## Message queueing — the chip says WHEN a queued turn goes in.
  it('numbers the queued block: the head reads "Queued" and the rest read their place in the line', () => {
    seedChat('c-queue-pos', [
      { seq: 1, kind: 'message', role: 'user', content: 'settled', at: 0 },
      { seq: 2, kind: 'message', role: 'assistant', content: 'reply', at: 0 },
      { seq: 3, kind: 'message', role: 'user', content: 'a', queued: true, localId: 'N1', at: 0 },
      { seq: 4, kind: 'message', role: 'user', content: 'b', queued: true, localId: 'N2', at: 0 },
      { seq: 5, kind: 'message', role: 'user', content: 'c', queued: true, localId: 'N3', at: 0 },
    ]);
    renderChat('c-queue-pos');
    // Counted over the queued block only — the settled turns above it do not
    // push the first queued message to "3rd".
    expect(screen.getAllByTestId('queued-badge').map((el) => el.textContent)).toEqual([
      'Queued',
      '2nd in queue',
      '3rd in queue',
    ]);
  });

  it('names the event that releases each queued turn', () => {
    seedChat('c-queue-why', [
      { seq: 1, kind: 'message', role: 'user', content: 'a', queued: true, localId: 'W1', at: 0 },
      { seq: 2, kind: 'message', role: 'user', content: 'b', queued: true, localId: 'W2', at: 0 },
    ]);
    renderChat('c-queue-why');
    const chips = screen.getAllByTestId('queued-badge');
    expect(chips[0]).toHaveAttribute('title', 'Runs when the current turn finishes');
    expect(chips[1]).toHaveAttribute(
      'title',
      'Runs after the current turn and 1 message ahead of it',
    );
  });

  it('renumbers the queued block immediately when a turn is removed', () => {
    seedChat('c-queue-renumber-rm', [
      { seq: 1, kind: 'message', role: 'user', content: 'a', queued: true, localId: 'D1', at: 0 },
      { seq: 2, kind: 'message', role: 'user', content: 'b', queued: true, localId: 'D2', at: 0 },
    ]);
    renderChat('c-queue-renumber-rm', null);
    // Drop the head; the one behind it is promoted into its place.
    fireEvent.click(screen.getAllByTestId('queued-remove')[0]!);
    const chips = screen.getAllByTestId('queued-badge');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe('Queued');
  });

  // spec/04 ## Message queueing — waiting on a running turn and waiting on the
  // host to reconnect are different states and must not read alike.
  it('words the queued chip differently from the daemon-offline pending line', () => {
    usePresenceStore.getState().setHostOnline('d1', false);
    seedChat('c-queue-vs-offline', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', deliveryPending: true, at: 0 },
      { seq: 2, kind: 'message', role: 'user', content: 'y', queued: true, localId: 'V1', at: 0 },
    ]);
    renderChat('c-queue-vs-offline');
    const chip = screen.getByTestId('queued-badge');
    expect(chip).toHaveTextContent('Queued');
    // The offline line owns the "reconnect" wording; the chip must not echo it —
    // that's what actually tells the two states apart, not the shared "Queued" word.
    expect(screen.getByTestId('delivery-pending')).toHaveTextContent(/reconnect/i);
    expect(chip.textContent).not.toMatch(/reconnect/i);
  });

  // spec/04 ## Message queueing — nothing interrupts on a timer. The 30s
  // auto-interrupt countdown is gone (2026-09-29: queued messages must wait
  // for the running turn, not cut it off).
  it('a queued message never interrupts the running turn by itself', () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      seedChat(
        'c-no-auto',
        [
          { seq: 1, kind: 'message', role: 'user', content: 'long job', at: 0 },
          {
            seq: 2,
            kind: 'message',
            role: 'user',
            content: 'next',
            queued: true,
            localId: 'A1',
            at: 0,
          },
        ],
        { activity: 'running' },
      );
      renderChat('c-no-auto', { send, requestReplay() {} } as unknown as Parameters<
        typeof ChatRoute
      >[0]['ws']);
      act(() => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(send.mock.calls.map((c) => (c[0] as { type: string }).type)).not.toContain(
        'chat.promote_request',
      );
      expect(document.querySelector('.queued-countdown')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('taps "retry" on a failed delivery, which re-sends the same localId over the active ws', () => {
    const send = vi.fn();
    seedChat('c-retry', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'retry me',
        localId: 'L-retry',
        deliveryFailed: true,
        at: 0,
      },
    ]);
    // Seed the tracker's own pending-entry bookkeeping so `retry()` finds it
    // (mirrors a real failed delivery: submit() was called, then the timeout
    // path called failDelivery without ever removing the pending entry).
    deliveryTracker.submit('c-retry', 'retry me', 'L-retry');
    setActiveWs({ send, requestReplay() {} } as unknown as Parameters<typeof ChatRoute>[0]['ws']);
    renderChat('c-retry');
    expect(screen.getByTestId('delivery-failed')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delivery-retry'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        chatId: 'c-retry',
        message: 'retry me',
        localId: 'L-retry',
      }),
    );
  });

  it('a delivery-failed message with no localId shows the failed state but no retry control', () => {
    seedChat('c-failed-nolocal', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', deliveryFailed: true, at: 0 },
    ]);
    renderChat('c-failed-nolocal');
    expect(screen.getByTestId('delivery-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-retry')).not.toBeInTheDocument();
  });

  it('a turnFailed message (sdk_error, spec/12) renders the same failed treatment as an undelivered one, with no bare error-code row', () => {
    seedChat('c-turn-failed', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'do the thing',
        localId: 'L-turn',
        turnFailed: true,
        turnErrorMessage: 'something broke',
        turnFailedSeq: 5,
        at: 0,
      },
    ]);
    renderChat('c-turn-failed');
    expect(screen.getByTestId('turn-failed')).toBeInTheDocument();
    expect(screen.getByTestId('turn-failed')).toHaveTextContent('Turn failed.');
    // Not the old standalone raw-error-code row.
    expect(screen.queryByText('something broke')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delivery-failed')).not.toBeInTheDocument();
  });

  it('tapping "retry" on a turnFailed message resends its text as a NEW turn (fresh localId), not the old one', () => {
    const send = vi.fn();
    seedChat('c-turn-retry', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'do the thing',
        localId: 'L-turn-old',
        turnFailed: true,
        turnErrorMessage: 'something broke',
        turnFailedSeq: 5,
        at: 0,
      },
    ]);
    renderChat('c-turn-retry', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    fireEvent.click(screen.getByTestId('turn-retry'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        chatId: 'c-turn-retry',
        message: 'do the thing',
      }),
    );
    const sentLocalId = send.mock.calls[0]?.[0]?.localId;
    expect(sentLocalId).toBeDefined();
    expect(sentLocalId).not.toBe('L-turn-old');
    // The retried message appears as a fresh, non-failed optimistic entry.
    const tl = useChatStore.getState().timelines['c-turn-retry'] ?? [];
    const fresh = tl.find((e) => e.localId === sentLocalId);
    expect(fresh?.turnFailed).toBeUndefined();
  });

  // spec/14 § Running-turn controls — a bare-stopped turn is an outcome. The
  // host emits no reply and no error for it, so the message must say it was
  // stopped and offer Continue — never "retry", which would resubmit text the
  // agent already has in context.
  it('a turnStopped message shows the stopped status (muted, not the failed line) with Continue', () => {
    seedChat('c-turn-stopped', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'refactor the scheduler',
        turnStopped: true,
        at: 0,
      },
    ]);
    renderChat('c-turn-stopped');
    const line = screen.getByTestId('turn-stopped');
    expect(line).toHaveTextContent('Stopped.');
    expect(line).not.toHaveTextContent(/cancelled/i);
    expect(screen.getByTestId('turn-stopped-continue')).toHaveTextContent('Continue');
    // Not an error: it must not borrow the failed treatment.
    expect(screen.queryByTestId('turn-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delivery-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('msg')).toHaveAttribute('data-turn-stopped', 'true');
  });

  // spec/14 § Running-turn controls — a turn cut off by a promoted message is
  // muted with NO action: the agent already saw it via the promoted turn's own
  // run, so there is nothing to retry and nothing to continue.
  it('a turnInterrupted message shows a muted status with no action', () => {
    seedChat('c-turn-interrupted', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'rename the config module',
        turnInterrupted: true,
        at: 0,
      },
    ]);
    renderChat('c-turn-interrupted');
    const line = screen.getByTestId('turn-interrupted');
    expect(line).toHaveTextContent('Interrupted.');
    expect(line).not.toHaveTextContent(/cancelled/i);
    const msg = screen.getByTestId('msg');
    expect(msg).toHaveAttribute('data-turn-interrupted', 'true');
    expect(screen.queryByTestId('turn-stopped-continue')).not.toBeInTheDocument();
    expect(line.querySelector('button')).toBeNull();
  });

  it('tapping "Continue" on a stopped message sends a fresh nudge turn, not the original text', () => {
    const send = vi.fn();
    seedChat('c-stop-continue', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'refactor the scheduler',
        localId: 'L-stop-old',
        turnStopped: true,
        at: 0,
      },
    ]);
    renderChat('c-stop-continue', { send, requestReplay() {} } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);
    fireEvent.click(screen.getByTestId('turn-stopped-continue'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        chatId: 'c-stop-continue',
        message: 'Continue',
      }),
    );
    // A fresh turn, not a resend of the original — the agent already has the
    // original message in context, and resubmitting it would duplicate it.
    const sentLocalId = send.mock.calls[0]?.[0]?.localId;
    expect(sentLocalId).toBeDefined();
    expect(sentLocalId).not.toBe('L-stop-old');
    const tl = useChatStore.getState().timelines['c-stop-continue'] ?? [];
    const fresh = tl.find((e) => e.localId === sentLocalId);
    expect(fresh?.content).toBe('Continue');
  });

  it('a failed turn keeps the failed line even if it is also marked stopped (the error is the stronger signal)', () => {
    seedChat('c-stop-and-failed', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'x',
        turnFailed: true,
        turnErrorMessage: 'boom',
        turnFailedSeq: 3,
        turnStopped: true,
        at: 0,
      },
    ]);
    renderChat('c-stop-and-failed');
    expect(screen.getByTestId('turn-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-stopped')).not.toBeInTheDocument();
  });

  it('shows "Sending…" for a delivery-pending message while the host is online', () => {
    usePresenceStore.getState().setHostOnline('d1', true);
    seedChat('c-pending-online', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', deliveryPending: true, at: 0 },
    ]);
    renderChat('c-pending-online');
    expect(screen.getByTestId('delivery-pending')).toHaveTextContent('Sending…');
  });

  it('shows "queued — will send when the agent reconnects" while the host is offline', () => {
    usePresenceStore.getState().setHostOnline('d1', false);
    seedChat('c-pending-offline', [
      { seq: 1, kind: 'message', role: 'user', content: 'x', deliveryPending: true, at: 0 },
    ]);
    renderChat('c-pending-offline');
    expect(screen.getByTestId('delivery-pending')).toHaveTextContent(/queued.*reconnect/i);
  });

  it('a deliveryPending AND queued message shows only the Queued chip, not the pending line', () => {
    seedChat('c-pending-and-queued', [
      {
        seq: 1,
        kind: 'message',
        role: 'user',
        content: 'x',
        deliveryPending: true,
        queued: true,
        at: 0,
      },
    ]);
    renderChat('c-pending-and-queued');
    expect(screen.getByTestId('queued-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-pending')).not.toBeInTheDocument();
  });

  // ---- TimelineEntry message-shape edge cases ----

  it('a message that is ENTIRELY a control token, with no attachments and not streaming, renders nothing', () => {
    seedChat('c-empty-strip', [
      { seq: 0, kind: 'message', role: 'user', content: '[[permission]]', at: 0 },
      { seq: 1, kind: 'message', role: 'user', content: 'visible', at: 0 },
    ]);
    renderChat('c-empty-strip');
    const msgs = screen.getAllByTestId('msg');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.textContent).toContain('visible');
  });

  it('a still-streaming message with entirely-control-token content is still rendered (with the caret)', () => {
    seedChat('c-streaming-empty', [
      { seq: 0, kind: 'message', role: 'assistant', content: '[[edit]]', streaming: true, at: 0 },
    ]);
    renderChat('c-streaming-empty');
    expect(screen.getByTestId('msg')).toBeInTheDocument();
    expect(document.querySelector('.stream-caret')).not.toBeNull();
  });

  it('a message with content omitted entirely (undefined) is treated as empty text, not a crash', () => {
    seedChat('c-content-undefined', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        streaming: true, // kept despite empty text — streaming entries always render
        at: 0,
      },
    ]);
    renderChat('c-content-undefined');
    expect(screen.getByTestId('msg-content').textContent).toBe('');
  });

  it('an image-only message (no text) still renders because it carries attachments', () => {
    seedChat('c-image-only', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: '',
        attachments: [{ id: 'att1', name: 'pic.png', mimeType: 'image/png', kind: 'image' }],
        at: 0,
      },
    ]);
    renderChat('c-image-only');
    expect(screen.getByTestId('msg')).toBeInTheDocument();
    expect(screen.getByTestId('msg-attachments')).toBeInTheDocument();
  });

  it('a file (non-image) attachment renders as a link to the served copy', () => {
    seedChat('c-file-att', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'see attached',
        attachments: [{ id: 'att2', name: 'notes.txt', mimeType: 'text/plain', kind: 'file' }],
        at: 0,
      },
    ]);
    renderChat('c-file-att');
    const link = screen.getByTestId('msg-attachment-file');
    expect(link).toHaveAttribute('href', '/api/chats/c-file-att/attachment/att2');
    expect(link).toHaveTextContent('notes.txt');
  });

  it('clicking an inline image attachment opens the in-app lightbox; Escape/backdrop/close-button all close it', () => {
    seedChat('c-lightbox', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: '',
        attachments: [{ id: 'att3', name: 'photo.png', mimeType: 'image/png', kind: 'image' }],
        at: 0,
      },
    ]);
    renderChat('c-lightbox');
    fireEvent.click(screen.getByTestId('msg-attachment-img'));
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
    // Close via the × button.
    fireEvent.click(screen.getByTestId('lightbox-close'));
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();
    // Reopen, close via Escape.
    fireEvent.click(screen.getByTestId('msg-attachment-img'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();
    // Reopen, close via backdrop click.
    fireEvent.click(screen.getByTestId('msg-attachment-img'));
    fireEvent.click(screen.getByTestId('image-lightbox'));
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();
  });

  it('lightbox renders at the document root, so it fills the whole window instead of being trapped inside the chat panel', () => {
    seedChat('c-lightbox-portal', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: '',
        attachments: [{ id: 'att6', name: 'wide.png', mimeType: 'image/png', kind: 'image' }],
        at: 0,
      },
    ]);
    renderChat('c-lightbox-portal');
    fireEvent.click(screen.getByTestId('msg-attachment-img'));
    const box = screen.getByTestId('image-lightbox');
    // `.chat-main` sets `contain: layout`, which makes it the containing block
    // for any `position: fixed` descendant — an in-tree overlay would be
    // clipped to the chat panel. Portalling to <body> escapes that.
    expect(box.parentElement).toBe(document.body);
    expect(screen.getByTestId('msg-attachments').contains(box)).toBe(false);
    // Closing still tears the portal down.
    fireEvent.click(screen.getByTestId('lightbox-close'));
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();
  });

  it('lightbox: wheel zooms in, clicking the image toggles zoom, and dragging pans while zoomed', () => {
    seedChat('c-lightbox-zoom', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: '',
        attachments: [{ id: 'att4', name: 'zoom.png', mimeType: 'image/png', kind: 'image' }],
        at: 0,
      },
    ]);
    renderChat('c-lightbox-zoom');
    fireEvent.click(screen.getByTestId('msg-attachment-img'));
    const img = document.querySelector('.lightbox-img') as HTMLElement;
    // Click toggles to 2.5x zoom (scale > 1 → cursor grab, transform includes scale).
    fireEvent.click(img);
    expect(img.style.transform).toContain('scale(2.5)');
    // Click again resets to fit (scale 1).
    fireEvent.click(img);
    expect(img.style.transform).toContain('scale(1)');
    // A wheel event that lands exactly back on scale 1 (deltaY 0, already at
    // scale 1) re-centers the offset — the `next === 1` reset branch.
    fireEvent.wheel(img, { deltaY: 0 });
    expect(img.style.transform).toContain('translate(0px, 0px) scale(1)');
    // Wheel zooms toward >1 (the handler lives on the backdrop; the event
    // bubbles up from the image).
    fireEvent.wheel(img, { deltaY: -100 });
    expect(img.style.transform).not.toContain('scale(1)');
    // Click back to exactly fit (1), then re-zoom deterministically to 2.5x
    // for the drag assertion below.
    fireEvent.click(img); // scale > 1 → resets to 1
    fireEvent.click(img); // scale === 1 → zooms to 2.5x
    expect(img.style.transform).toContain('scale(2.5)');
    // Drag: pointerDown/Move/Up while zoomed pans the offset.
    (img as unknown as { setPointerCapture: () => void }).setPointerCapture = vi.fn();
    fireEvent.pointerDown(img, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 130, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(img, { pointerId: 1 });
    expect(img.style.transform).toContain('translate(30px, -10px)');
  });

  it('lightbox: pointerMove/pointerDown while NOT zoomed is a no-op (no pan)', () => {
    seedChat('c-lightbox-nozoom', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: '',
        attachments: [{ id: 'att5', name: 'flat.png', mimeType: 'image/png', kind: 'image' }],
        at: 0,
      },
    ]);
    renderChat('c-lightbox-nozoom');
    fireEvent.click(screen.getByTestId('msg-attachment-img'));
    const img = document.querySelector('.lightbox-img') as HTMLElement;
    fireEvent.pointerDown(img, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 80, clientY: 80, pointerId: 1 });
    expect(img.style.transform).toContain('translate(0px, 0px)');
  });

  // A call and its own result are ONE event, not two rows (Tom: "tool call
  // appears twice — once as the invocation and once as the result").
  it('folds a tool call and its own result into a single row (spec/14)', () => {
    seedChat('c-tool-paired', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Read',
        callId: 'call-1',
        toolArgs: { file_path: 'src/poll.ts' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'Read',
        callId: 'call-1',
        toolResult: { content: [{ type: 'text', text: 'export const poll = 1;' }] },
        at: 1,
      },
    ]);
    renderChat('c-tool-paired');
    // Exactly ONE row, and it is the call's — no second "Read →" line.
    expect(screen.getAllByTestId('tool-call')).toHaveLength(1);
    expect(screen.queryByTestId('tool-result')).not.toBeInTheDocument();
    // Collapsed by default; the result lives inside the same disclosure.
    expect(screen.getByTestId('tool-call').getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    expect(screen.getByTestId('tool-call-result').textContent).toContain('export const poll = 1;');
  });

  // Pairing is by callId, so a result that isn't this call's must not be
  // swallowed into it — it still gets its own row.
  it('does not fold a tool result belonging to a different call', () => {
    seedChat('c-tool-unpaired', [
      { seq: 1, kind: 'tool_call', tool: 'Read', callId: 'a', toolArgs: { file_path: 'x' }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Bash', callId: 'b', toolResult: { code: 0 }, at: 1 },
    ]);
    renderChat('c-tool-unpaired');
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
    expect(screen.getByTestId('tool-result')).toBeInTheDocument();
  });

  // A running call has no result yet — it must still render on its own.
  it('renders a tool call with no result yet as a plain row', () => {
    seedChat('c-tool-pending', [
      { seq: 1, kind: 'tool_call', tool: 'Read', callId: 'a', toolArgs: { file_path: 'x' }, at: 0 },
    ]);
    renderChat('c-tool-pending');
    expect(screen.getByTestId('tool-call').textContent).toContain('Read x');
    expect(screen.queryByTestId('tool-call-result')).not.toBeInTheDocument();
  });

  // An array's positions are not field names. Labelling them printed a literal
  // "0:" above every element — most visibly under a Read image result, whose
  // payload is the two-element content array [text, image] (Tom: "0: artifact").
  it("does not label a content array's elements with their indices", () => {
    seedChat('c-tool-noindex', [
      {
        seq: 1,
        kind: 'tool_result',
        tool: 'Read',
        toolResult: {
          content: [
            { type: 'text', text: 'artifact' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZS1wbmc=' },
            },
          ],
        },
        at: 0,
      },
    ]);
    renderChat('c-tool-noindex');
    fireEvent.click(screen.getByTestId('tool-result-summary'));
    const detail = screen.getByTestId('tool-result-detail');
    // The index keys are gone entirely — no <dt> renders "0" or "1".
    const keys = Array.from(detail.querySelectorAll('.tool-field-key')).map((k) => k.textContent);
    expect(keys).not.toContain('0');
    expect(keys).not.toContain('1');
    // The content itself still renders: the text, and the image as a picture.
    expect(detail.textContent).toContain('artifact');
    expect(screen.getByTestId('tool-field-image')).toBeInTheDocument();
  });

  // Object keys are real field names and must keep their labels.
  it('still labels object fields with their keys', () => {
    seedChat('c-tool-objkeys', [
      { seq: 1, kind: 'tool_result', tool: 'Bash', toolResult: { stdout: 'ok' }, at: 0 },
    ]);
    renderChat('c-tool-objkeys');
    fireEvent.click(screen.getByTestId('tool-result-summary'));
    const keys = Array.from(
      screen.getByTestId('tool-result-detail').querySelectorAll('.tool-field-key'),
    ).map((k) => k.textContent);
    expect(keys).toContain('stdout');
  });

  // spec/14 § Viewing files — view_file exists to SHOW a file, so the row is
  // the file, not a disclosure that has to be opened first. A page has no
  // lightbox equivalent, so it stays a sandboxed iframe with an expand control.
  it('renders a view_file html result inline as a sandboxed frame', () => {
    seedChat('c-view-file', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'view_file',
        callId: 'v1',
        toolArgs: { file_path: 'plants.html' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'view_file',
        callId: 'v1',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'html',
                url: '/api/chats/c-view-file/artifact/abc123',
                name: 'plants.html',
              }),
            },
          ],
        },
        at: 1,
      },
    ]);
    renderChat('c-view-file');
    const card = screen.getByTestId('view-file');
    expect(card.getAttribute('data-kind')).toBe('html');
    const frame = screen.getByTestId('view-file-frame');
    expect(frame.getAttribute('src')).toBe('/api/chats/c-view-file/artifact/abc123');
    // Sandboxed WITHOUT allow-same-origin: agent-named content can never reach
    // the SPA's stored credential.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    // Expands to a bigger frame rather than opening a lightbox.
    expect(card.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('view-file-expand'));
    expect(screen.getByTestId('view-file').getAttribute('data-expanded')).toBe('true');
  });

  // spec/14 § Viewing files — a PDF gets the same sandboxed-iframe treatment
  // as an HTML page (not the image/lightbox path), since neither is a
  // lightbox candidate.
  it('renders a view_file pdf result inline as a sandboxed frame', () => {
    seedChat('c-view-file-pdf', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'view_file',
        callId: 'v1',
        toolArgs: { file_path: 'invoice.pdf' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'view_file',
        callId: 'v1',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'pdf',
                url: '/api/chats/c-view-file-pdf/artifact/abc123',
                name: 'invoice.pdf',
              }),
            },
          ],
        },
        at: 1,
      },
    ]);
    renderChat('c-view-file-pdf');
    const card = screen.getByTestId('view-file');
    expect(card.getAttribute('data-kind')).toBe('pdf');
    const frame = screen.getByTestId('view-file-frame');
    expect(frame.getAttribute('src')).toBe('/api/chats/c-view-file-pdf/artifact/abc123');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.queryByTestId('view-file-image')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('view-file-expand'));
    expect(screen.getByTestId('view-file').getAttribute('data-expanded')).toBe('true');
  });

  // spec/14 § Viewing files — an image `view_file` result renders as an actual
  // picture, click-to-open in the same full-screen lightbox as any other
  // inline image, not a sandboxed iframe.
  it('renders a view_file image result as a picture that opens the lightbox', () => {
    seedChat('c-view-file-img', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'view_file',
        callId: 'v1',
        toolArgs: { file_path: 'shot.png' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'view_file',
        callId: 'v1',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'image',
                url: '/api/chats/c-view-file-img/artifact/abc123',
                name: 'shot.png',
              }),
            },
          ],
        },
        at: 1,
      },
    ]);
    renderChat('c-view-file-img');
    const card = screen.getByTestId('view-file');
    expect(card.getAttribute('data-kind')).toBe('image');
    // No iframe for an image — no expand-height toggle either, the lightbox
    // is the way to see it full-size.
    expect(screen.queryByTestId('view-file-frame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('view-file-expand')).not.toBeInTheDocument();
    const picture = screen.getByTestId('view-file-image');
    expect(picture.querySelector('img')?.getAttribute('src')).toBe(
      '/api/chats/c-view-file-img/artifact/abc123',
    );
    expect(screen.queryByTestId('image-lightbox')).not.toBeInTheDocument();
    fireEvent.click(picture);
    const lightbox = screen.getByTestId('image-lightbox');
    expect(lightbox).toBeInTheDocument();
    expect(lightbox.querySelector('img')?.getAttribute('src')).toBe(
      '/api/chats/c-view-file-img/artifact/abc123',
    );
  });

  // The regression this exists to stop: agents batch their calls, so a
  // view_file almost always lands beside other tool calls. Folded into a run it
  // renders as a line of text and the picture is only mounted if the reader
  // expands it — which is the whole point of the tool, lost.
  it('keeps a view_file out of a collapsed tool run, next to other calls', () => {
    seedChat('c-view-grouped', [
      { seq: 1, kind: 'tool_call', tool: 'Bash', callId: 'b1', toolArgs: { command: 'ls' }, at: 0 },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'Bash',
        callId: 'b1',
        toolResult: { stdout: '' },
        at: 1,
      },
      {
        seq: 3,
        kind: 'tool_call',
        tool: 'mcp__patch__view_file',
        callId: 'v1',
        toolArgs: { file_path: 'shot.png' },
        at: 2,
      },
      {
        seq: 4,
        kind: 'tool_result',
        tool: 'mcp__patch__view_file',
        callId: 'v1',
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                kind: 'image',
                url: '/api/chats/c-view-grouped/artifact/abc123',
                name: 'shot.png',
              }),
            },
          ],
        },
        at: 3,
      },
      {
        seq: 5,
        kind: 'tool_call',
        tool: 'Bash',
        callId: 'b2',
        toolArgs: { command: 'pwd' },
        at: 4,
      },
      {
        seq: 6,
        kind: 'tool_result',
        tool: 'Bash',
        callId: 'b2',
        toolResult: { stdout: '/' },
        at: 5,
      },
    ]);
    renderChat('c-view-grouped');
    // Shown without anything being expanded first.
    const picture = screen.getByTestId('view-file-image');
    expect(picture.querySelector('img')?.getAttribute('src')).toBe(
      '/api/chats/c-view-grouped/artifact/abc123',
    );
    // And it is not inside a run's collapsed detail.
    for (const group of screen.queryAllByTestId('tool-group')) {
      expect(group.contains(picture)).toBe(false);
    }
  });

  // The shape a real batch has: every call, THEN every result. No call is next
  // to its own result, which is what defeated the first fix — the row rendered
  // separately but stayed a collapsed disclosure, because pairing only looked at
  // the entry immediately after the call.
  //
  // Fed the payload a REAL chat delivers — the bare content-block array (see the
  // bare-array test below), and `kind: 'html'`, because that combination is what
  // was reported broken in production: a `.html` one-pager viewed alongside a
  // `Bash` call. The envelope-shaped batch this test used to feed passed
  // throughout, which is exactly why the regression stayed invisible.
  it('renders a view_file batched with other calls, results arriving after them all', () => {
    seedChat('c-view-batch', [
      { seq: 1, kind: 'tool_call', tool: 'Bash', callId: 'b1', toolArgs: { command: 'ls' }, at: 0 },
      {
        seq: 2,
        kind: 'tool_call',
        tool: 'mcp__patch__view_file',
        callId: 'v1',
        toolArgs: { file_path: 'projects/dog-safety/poisons-one-pager.html' },
        at: 1,
      },
      {
        seq: 3,
        kind: 'tool_call',
        tool: 'Bash',
        callId: 'b2',
        toolArgs: { command: 'pwd' },
        at: 2,
      },
      {
        seq: 4,
        kind: 'tool_result',
        tool: 'Bash',
        callId: 'b1',
        toolResult: { stdout: '' },
        at: 3,
      },
      {
        seq: 5,
        kind: 'tool_result',
        tool: 'mcp__patch__view_file',
        callId: 'v1',
        toolResult: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              shown: true,
              kind: 'html',
              url: '/api/chats/c-view-batch/artifact/abc123',
              name: 'poisons-one-pager.html',
              path: 'projects/dog-safety/poisons-one-pager.html',
            }),
          },
        ],
        at: 4,
      },
      {
        seq: 6,
        kind: 'tool_result',
        tool: 'Bash',
        callId: 'b2',
        toolResult: { stdout: '/' },
        at: 5,
      },
    ]);
    renderChat('c-view-batch');
    const frame = screen.getByTestId('view-file-frame');
    expect(frame.getAttribute('src')).toBe('/api/chats/c-view-batch/artifact/abc123');
    expect(screen.getByTestId('view-file').getAttribute('data-kind')).toBe('html');
    for (const group of screen.queryAllByTestId('tool-group')) {
      expect(group.contains(frame)).toBe(false);
    }
    // The result was consumed by the file's row, so it is not also a row of its
    // own — one call, one thing on screen.
    expect(screen.queryAllByTestId('view-file')).toHaveLength(1);
  });

  // The shape a LIVE chat actually delivers: `chatRunner.ts` puts the SDK
  // block's own `content` on `ChatToolResultEvent.result`, so a surface gets
  // the content-block array with no `{ content }` wrapper around it. Every
  // other test here feeds the envelope, which is why this regressed unseen.
  it('renders view_file when the result is the bare content-block array', () => {
    seedChat('c-view-bare', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'mcp__patch__view_file',
        callId: 'v1',
        toolArgs: { file_path: 'map-b.jpg' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'mcp__patch__view_file',
        callId: 'v1',
        toolResult: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              shown: true,
              kind: 'image',
              url: '/api/chats/c-view-bare/artifact/17f6de',
              name: 'map-b.jpg',
              path: 'map-b.jpg',
            }),
          },
        ],
        at: 1,
      },
    ]);
    renderChat('c-view-bare');
    const card = screen.getByTestId('view-file');
    expect(card.getAttribute('data-kind')).toBe('image');
    expect(screen.getByTestId('view-file-image').querySelector('img')?.getAttribute('src')).toBe(
      '/api/chats/c-view-bare/artifact/17f6de',
    );
    // It replaces the tool row rather than sitting beside it.
    expect(screen.queryByTestId('tool-call-summary')).not.toBeInTheDocument();
  });

  // No fallback: a malformed/failed view_file result must NOT silently render
  // an empty frame — it falls back to the ordinary tool row so the error shows.
  it('renders a failed view_file as an ordinary tool row, not an empty frame', () => {
    seedChat('c-view-file-err', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'view_file',
        callId: 'v1',
        toolArgs: { file_path: 'notes.txt' },
        at: 0,
      },
      {
        seq: 2,
        kind: 'tool_result',
        tool: 'view_file',
        callId: 'v1',
        toolResult: { error: 'invalid_input', message: 'view_file shows images and .html' },
        at: 1,
      },
    ]);
    renderChat('c-view-file-err');
    expect(screen.queryByTestId('view-file')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    expect(screen.getByTestId('tool-call-result').textContent).toContain('invalid_input');
  });

  it('renders a tool_result entry collapsed with a JSON detail on expand', () => {
    seedChat('c-tool-result', [
      { seq: 1, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0, stdout: 'ok' }, at: 0 },
    ]);
    renderChat('c-tool-result');
    const tr = screen.getByTestId('tool-result');
    expect(tr.getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByTestId('tool-result-summary'));
    expect(screen.getByTestId('tool-result-detail').textContent).toContain('stdout');
  });

  // spec/14 § Context compression — one quiet line, not a message bubble, with
  // the same disclosure a tool call uses.
  it('renders a compaction as a collapsed one-line disclosure rather than a message', () => {
    seedChat('c-compact', [
      {
        seq: 1,
        kind: 'compaction',
        content: 'Context compressed · 168k → 42k',
        compaction: { trigger: 'auto', preTokens: 168165, postTokens: 42118, durationMs: 3200 },
        at: 0,
      },
    ]);
    renderChat('c-compact');
    const row = screen.getByTestId('compaction');
    expect(row.getAttribute('data-open')).toBe('false');
    expect(screen.getByTestId('compaction-summary').textContent).toContain(
      'Context compressed · 168k → 42k',
    );
    // Transcript furniture: no bubble, no role header.
    expect(document.querySelector('.msg')).toBeNull();
    // Collapsed means collapsed — the figures are not on screen yet.
    expect(screen.queryByTestId('compaction-detail')).toBeNull();
  });

  it('reveals the exact figures on expand', () => {
    seedChat('c-compact-open', [
      {
        seq: 1,
        kind: 'compaction',
        content: 'Context compressed · 168k → 42k',
        compaction: { trigger: 'auto', preTokens: 168165, postTokens: 42118, durationMs: 3200 },
        at: 0,
      },
    ]);
    renderChat('c-compact-open');
    fireEvent.click(screen.getByTestId('compaction-summary'));
    const detail = screen.getByTestId('compaction-detail').textContent ?? '';
    expect(detail).toContain('Automatic');
    expect(detail).toContain('168,165');
    expect(detail).toContain('42,118');
    expect(detail).toContain('3.2s');
    expect(screen.getByTestId('compaction').getAttribute('data-open')).toBe('true');
  });

  it('omits the counts the SDK never reported instead of showing zeroes', () => {
    // The shape every real compaction boundary actually has.
    seedChat('c-compact-partial', [
      {
        seq: 1,
        kind: 'compaction',
        content: 'Context compressed · from 168k',
        compaction: { trigger: 'manual', preTokens: 168165 },
        at: 0,
      },
    ]);
    renderChat('c-compact-partial');
    fireEvent.click(screen.getByTestId('compaction-summary'));
    const detail = screen.getByTestId('compaction-detail').textContent ?? '';
    expect(detail).toContain('Manual');
    expect(detail).toContain('168,165');
    expect(detail).not.toContain('After');
    expect(detail).not.toContain('Took');
  });

  // spec/08 § Action, spec/14 § Automations — a job's raw trigger prompt/
  // payload is the first user turn of a job-spawned chat, not something Tom
  // typed. It should read like transcript furniture (same disclosure as a
  // compaction boundary), not a plain user bubble.
  describe('job trigger turn (spec/08 § Action)', () => {
    it('renders the first user turn of a job-spawned chat as a collapsed disclosure, not a message bubble', () => {
      seedChat(
        'c-job-trigger',
        [
          {
            seq: 0,
            kind: 'message',
            role: 'user',
            content: '{"route":"36","etaMinutes":4}',
            at: 0,
          },
          {
            seq: 1,
            kind: 'message',
            role: 'assistant',
            content: 'The 36 is 4 minutes out.',
            at: 1,
          },
        ],
        { jobId: 'job_bus_watch' },
      );
      renderChat('c-job-trigger');
      const row = screen.getByTestId('job-trigger');
      expect(row.getAttribute('data-open')).toBe('false');
      expect(screen.getByTestId('job-trigger-summary').textContent).toContain('Automated trigger');
      // Transcript furniture: no user bubble for the trigger turn.
      expect(document.querySelector('.msg-user')).toBeNull();
      // The assistant reply still renders normally.
      expect(screen.getByText('The 36 is 4 minutes out.')).toBeInTheDocument();
    });

    it('reveals the raw trigger content on expand', () => {
      seedChat(
        'c-job-trigger-open',
        [
          {
            seq: 0,
            kind: 'message',
            role: 'user',
            content: '{"route":"36","etaMinutes":4}',
            at: 0,
          },
        ],
        { jobId: 'job_bus_watch' },
      );
      renderChat('c-job-trigger-open');
      fireEvent.click(screen.getByTestId('job-trigger-summary'));
      expect(screen.getByTestId('job-trigger-detail').textContent).toContain(
        '{"route":"36","etaMinutes":4}',
      );
      expect(screen.getByTestId('job-trigger').getAttribute('data-open')).toBe('true');
    });

    it('does NOT flag a later user turn that is a genuine reply, not a job fire', () => {
      seedChat(
        'c-job-trigger-followup',
        [
          { seq: 0, kind: 'message', role: 'user', content: 'the trigger payload', at: 0 },
          { seq: 1, kind: 'message', role: 'assistant', content: 'ack', at: 1 },
          { seq: 2, kind: 'message', role: 'user', content: 'thanks, keep watching', at: 2 },
        ],
        { jobId: 'job_bus_watch' },
      );
      renderChat('c-job-trigger-followup');
      expect(screen.getAllByTestId('job-trigger')).toHaveLength(1);
      expect(screen.getByText('thanks, keep watching')).toBeInTheDocument();
    });

    // spec/08 § Action, spec/14 § Job trigger turn — a `continue`/`message`
    // action's LATER fire into the chat (a Todoist item re-triggering, say)
    // carries its own `jobTrigger` flag, set by the host from that turn's
    // `chat.input.source.kind === 'job'`, regardless of its position in the
    // chat — unlike the `spawn` case, which only the unambiguous first turn
    // can be inferred for.
    it('DOES flag a later user turn that carries its own jobTrigger flag', () => {
      seedChat(
        'c-job-trigger-later-fire',
        [
          { seq: 0, kind: 'message', role: 'user', content: 'the trigger payload', at: 0 },
          { seq: 1, kind: 'message', role: 'assistant', content: 'ack', at: 1 },
          {
            seq: 2,
            kind: 'message',
            role: 'user',
            content: '{"route":"36","etaMinutes":4}',
            jobTrigger: true,
            at: 2,
          },
        ],
        { jobId: 'job_bus_watch' },
      );
      renderChat('c-job-trigger-later-fire');
      expect(screen.getAllByTestId('job-trigger')).toHaveLength(2);
      expect(document.querySelector('.msg-user')).toBeNull();
    });

    it('flags a jobTrigger turn even in a chat with no jobId — a `message` action can fire into any chat', () => {
      seedChat('c-job-trigger-no-jobid', [
        { seq: 0, kind: 'message', role: 'user', content: 'just a normal chat', at: 0 },
        {
          seq: 1,
          kind: 'message',
          role: 'user',
          content: 'a job message-action fire',
          jobTrigger: true,
          at: 1,
        },
      ]);
      renderChat('c-job-trigger-no-jobid');
      expect(screen.getByText('just a normal chat')).toBeInTheDocument();
      expect(screen.getByTestId('job-trigger')).toBeInTheDocument();
    });

    it('does NOT flag the first user turn of a chat with no jobId', () => {
      seedChat('c-no-job', [
        { seq: 0, kind: 'message', role: 'user', content: 'just a normal chat', at: 0 },
      ]);
      renderChat('c-no-job');
      expect(screen.queryByTestId('job-trigger')).toBeNull();
      expect(screen.getByText('just a normal chat')).toBeInTheDocument();
    });
  });

  // spec/20-hooks.md § On the agent's response, spec/14 § Agent-response
  // hooks — a `block` resubmit the host fired is transcript furniture
  // naming the blocking hook(s), not a message Tom wrote.
  describe('hook trigger turn (spec/20-hooks.md § On the agent’s response)', () => {
    it('renders a block resubmit as a collapsed disclosure naming the hook, not a message bubble', () => {
      seedChat('c-hook-trigger', [
        { seq: 0, kind: 'message', role: 'user', content: 'do the thing', at: 0 },
        {
          seq: 1,
          kind: 'message',
          role: 'assistant',
          content: 'here is a secret: sk-abc123',
          at: 1,
        },
        {
          seq: 2,
          kind: 'message',
          role: 'user',
          content: '[hook: blocked]\n"no secrets": the reply contains a credential',
          hookTrigger: { hooks: [{ hookId: 'h1', hookName: 'no secrets' }] },
          at: 2,
        },
      ]);
      renderChat('c-hook-trigger');
      const row = screen.getByTestId('hook-trigger');
      expect(row.getAttribute('data-open')).toBe('false');
      expect(screen.getByTestId('hook-trigger-summary').textContent).toContain('no secrets');
      // Transcript furniture: the resubmit turn is not a user bubble.
      expect(screen.queryByText(/the reply contains a credential/)).toBeNull();
    });

    it('reveals the hook’s analysis verbatim on expand — the row is what the agent received', () => {
      seedChat('c-hook-trigger-open', [
        {
          seq: 0,
          kind: 'message',
          role: 'user',
          content: '[hook: blocked]\n"no secrets": the reply contains a credential',
          hookTrigger: { hooks: [{ hookId: 'h1', hookName: 'no secrets' }] },
          at: 0,
        },
      ]);
      renderChat('c-hook-trigger-open');
      fireEvent.click(screen.getByTestId('hook-trigger-summary'));
      expect(screen.getByTestId('hook-trigger-detail').textContent).toContain(
        'the reply contains a credential',
      );
      expect(screen.getByTestId('hook-trigger').getAttribute('data-open')).toBe('true');
    });

    it('names more than one blocking hook when several fired together', () => {
      seedChat('c-hook-trigger-multi', [
        {
          seq: 0,
          kind: 'message',
          role: 'user',
          content: 'combined analysis',
          hookTrigger: {
            hooks: [
              { hookId: 'h1', hookName: 'no secrets' },
              { hookId: 'h2', hookName: 'tone check' },
            ],
          },
          at: 0,
        },
      ]);
      renderChat('c-hook-trigger-multi');
      const summary = screen.getByTestId('hook-trigger-summary').textContent ?? '';
      expect(summary).toContain('no secrets');
      expect(summary).toContain('tone check');
    });

    it('does NOT flag an ordinary turn that carries no hookTrigger', () => {
      seedChat('c-no-hook-trigger', [
        { seq: 0, kind: 'message', role: 'user', content: 'just a normal message', at: 0 },
      ]);
      renderChat('c-no-hook-trigger');
      expect(screen.queryByTestId('hook-trigger')).toBeNull();
      expect(screen.getByText('just a normal message')).toBeInTheDocument();
    });
  });

  // spec/04 § Goals — a `not_met` resubmit, the same collapsed-furniture
  // treatment as a hook's `block`; a `met`/`impossible` outcome has no turn to
  // resubmit, so it is a plain system-role row instead.
  describe('goal verdict rows (spec/04 § Goals)', () => {
    it('renders a not_met resubmit as a collapsed disclosure naming the reason, not a message bubble', () => {
      seedChat('c-goal-not-met', [
        {
          seq: 0,
          kind: 'message',
          role: 'user',
          content: '[goal: not met]\nGoal: ship it\n\nTests are still red',
          goalTrigger: { reason: 'Tests are still red' },
          at: 0,
        },
      ]);
      renderChat('c-goal-not-met');
      const row = screen.getByTestId('goal-trigger');
      expect(row.getAttribute('data-open')).toBe('false');
      expect(screen.getByTestId('goal-trigger-summary').textContent).toContain(
        'Tests are still red',
      );
      // Transcript furniture: the resubmit turn is not a user bubble.
      expect(screen.queryByText(/Goal: ship it/)).toBeNull();
    });

    it("reveals the evaluator's reason verbatim on expand", () => {
      seedChat('c-goal-not-met-open', [
        {
          seq: 0,
          kind: 'message',
          role: 'user',
          content: '[goal: not met]\nGoal: ship it\n\nTests are still red',
          goalTrigger: { reason: 'Tests are still red' },
          at: 0,
        },
      ]);
      renderChat('c-goal-not-met-open');
      fireEvent.click(screen.getByTestId('goal-trigger-summary'));
      expect(screen.getByTestId('goal-trigger-detail').textContent).toContain(
        'Tests are still red',
      );
      expect(screen.getByTestId('goal-trigger').getAttribute('data-open')).toBe('true');
    });

    it('renders a met outcome as a quiet system row, labelled, expandable to the full reason', () => {
      seedChat('c-goal-met', [
        {
          seq: 0,
          kind: 'message',
          role: 'system',
          content: '[goal: met]\nAll tests pass and the release is tagged',
          at: 0,
        },
      ]);
      renderChat('c-goal-met');
      expect(screen.getByTestId('goal-outcome-summary').textContent).toContain('Goal met');
      fireEvent.click(screen.getByTestId('goal-outcome-summary'));
      expect(screen.getByTestId('goal-outcome-detail').textContent).toContain(
        'All tests pass and the release is tagged',
      );
    });

    it('renders an impossible outcome labelled distinctly from met', () => {
      seedChat('c-goal-impossible', [
        {
          seq: 0,
          kind: 'message',
          role: 'system',
          content: '[goal: impossible]\nThe target repo no longer exists',
          at: 0,
        },
      ]);
      renderChat('c-goal-impossible');
      expect(screen.getByTestId('goal-outcome-summary').textContent).toContain('Goal impossible');
    });

    it('does NOT flag an ordinary turn that carries no goalTrigger', () => {
      seedChat('c-no-goal-trigger', [
        { seq: 0, kind: 'message', role: 'user', content: 'just a normal message', at: 0 },
      ]);
      renderChat('c-no-goal-trigger');
      expect(screen.queryByTestId('goal-trigger')).toBeNull();
      expect(screen.getByText('just a normal message')).toBeInTheDocument();
    });
  });

  describe('Claude Code synthetic replies (spec/02 § Per-turn process)', () => {
    it('names the resume placeholder as an interrupted turn, quoting what Claude Code inserted', () => {
      seedChat('c-synthetic', [
        {
          seq: 0,
          kind: 'message',
          role: 'system',
          content: 'No response requested.',
          synthetic: true,
          at: 0,
        },
      ]);
      renderChat('c-synthetic');
      const line = screen.getByTestId('synthetic-notice');
      expect(line.textContent).toBe(
        '› Turn interruptedClaude Code inserted “No response requested.”',
      );
    });

    it('shows any other synthetic reply as itself, attributed to Claude Code', () => {
      seedChat('c-synthetic-other', [
        {
          seq: 0,
          kind: 'message',
          role: 'system',
          content: 'Something else.',
          synthetic: true,
          at: 0,
        },
      ]);
      renderChat('c-synthetic-other');
      const line = screen.getByTestId('synthetic-notice');
      expect(line.textContent).toBe('› Claude Code inserted “Something else.”');
    });

    it('does NOT treat an unflagged message with the same words as synthetic', () => {
      seedChat('c-synthetic-quoted', [
        { seq: 0, kind: 'message', role: 'assistant', content: 'No response requested.', at: 0 },
      ]);
      renderChat('c-synthetic-quoted');
      expect(screen.queryByTestId('synthetic-notice')).toBeNull();
      expect(screen.getByText('No response requested.')).toBeInTheDocument();
    });
  });

  it('renders an unknown/system entry kind as a plain .system line', () => {
    seedChat('c-system', [{ seq: 1, kind: 'system', content: 'connection restored', at: 0 }]);
    renderChat('c-system');
    expect(document.querySelector('.system')?.textContent).toBe('connection restored');
  });

  // spec/14 § Background task completions — a completion notice from the
  // Claude Code layer underneath is its own transcript entry, badged as coming
  // from that layer, NOT a bare system message the user has to decode.
  it('renders a background command completion as a badged card with its exit code', () => {
    seedChat('c-bg-cmd', [
      {
        seq: 1,
        kind: 'message',
        role: 'system',
        content: 'Background command "Build web package to compile CSS" completed (exit code 0)',
        at: 0,
      },
    ]);
    renderChat('c-bg-cmd');
    const card = screen.getByTestId('bg-task');
    expect(screen.getByTestId('bg-task-badge')).toBeInTheDocument();
    expect(screen.getByTestId('bg-task-title').textContent).toBe(
      'Build web package to compile CSS',
    );
    expect(card.textContent).toContain('exit 0');
    // It must NOT also render as an ordinary message bubble.
    expect(screen.queryByTestId('msg-content')).not.toBeInTheDocument();
  });

  it('renders a background agent completion as an agent, with no exit code', () => {
    seedChat('c-bg-agent', [
      {
        seq: 1,
        kind: 'message',
        role: 'system',
        content: 'Agent "Diagnose 25045 test failures" completed',
        at: 0,
      },
    ]);
    renderChat('c-bg-agent');
    const card = screen.getByTestId('bg-task');
    expect(screen.getByTestId('bg-task-title').textContent).toBe('Diagnose 25045 test failures');
    expect(card.textContent).toContain('agent');
    expect(card.textContent).not.toContain('exit');
  });

  // spec/14 § Background task completions — replay (and any host on a host
  // predating the host-side lifting) hands the surface the WHOLE raw
  // `<task-notification>` block as a user turn. It is not something Tom typed
  // and he does not need to read it, so it renders as one quiet line with the
  // block a chevron away — never a user bubble.
  describe('raw task-notification user turn (spec/14 § Background task completions)', () => {
    const RAW_COMMAND_NOTIFICATION = [
      '<task-notification>',
      '<task-id>baiw888mq</task-id>',
      '<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>',
      '<output-file>/tmp/claude-1000/9a1710c0/tasks/baiw888mq.output</output-file>',
      '<status>completed</status>',
      '<summary>Background command "Build web package to compile CSS" completed (exit code 0)</summary>',
      '</task-notification>',
    ].join('\n');

    it('renders a raw notification as a collapsed badged line, not a user bubble', () => {
      seedChat('c-raw-notif', [
        { seq: 1, kind: 'message', role: 'user', content: RAW_COMMAND_NOTIFICATION, at: 0 },
        { seq: 2, kind: 'message', role: 'assistant', content: 'The build is done.', at: 1 },
      ]);
      renderChat('c-raw-notif');
      const row = screen.getByTestId('bg-task-notice');
      expect(row.getAttribute('data-open')).toBe('false');
      expect(screen.getByTestId('bg-task-notice-summary').textContent).toContain(
        'Background command "Build web package to compile CSS" completed (exit code 0)',
      );
      // Badged as coming from the layer underneath, same as a lifted completion.
      expect(screen.getByTestId('bg-task-notice-badge')).toBeInTheDocument();
      // Transcript furniture: no user bubble, and none of the block's plumbing
      // (task ids, output paths) on screen while collapsed.
      expect(document.querySelector('.msg-user')).toBeNull();
      expect(row.textContent).not.toContain('tool-use-id');
      expect(row.textContent).not.toContain('baiw888mq');
      // The assistant reply reacting to it still renders normally.
      expect(screen.getByText('The build is done.')).toBeInTheDocument();
    });

    it('reveals the whole raw block on expand', () => {
      seedChat('c-raw-notif-open', [
        { seq: 1, kind: 'message', role: 'user', content: RAW_COMMAND_NOTIFICATION, at: 0 },
      ]);
      renderChat('c-raw-notif-open');
      fireEvent.click(screen.getByTestId('bg-task-notice-summary'));
      const detail = screen.getByTestId('bg-task-notice-detail').textContent ?? '';
      expect(detail).toContain('<task-notification>');
      expect(detail).toContain('toolu_019qoZTEw4vif4xvr1padB3a');
      expect(screen.getByTestId('bg-task-notice').getAttribute('data-open')).toBe('true');
    });

    it('reads as a plain "Background task" when the block carries no summary', () => {
      // No sentence is invented for it — the raw block is still one click away.
      seedChat('c-raw-notif-bare', [
        {
          seq: 1,
          kind: 'message',
          role: 'user',
          content: '<task-notification>\n<status>killed</status>\n</task-notification>',
          at: 0,
        },
      ]);
      renderChat('c-raw-notif-bare');
      expect(screen.getByTestId('bg-task-notice-summary').textContent).toContain('Background task');
      expect(document.querySelector('.msg-user')).toBeNull();
    });

    it('takes precedence over the job-trigger treatment when it is the first user turn', () => {
      // A job-spawned chat whose first user turn happens to be a notification
      // must not read as the job's own trigger payload.
      seedChat(
        'c-raw-notif-first',
        [{ seq: 0, kind: 'message', role: 'user', content: RAW_COMMAND_NOTIFICATION, at: 0 }],
        { jobId: 'job_bus_watch' },
      );
      renderChat('c-raw-notif-first');
      expect(screen.getByTestId('bg-task-notice')).toBeInTheDocument();
      expect(screen.queryByTestId('job-trigger')).not.toBeInTheDocument();
    });

    it('leaves a user message that merely mentions the tag as an ordinary bubble', () => {
      seedChat('c-raw-notif-mention', [
        {
          seq: 1,
          kind: 'message',
          role: 'user',
          content: 'what does <task-notification> actually mean?',
          at: 0,
        },
      ]);
      renderChat('c-raw-notif-mention');
      expect(screen.queryByTestId('bg-task-notice')).not.toBeInTheDocument();
      expect(screen.getByTestId('msg-content').textContent).toContain('what does');
    });
  });

  it('leaves an ordinary system message rendering as it did', () => {
    seedChat('c-plain-system', [
      { seq: 1, kind: 'message', role: 'system', content: 'Session resumed', at: 0 },
    ]);
    renderChat('c-plain-system');
    expect(screen.queryByTestId('bg-task')).not.toBeInTheDocument();
    expect(screen.getByTestId('msg-content').textContent).toContain('Session resumed');
  });

  it('renders the empty-state graphic when a known chat has no timeline entries', () => {
    seedChat('c-truly-empty', []);
    renderChat('c-truly-empty');
    expect(screen.getByTestId('empty-chat')).toBeInTheDocument();
  });

  it('shows the "thinking…" indicator whenever running, hiding it only while a message actively streams', async () => {
    seedChat('c-thinking', [{ seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    useChatStore.setState((s) => ({
      chats: { ...s.chats, ['c-thinking']: { ...s.chats['c-thinking']!, activity: 'running' } },
    }));
    renderChat('c-thinking');
    // Waiting for the first token → shows.
    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();

    // A message is actively STREAMING → the caret shows progress, so hide the dots.
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-thinking']: [
          s.timelines['c-thinking']![0]!,
          { seq: 2, kind: 'message', role: 'assistant', content: 'let me', streaming: true, at: 0 },
        ],
      },
    }));
    await waitFor(() => {
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    // The message SETTLES but the chat is still running (agent now thinking / doing
    // tool calls before the next message) → the indicator must come BACK, so the
    // mid-turn gap never looks stuck. (This is the bug being fixed.)
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-thinking']: [
          s.timelines['c-thinking']![0]!,
          { seq: 2, kind: 'message', role: 'assistant', content: 'let me research this', at: 0 },
        ],
      },
    }));
    await waitFor(() => {
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    // Turn ends → idle → indicator gone.
    useChatStore.setState((s) => ({
      chats: { ...s.chats, ['c-thinking']: { ...s.chats['c-thinking']!, activity: 'idle' } },
    }));
    await waitFor(() => {
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
  });

  // spec/04 ## Message queueing — the queued block is the LAST thing in the
  // stream: below every message and below the thinking indicator, so its
  // position on screen reads as "not yet sent".
  it('renders the queued block below the thinking indicator, not above it', () => {
    seedChat('c-queued-order', [
      { seq: 1, kind: 'message', role: 'user', content: 'the running turn', at: 0 },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: 'first queued turn',
        queued: true,
        localId: 'QO1',
        at: 1,
      },
      {
        seq: 3,
        kind: 'message',
        role: 'user',
        content: 'second queued turn',
        queued: true,
        localId: 'QO2',
        at: 2,
      },
    ]);
    useChatStore.setState((s) => ({
      chats: {
        ...s.chats,
        ['c-queued-order']: { ...s.chats['c-queued-order']!, activity: 'running' },
      },
    }));
    renderChat('c-queued-order');

    const stream = screen.getByTestId('chat-stream');
    const order = Array.from(
      stream.querySelectorAll('[data-testid="msg"], [data-testid="thinking-indicator"]'),
    ).map((el) => {
      if (el.getAttribute('data-testid') === 'thinking-indicator') return 'thinking';
      // Read the body only — drop the queued chip row, whose wording is the
      // queue-position chip's business (spec/04 ## Message queueing), not this
      // test's. Matching on its text would re-break this on every reword.
      const body = el.cloneNode(true) as HTMLElement;
      body.querySelector('[data-testid="queued-tools"]')?.remove();
      return (body.textContent ?? '').trim();
    });
    expect(order).toEqual([
      'the running turn',
      'thinking',
      'first queued turn',
      'second queued turn',
    ]);
    // And the queue's own order is preserved across the split.
    const queued = stream.querySelectorAll('[data-queued="true"]');
    expect(queued[0]).toHaveTextContent('first queued turn');
    expect(queued[1]).toHaveTextContent('second queued turn');
  });

  // The indicator belongs to the LIVE transcript, so "is the last message
  // streaming?" must ignore the queued tail — otherwise type-ahead makes the
  // dots reappear underneath an actively streaming reply.
  it('hides the indicator while the last LIVE message streams, even with a queued turn below it', () => {
    seedChat('c-queued-streaming', [
      { seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 },
      { seq: 2, kind: 'message', role: 'assistant', content: 'let me', streaming: true, at: 1 },
      {
        seq: 3,
        kind: 'message',
        role: 'user',
        content: 'and also this',
        queued: true,
        localId: 'QS1',
        at: 2,
      },
    ]);
    useChatStore.setState((s) => ({
      chats: {
        ...s.chats,
        ['c-queued-streaming']: { ...s.chats['c-queued-streaming']!, activity: 'running' },
      },
    }));
    renderChat('c-queued-streaming');
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('queued-badge')).toBeInTheDocument();
  });

  // spec/12 — `deliveryPending` is NOT `queued`: a message being sent has left
  // the queue, so it sits in the live transcript ABOVE the indicator.
  it('keeps a delivery-pending (sending) message above the thinking indicator', () => {
    usePresenceStore.getState().setHostOnline('d1', true);
    seedChat('c-pending-order', [
      { seq: 1, kind: 'message', role: 'user', content: 'earlier turn', at: 0 },
      {
        seq: 2,
        kind: 'message',
        role: 'user',
        content: 'sending this one',
        deliveryPending: true,
        localId: 'DP1',
        at: 1,
      },
    ]);
    useChatStore.setState((s) => ({
      chats: {
        ...s.chats,
        ['c-pending-order']: { ...s.chats['c-pending-order']!, activity: 'running' },
      },
    }));
    renderChat('c-pending-order');

    const sending = screen.getByText('sending this one').closest('[data-testid="msg"]')!;
    const indicator = screen.getByTestId('thinking-indicator');
    expect(sending.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('a tool_call with toolArgs entirely omitted does not crash (falls back to an empty args object)', () => {
    seedChat('c-tool-noargs', [{ seq: 1, kind: 'tool_call', tool: 'Bash', at: 0 }]);
    renderChat('c-tool-noargs');
    const tc = screen.getByTestId('tool-call');
    expect(tc.getAttribute('data-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    expect(screen.getByTestId('tool-call-detail').textContent).toBe('');
  });

  it('a tool-call whose name matches /edit|write/ but lacks file_path/old_string/new_string falls back to the generic disclosure', () => {
    seedChat('c-tool-notedit', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'EditSomething',
        toolArgs: { note: 'no file path here' },
        at: 0,
      },
    ]);
    renderChat('c-tool-notedit');
    const tc = screen.getByTestId('tool-call');
    expect(tc.getAttribute('data-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('tool-call-summary'));
    expect(screen.getByTestId('tool-call-detail').textContent).toContain('no file path here');
  });

  it('an edit tool-call with only new_string (no old_string) is still treated as an edit, with an empty old side', () => {
    seedChat('c-tool-newonly', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Write',
        toolArgs: { file_path: 'fresh.txt', new_string: 'brand new content\n' },
        at: 0,
      },
    ]);
    renderChat('c-tool-newonly');
    expect(screen.getByTestId('tool-call').getAttribute('data-edit')).toBe('true');
    fireEvent.click(screen.getByTestId('tool-call-diff-toggle'));
    expect(screen.queryAllByTestId('diff-del-line')).toHaveLength(0);
    expect(screen.getAllByTestId('diff-add-line')).toHaveLength(1);
  });

  it('an edit tool-call with only old_string (no new_string) renders only removed lines', () => {
    seedChat('c-tool-oldonly', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: 'gone.txt', old_string: 'deleted content\n' },
        at: 0,
      },
    ]);
    renderChat('c-tool-oldonly');
    expect(screen.getByTestId('tool-call').getAttribute('data-edit')).toBe('true');
    fireEvent.click(screen.getByTestId('tool-call-diff-toggle'));
    expect(screen.getAllByTestId('diff-del-line')).toHaveLength(1);
    expect(screen.queryAllByTestId('diff-add-line')).toHaveLength(0);
  });

  // ---- Tool-run grouping (spec/14 § Main chat panel — "Tool runs collapse to
  // one row") ----

  it('collapses a consecutive run of tool calls into one narrated row', () => {
    seedChat('c-tool-run', [
      { seq: 1, kind: 'message', role: 'user', content: 'go', at: 0 },
      { seq: 2, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'a.ts' }, at: 0 },
      { seq: 3, kind: 'tool_result', tool: 'Read', toolResult: { ok: true }, at: 0 },
      { seq: 4, kind: 'tool_call', tool: 'Grep', toolArgs: { pattern: 'foo' }, at: 0 },
      { seq: 5, kind: 'tool_result', tool: 'Grep', toolResult: { hits: 2 }, at: 0 },
      { seq: 6, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'b.ts' }, at: 0 },
      { seq: 7, kind: 'tool_result', tool: 'Read', toolResult: { ok: true }, at: 0 },
    ]);
    renderChat('c-tool-run');
    const group = screen.getByTestId('tool-group');
    expect(group.getAttribute('data-open')).toBe('false');
    // What the batch did, not what it did it to — no filenames or search terms
    // leak into the collapsed row; that's what expanding is for.
    const summaryText = screen.getByTestId('tool-group-summary').textContent ?? '';
    expect(summaryText).toContain('Read 2 files, searched for 1 pattern');
    expect(summaryText).not.toMatch(/a\.ts|b\.ts|foo/);
    // Collapsed: the six individual rows are not in the transcript.
    expect(screen.queryAllByTestId('tool-call')).toHaveLength(0);
    expect(screen.queryAllByTestId('tool-result')).toHaveLength(0);
    // The message either side of the run is untouched.
    expect(screen.getByText('go')).toBeInTheDocument();
  });

  it('expands a tool-run group into the individual call and result rows', () => {
    seedChat('c-tool-run-open', [
      { seq: 1, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'a.ts' }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Read', toolResult: { stdout: 'contents' }, at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'ls' }, at: 0 },
      { seq: 4, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, at: 0 },
    ]);
    renderChat('c-tool-run-open');
    fireEvent.click(screen.getByTestId('tool-group-summary'));
    expect(screen.getByTestId('tool-group').getAttribute('data-open')).toBe('true');
    expect(screen.getAllByTestId('tool-call')).toHaveLength(2);
    expect(screen.getAllByTestId('tool-result')).toHaveLength(2);
    // The rows still work as they do ungrouped: expand one to its JSON detail.
    fireEvent.click(screen.getAllByTestId('tool-result-summary')[0] as HTMLElement);
    expect(screen.getByTestId('tool-result-detail').textContent).toContain('contents');
  });

  it('leaves a run of a single tool call unwrapped — grouping it would save no rows', () => {
    seedChat('c-tool-single', [
      { seq: 1, kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'ls' }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, at: 0 },
    ]);
    renderChat('c-tool-single');
    expect(screen.queryByTestId('tool-group')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-call')).toBeInTheDocument();
    expect(screen.getByTestId('tool-result')).toBeInTheDocument();
  });

  it('splits a run around a file-edit call, which stays directly in the transcript with its diff', () => {
    seedChat('c-tool-run-edit', [
      { seq: 1, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'a.ts' }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Read', toolResult: { ok: true }, at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'Grep', toolArgs: { pattern: 'foo' }, at: 0 },
      { seq: 4, kind: 'tool_result', tool: 'Grep', toolResult: { hits: 1 }, at: 0 },
      {
        seq: 5,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: 'a.ts', old_string: 'const a = 1;\n', new_string: 'const a = 2;\n' },
        at: 0,
      },
      { seq: 6, kind: 'tool_result', tool: 'Edit', toolResult: { ok: true }, at: 0 },
      { seq: 7, kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'pnpm test' }, at: 0 },
      { seq: 8, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, at: 0 },
      { seq: 9, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'b.ts' }, at: 0 },
      { seq: 10, kind: 'tool_result', tool: 'Read', toolResult: { ok: true }, at: 0 },
    ]);
    renderChat('c-tool-run-edit');
    // Two groups: the Read/Grep run before the edit, the Bash/Read run after it.
    expect(screen.getAllByTestId('tool-group')).toHaveLength(2);
    // The edit row is NOT swallowed — it renders its own row, diff collapsed
    // until the chevron is clicked (spec/14 § Diffs).
    const edits = screen.getAllByTestId('tool-call');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.getAttribute('data-edit')).toBe('true');
    fireEvent.click(screen.getByTestId('tool-call-diff-toggle'));
    expect(screen.getAllByTestId('diff-add-line')).toHaveLength(1);
  });

  it('splits a run around a Monitor call, which stays directly in the transcript', () => {
    seedChat('c-tool-run-monitor', [
      { seq: 1, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'a.ts' }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Read', toolResult: { ok: true }, at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'Grep', toolArgs: { pattern: 'foo' }, at: 0 },
      {
        seq: 4,
        kind: 'tool_call',
        tool: 'Monitor',
        toolArgs: { description: 'errors in deploy.log', command: 'tail -f deploy.log' },
        at: 0,
      },
    ]);
    renderChat('c-tool-run-monitor');
    expect(screen.getAllByTestId('tool-group')).toHaveLength(1);
    const monitor = screen.getByTestId('tool-call');
    expect(monitor.getAttribute('data-monitor')).toBe('true');
    expect(monitor.textContent).toContain('Monitor ·');
  });

  // spec/14 § Tool runs — once the host has labelled a closed run, the row
  // reads the label; the count is only what it says before that, or instead of
  // a label that failed (and then it says it failed).
  describe('AI tool-run summaries', () => {
    const run: ChatEventEntry[] = [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: { command: 'pnpm i' },
        callId: 'k1',
        at: 0,
      },
      { seq: 2, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, callId: 'k1', at: 0 },
      {
        seq: 3,
        kind: 'tool_call',
        tool: 'Bash',
        toolArgs: { command: 'pnpm dev' },
        callId: 'k2',
        at: 0,
      },
      { seq: 4, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, callId: 'k2', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'Running.', at: 0 },
    ];
    const summarise = (chatId: string, callIds: string[], extra: object) =>
      act(() => {
        useChatStore.getState().applyEvent({
          type: 'chat.tool_run_summary',
          chatId,
          callIds,
          seq: 6,
          ...extra,
        } as never);
      });

    it('reads the run as its AI summary once one arrives', () => {
      seedChat('c-ai-sum', run);
      renderChat('c-ai-sum');
      const group = screen.getByTestId('tool-group');
      expect(group.getAttribute('data-summary')).toBe('count');
      expect(screen.getByTestId('tool-group-summary').textContent).toContain('Ran 2 commands');
      summarise('c-ai-sum', ['k1', 'k2'], { summary: 'Set up the project locally' });
      expect(screen.getByTestId('tool-group-summary').textContent).toContain(
        'Set up the project locally',
      );
      expect(screen.getByTestId('tool-group').getAttribute('data-summary')).toBe('ai');
      expect(screen.getByTestId('tool-group').getAttribute('data-open')).toBe('false');
    });

    it('marks a run whose summary failed, with the reason, and keeps the count', () => {
      seedChat('c-ai-fail', run);
      renderChat('c-ai-fail');
      summarise('c-ai-fail', ['k1', 'k2'], { summary: null, error: 'no credit' });
      expect(screen.getByTestId('tool-group').getAttribute('data-summary')).toBe('failed');
      expect(screen.getByTestId('tool-group-summary').textContent).toContain('Ran 2 commands');
      expect(screen.getByTestId('tool-group-summary-failed').getAttribute('title')).toBe(
        'Summary failed: no credit',
      );
    });

    it('marks a failed summary with a neutral glyph, not a warning triangle', () => {
      seedChat('c-ai-neutral', run);
      renderChat('c-ai-neutral');
      summarise('c-ai-neutral', ['k1', 'k2'], { summary: null, error: 'no credit' });
      const marker = screen.getByTestId('tool-group-summary-failed');
      expect(marker.innerHTML).not.toContain('triangle-alert');
      expect(marker.querySelector('svg')).not.toBeNull();
    });

    it('does not put a label written for other calls on a run', () => {
      seedChat('c-ai-other', run);
      renderChat('c-ai-other');
      summarise('c-ai-other', ['k1', 'k2', 'k3'], { summary: 'Something else' });
      expect(screen.getByTestId('tool-group-summary').textContent).not.toContain('Something else');
    });
  });

  it("shows the agent's own sentence before a run as its status while no label has arrived", () => {
    seedChat('c-narration', [
      {
        seq: 1,
        kind: 'message',
        role: 'assistant',
        content: 'Researching how to set up shaver…\nThen I will check the manual.',
        at: 0,
      },
      { seq: 2, kind: 'tool_call', tool: 'WebSearch', toolArgs: { query: 'shaver' }, at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'WebFetch', toolArgs: { url: 'https://x' }, at: 0 },
    ]);
    renderChat('c-narration');
    expect(screen.getByTestId('tool-group-summary').textContent).toContain(
      'Researching how to set up shaver…',
    );
    expect(screen.getByTestId('tool-group-summary').textContent).not.toContain('manual');
    expect(screen.getByTestId('tool-group').getAttribute('data-summary')).toBe('narration');
  });

  it('narrates the batch by kind of work, in the order each kind first happened', () => {
    seedChat('c-tool-run-many', [
      { seq: 1, kind: 'tool_call', tool: 'Read', at: 0 },
      { seq: 2, kind: 'tool_call', tool: 'Grep', at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'Bash', at: 0 },
      { seq: 4, kind: 'tool_call', tool: 'Glob', at: 0 },
      { seq: 5, kind: 'tool_call', tool: 'WebFetch', at: 0 },
    ]);
    renderChat('c-tool-run-many');
    const text = screen.getByTestId('tool-group-summary').textContent ?? '';
    expect(text).toContain('Read 1 file, searched for 2 patterns, ran 1 command, fetched 1 page');
  });

  it("keeps a grouped call's target out of the collapsed row, visible only once expanded", () => {
    seedChat('c-tool-run-targets', [
      { seq: 1, kind: 'tool_call', tool: 'Grep', toolArgs: { pattern: 'timeout' }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Grep', toolResult: { files: ['src/poll.ts'] }, at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'pnpm test' }, at: 0 },
      { seq: 4, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, at: 0 },
    ]);
    renderChat('c-tool-run-targets');
    const collapsedText = screen.getByTestId('tool-group-summary').textContent ?? '';
    expect(collapsedText).toContain('Searched for 1 pattern, ran 1 command');
    expect(collapsedText).not.toMatch(/timeout|pnpm test/);
    fireEvent.click(screen.getByTestId('tool-group-summary'));
    const expanded = screen.getByTestId('tool-group-detail').textContent ?? '';
    expect(expanded).toContain('timeout');
    expect(expanded).toContain('pnpm test');
  });

  it('keeps a long Bash command out of the collapsed row entirely, not merely truncated', () => {
    const longCommand = `echo ${'x'.repeat(80)}`;
    seedChat('c-tool-run-long-cmd', [
      { seq: 1, kind: 'tool_call', tool: 'Bash', toolArgs: { command: longCommand }, at: 0 },
      { seq: 2, kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 }, at: 0 },
      { seq: 3, kind: 'tool_call', tool: 'Read', toolArgs: { file_path: 'a.ts' }, at: 0 },
      { seq: 4, kind: 'tool_result', tool: 'Read', toolResult: { ok: true }, at: 0 },
    ]);
    renderChat('c-tool-run-long-cmd');
    const text = screen.getByTestId('tool-group-summary').textContent ?? '';
    expect(text).toContain('Ran 1 command, read 1 file');
    expect(text).not.toContain(longCommand);
    fireEvent.click(screen.getByTestId('tool-group-summary'));
    fireEvent.click(screen.getAllByTestId('tool-call-summary')[0] as HTMLElement);
    expect(screen.getAllByTestId('tool-call-detail')[0]?.textContent).toContain(longCommand);
  });

  // ---- Scroll-position memory across a close/reopen ----

  it('restores a remembered (non-bottom) scroll offset when a chat is reopened', async () => {
    const timeline: ChatEventEntry[] = Array.from({ length: 30 }, (_v, i) => ({
      seq: i,
      kind: 'message' as const,
      role: 'user' as const,
      content: `m${i}`,
      at: 0,
    }));
    seedChat('c-remember', timeline);

    const { unmount } = render(
      <MemoryRouter initialEntries={['/chats/c-remember']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>,
    );
    let stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    // Let the mount-time pin (and the follow-effect's staggered rAF, and its
    // own self-scroll-guard rAF) fully settle before scrolling manually.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // User scrolls up and away — remembered as non-bottom.
    stream.scrollTop = 3000;
    stream.dispatchEvent(new Event('scroll'));
    unmount();

    // Reopen the SAME chat — the remembered non-bottom offset is restored
    // (not re-pinned to the bottom).
    render(
      <MemoryRouter initialEntries={['/chats/c-remember']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>,
    );
    stream = screen.getByTestId('chat-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 12000 });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 780 });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(stream.scrollTop).toBe(3000);
  });

  // Todoist: "patch sometimes switching chat puts you in a different position
  // when you come back". A raw pixel offset is only right if the content
  // above it laid out identically both times — restoring by ANCHOR (which
  // message sat at the top edge) survives the transcript laying out
  // differently between the close and the reopen. jsdom has no layout engine
  // (real geometry stays e2e's, as elsewhere in this file), so `getBoundingClientRect`
  // is stubbed at the prototype level — a per-instance spy would be too late
  // for the reopen's mount-time restore, which runs inside `render()` itself,
  // before a test can reach the freshly mounted message elements.
  it('restores by anchoring to the message that was at the top edge, not the raw offset, when the layout above it has changed', async () => {
    const timeline: ChatEventEntry[] = Array.from({ length: 30 }, (_v, i) => ({
      seq: i,
      kind: 'message' as const,
      role: 'user' as const,
      content: `m${i}`,
      at: 0,
    }));
    seedChat('c-anchor', timeline);

    const originalRect = Element.prototype.getBoundingClientRect;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight',
    )!;
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'clientHeight',
    )!;
    let phase: 'default' | 'save' | 'reopen' = 'default';
    // Stubbed at the prototype level, not per-instance: the reopen's
    // mount-time restore runs INSIDE `render()`, before a test can reach the
    // freshly mounted stream/message elements to spy on them individually.
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (phase === 'default') return originalRect.call(this);
      if (this.getAttribute('data-testid') === 'chat-stream') {
        return { top: 100, bottom: 880 } as DOMRect;
      }
      if (this.getAttribute('data-testid') === 'msg') {
        const seq = Number(this.getAttribute('data-seq'));
        // Save-time layout: messages 0-9 sit above the top edge (bottom <=
        // 100); message 10 straddles it exactly (top 100, delta 0) — the
        // anchor a scroll-away should capture.
        // Reopen-time layout: the same messages, but shifted far down —
        // standing in for markdown/image measurement having grown the
        // content above them while the chat was closed.
        const top =
          phase === 'save'
            ? seq < 10
              ? 100 - (10 - seq) * 20
              : 100 + (seq - 10) * 80
            : seq < 10
              ? -5000 + seq * 20
              : 5000 + (seq - 10) * 80;
        // Messages above the top edge are short (height 20, so 0-9 all fit
        // fully above it); the anchor candidate and everything below it are
        // taller (height 80), matching realistic message bubbles.
        return { top, bottom: top + (seq < 10 ? 20 : 80) } as DOMRect;
      }
      return originalRect.call(this);
    };
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element) {
        if (this.getAttribute('data-testid') === 'chat-stream') {
          return phase === 'reopen' ? 20000 : 12000;
        }
        return originalScrollHeight.get!.call(this);
      },
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        if (this.getAttribute('data-testid') === 'chat-stream') return 780;
        return originalClientHeight.get!.call(this);
      },
    });

    try {
      const { unmount } = render(
        <MemoryRouter initialEntries={['/chats/c-anchor']}>
          <Routes>
            <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>,
      );
      let stream = screen.getByTestId('chat-stream');
      // Let the mount-time pin fully settle before scrolling manually, then
      // switch on the save-time geometry for the scroll-away that follows.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      phase = 'save';
      stream.scrollTop = 3000;
      stream.dispatchEvent(new Event('scroll'));
      unmount();

      // Reopen the same chat with the shifted (reopen-time) geometry already
      // active, so the mount-time restore-or-pin sees it.
      phase = 'reopen';
      render(
        <MemoryRouter initialEntries={['/chats/c-anchor']}>
          <Routes>
            <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>,
      );
      stream = screen.getByTestId('chat-stream');
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      // Anchor restore: scrollTop + (target.top - box.top) + delta, with
      // scrollTop starting at 0, target.top 5000, box.top 100, delta 0.
      expect(stream.scrollTop).toBe(4900);
      // NOT the stale raw offset (3000), which would land on the wrong
      // message now that the layout above it has changed.
      expect(stream.scrollTop).not.toBe(3000);
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
      Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight);
      Object.defineProperty(Element.prototype, 'clientHeight', originalClientHeight);
    }
  });

  // spec/14 § Messages — Long user messages collapse (accordion): a settled
  // user turn over 8 lines / 600 chars renders clamped with a chevron toggle,
  // collapsed by default.
  describe('long user message accordion (spec/14 § Messages)', () => {
    const LONG_TEXT = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const SHORT_TEXT = 'a short message';

    it('renders a long user message collapsed by default, with a toggle', () => {
      seedChat('c-long-user', [
        { seq: 0, kind: 'message', role: 'user', content: LONG_TEXT, at: 0 },
      ]);
      renderChat('c-long-user');
      const msg = screen.getByTestId('msg');
      expect(msg.classList.contains('collapsible')).toBe(true);
      expect(msg.classList.contains('collapsed')).toBe(true);
      const content = screen.getByTestId('msg-content');
      expect(content.classList.contains('clamped')).toBe(true);
      expect(screen.getByTestId('msg-collapse-toggle')).toBeTruthy();
    });

    it('expands on toggle click and collapses again on a second click', () => {
      seedChat('c-long-user-2', [
        { seq: 0, kind: 'message', role: 'user', content: LONG_TEXT, at: 0 },
      ]);
      renderChat('c-long-user-2');
      const toggle = screen.getByTestId('msg-collapse-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(toggle);
      expect(screen.getByTestId('msg-content').classList.contains('clamped')).toBe(false);
      expect(screen.getByTestId('msg').classList.contains('collapsed')).toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(toggle);
      expect(screen.getByTestId('msg-content').classList.contains('clamped')).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('does not collapse a short user message — no toggle rendered', () => {
      seedChat('c-short-user', [
        { seq: 0, kind: 'message', role: 'user', content: SHORT_TEXT, at: 0 },
      ]);
      renderChat('c-short-user');
      expect(screen.getByTestId('msg').classList.contains('collapsible')).toBe(false);
      expect(screen.queryByTestId('msg-collapse-toggle')).toBeNull();
      expect(screen.getByTestId('msg-content').classList.contains('clamped')).toBe(false);
    });

    it('does not collapse a long ASSISTANT message — assistant prose is never clamped', () => {
      seedChat('c-long-assistant', [
        { seq: 0, kind: 'message', role: 'assistant', content: LONG_TEXT, at: 0 },
      ]);
      renderChat('c-long-assistant');
      expect(screen.getByTestId('msg').classList.contains('collapsible')).toBe(false);
      expect(screen.queryByTestId('msg-collapse-toggle')).toBeNull();
    });

    it('does not collapse a long user message that is still streaming', () => {
      seedChat('c-long-streaming', [
        { seq: 0, kind: 'message', role: 'user', content: LONG_TEXT, streaming: true, at: 0 },
      ]);
      renderChat('c-long-streaming');
      expect(screen.getByTestId('msg').classList.contains('collapsible')).toBe(false);
      expect(screen.queryByTestId('msg-collapse-toggle')).toBeNull();
    });
  });

  // spec/14 § Main chat panel — Unknown chat. The route names a chat this
  // surface holds no row for. Two situations share that shape and must not
  // look the same: the roster hasn't landed (transient, no actions), and the
  // roster HAS landed without it (a real answer, with a way out).
  describe('unknown chat', () => {
    const getChat = vi.mocked(api.getChat);

    function summaryRow(chatId: string): ChatSummaryRow {
      return {
        chatId,
        name: 'archived one',
        preview: null,
        goal: null,
        reminder: null,
        pendingWake: null,
        todos: [],
        daemonId: 'd1',
        folder: '/home/tom/projects/old',
        activity: 'idle',
        status: 'archived',
        permissionMode: 'bypassPermissions',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 0,
        jobId: null,
      };
    }

    beforeEach(() => {
      getChat.mockReset();
    });

    it('shows the loading state and looks nothing up while the roster is still in flight', () => {
      // `_reset()` in the outer beforeEach leaves `hydrated: false`.
      renderChat('c-unknown');
      expect(screen.getByTestId('chat-main-loading')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-main-empty')).toBeNull();
      expect(screen.queryByTestId('chat-missing-retry')).toBeNull();
      expect(getChat).not.toHaveBeenCalled();
    });

    it('looks the chat up by id once the roster has landed without it', async () => {
      getChat.mockRejectedValue(new ApiError(404, 'chat not found: c-unknown', null));
      useChatStore.getState().hydrate([]);
      renderChat('c-unknown');
      await waitFor(() => expect(getChat).toHaveBeenCalledWith('c-unknown'));
    });

    it('renders the dead end with a Manager link and a Retry when the chat really is gone', async () => {
      getChat.mockRejectedValue(new ApiError(404, 'chat not found: c-unknown', null));
      useChatStore.getState().hydrate([]);
      renderChat('c-unknown');
      await waitFor(() => expect(screen.getByTestId('chat-main-empty')).toBeInTheDocument());
      expect(screen.getByText('Chat not found')).toBeInTheDocument();
      expect(screen.getByTestId('chat-missing-detail').textContent).toBe('c-unknown');
      // `/` resolves to the Manager thread, so this is one route rather than a
      // second copy of that resolution.
      expect(screen.getByTestId('chat-missing-manager').getAttribute('href')).toBe('/');
      expect(screen.getByTestId('chat-missing-retry')).toBeInTheDocument();
    });

    it('a chat missing from the ACTIVE roster but present on the server opens normally', async () => {
      // The cold-start roster excludes archived/snoozed/deleted chats, so this
      // is what opening one straight from its URL looks like.
      getChat.mockResolvedValue(summaryRow('c-archived'));
      useChatStore.getState().hydrate([]);
      renderChat('c-archived');
      await waitFor(() => expect(screen.getByTestId('chat-main')).toBeInTheDocument());
      expect(useChatStore.getState().chats['c-archived']?.status).toBe('archived');
    });

    it('Retry re-runs the lookup and opens the chat when it succeeds', async () => {
      getChat.mockRejectedValueOnce(new ApiError(404, 'chat not found: c-later', null));
      useChatStore.getState().hydrate([]);
      renderChat('c-later');
      await waitFor(() => expect(screen.getByTestId('chat-missing-retry')).toBeInTheDocument());
      getChat.mockResolvedValueOnce(summaryRow('c-later'));
      fireEvent.click(screen.getByTestId('chat-missing-retry'));
      await waitFor(() => expect(screen.getByTestId('chat-main')).toBeInTheDocument());
      expect(getChat).toHaveBeenCalledTimes(2);
    });

    it('a lookup that fails for any other reason says so — it does not claim "not found"', async () => {
      getChat.mockRejectedValue(new ApiError(503, 'daemon_timeout', null));
      useChatStore.getState().hydrate([]);
      renderChat('c-unreachable');
      await waitFor(() => expect(screen.getByTestId('chat-main-empty')).toBeInTheDocument());
      expect(screen.getByText('Could not load this chat')).toBeInTheDocument();
      expect(screen.getByTestId('chat-missing-detail').textContent).toBe('daemon_timeout');
      expect(screen.queryByText('Chat not found')).toBeNull();
      // Still a way out, and still retryable.
      expect(screen.getByTestId('chat-missing-manager')).toBeInTheDocument();
      expect(screen.getByTestId('chat-missing-retry')).toBeInTheDocument();
    });
  });
});

// spec/02 § System-reminder disclosure — a turn's captured `<system-reminder>`
// blocks render as a collapsed, click-to-expand box at that turn (Tom:
// "hidden in a box, allow user to see"), never inlined into the bubble text
// and never open by default.
describe('ChatRoute — system-reminder disclosure (spec/02)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders a captured reminder collapsed by default, with the label as its summary', () => {
    seedChat('c-sysctx', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'carry on',
        at: 0,
        systemContext: [
          {
            source: 'patch',
            label: 'Turn interrupted by restart',
            text: 'This turn was already running when the host restarted.',
          },
        ],
      },
    ]);
    renderChat('c-sysctx');

    const disclosure = screen.getByTestId('system-context');
    expect(disclosure.getAttribute('data-open')).toBe('false');
    expect(screen.getByTestId('system-context-summary').textContent).toContain(
      'Turn interrupted by restart',
    );
    expect(screen.queryByTestId('system-context-detail')).toBeNull();
    expect(screen.queryByText('This turn was already running when the host restarted.')).toBeNull();
  });

  it('expands on click to show the raw reminder text', () => {
    seedChat('c-sysctx-2', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'go',
        at: 0,
        systemContext: [
          {
            source: 'patch',
            label: 'Broadcast digest',
            text: 'Recent broadcasts: bus leaves in 5',
          },
        ],
      },
    ]);
    renderChat('c-sysctx-2');

    fireEvent.click(screen.getByTestId('system-context-summary'));
    expect(screen.getByTestId('system-context').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('system-context-detail').textContent).toContain(
      'Recent broadcasts: bus leaves in 5',
    );
  });

  it('renders one disclosure per captured reminder when a turn carried more than one', () => {
    seedChat('c-sysctx-3', [
      {
        seq: 0,
        kind: 'message',
        role: 'user',
        content: 'go',
        at: 0,
        systemContext: [
          { source: 'patch', label: 'Broadcast digest', text: 'bus leaves in 5' },
          { source: 'patch', label: 'Todo list updated', text: 'the user edited the list' },
        ],
      },
    ]);
    renderChat('c-sysctx-3');

    const disclosures = screen.getAllByTestId('system-context');
    expect(disclosures).toHaveLength(2);
  });

  it('shows no disclosure at all on an ordinary turn', () => {
    seedChat('c-sysctx-4', [{ seq: 0, kind: 'message', role: 'user', content: 'hello', at: 0 }]);
    renderChat('c-sysctx-4');

    expect(screen.queryByTestId('system-context')).toBeNull();
  });
});

describe('ChatRoute — provider-level context panel (spec/02)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('shows no panel at all on a chat that has received none', () => {
    seedChat('c-pctx-1', [{ seq: 0, kind: 'message', role: 'user', content: 'hello', at: 0 }]);
    renderChat('c-pctx-1');
    expect(screen.queryByTestId('provider-context-panel')).toBeNull();
  });

  it('renders a collapsed row per providerType, not per occurrence', () => {
    seedChat('c-pctx-2', [{ seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.provider_context',
      chatId: 'c-pctx-2',
      seq: 1,
      providerType: 'model',
      label: 'Model',
      text: 'You are powered by the model named Sonnet 5.',
    });
    // A second occurrence of the SAME providerType must not add a second row.
    useChatStore.getState().applyEvent({
      type: 'chat.provider_context',
      chatId: 'c-pctx-2',
      seq: 2,
      providerType: 'total_tokens_reminder',
      label: 'Tokens remaining',
      text: '14,961,549 tokens left',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.provider_context',
      chatId: 'c-pctx-2',
      seq: 3,
      providerType: 'total_tokens_reminder',
      label: 'Tokens remaining',
      text: '14,900,000 tokens left',
    });
    renderChat('c-pctx-2');

    const rows = screen.getAllByTestId('provider-context');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-open')).toBe('false');
    // The repeated one names its count rather than only showing the latest
    // occurrence with no sign the earlier one ever happened.
    const summaries = screen.getAllByTestId('provider-context-summary').map((el) => el.textContent);
    expect(summaries.some((t) => t?.includes('Model'))).toBe(true);
    expect(summaries.some((t) => t?.includes('Tokens remaining ×2'))).toBe(true);
  });

  it('expands on click to show the latest text, not a stale earlier one', () => {
    seedChat('c-pctx-3', [{ seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.provider_context',
      chatId: 'c-pctx-3',
      seq: 1,
      providerType: 'date',
      label: 'Date',
      text: "Today's date is 2026-09-25.",
    });
    renderChat('c-pctx-3');

    fireEvent.click(screen.getByTestId('provider-context-summary'));
    expect(screen.getByTestId('provider-context').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('provider-context-detail').textContent).toContain(
      "Today's date is 2026-09-25.",
    );
  });

  describe('providerContextVerbosity', () => {
    afterEach(() => {
      usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: false });
    });

    it('off hides the panel even though the chat has received entries', () => {
      usePreferencesStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, providerContextVerbosity: 'off' },
        loaded: true,
      });
      seedChat('c-pctx-off', [{ seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 }]);
      useChatStore.getState().applyEvent({
        type: 'chat.provider_context',
        chatId: 'c-pctx-off',
        seq: 1,
        providerType: 'model',
        label: 'Model',
        text: 'You are powered by the model named Sonnet 5.',
      });
      renderChat('c-pctx-off');
      expect(screen.queryByTestId('provider-context-panel')).toBeNull();
    });

    it('full opens every row by default', () => {
      usePreferencesStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, providerContextVerbosity: 'full' },
        loaded: true,
      });
      seedChat('c-pctx-full', [{ seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 }]);
      useChatStore.getState().applyEvent({
        type: 'chat.provider_context',
        chatId: 'c-pctx-full',
        seq: 1,
        providerType: 'model',
        label: 'Model',
        text: 'You are powered by the model named Sonnet 5.',
      });
      renderChat('c-pctx-full');
      expect(screen.getByTestId('provider-context').getAttribute('data-open')).toBe('true');
      expect(screen.getByTestId('provider-context-detail').textContent).toContain('Sonnet 5');
    });

    it('a per-row click still overrides full closed', () => {
      usePreferencesStore.setState({
        preferences: { ...DEFAULT_PREFERENCES, providerContextVerbosity: 'full' },
        loaded: true,
      });
      seedChat('c-pctx-full-toggle', [
        { seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 },
      ]);
      useChatStore.getState().applyEvent({
        type: 'chat.provider_context',
        chatId: 'c-pctx-full-toggle',
        seq: 1,
        providerType: 'model',
        label: 'Model',
        text: 'You are powered by the model named Sonnet 5.',
      });
      renderChat('c-pctx-full-toggle');
      fireEvent.click(screen.getByTestId('provider-context-summary'));
      expect(screen.getByTestId('provider-context').getAttribute('data-open')).toBe('false');
    });
  });
});

describe('ChatRoute — read watermark follows real visibility, not just mount', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('re-marks read once the tab becomes visible again, without remounting', () => {
    seedChat('c-vis', [{ seq: 0, kind: 'message', role: 'user', content: 'go', at: 0 }]);
    renderChat('c-vis');
    // Mount-time markRead already caught it up.
    expect(useChatStore.getState().chats['c-vis']!.lastReadSeq).toBe(0);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
      // A turn finishes while the tab is backgrounded — the chatStore guard
      // (chatStore.ts's `activeTabVisible`) leaves the watermark behind.
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c-vis',
        role: 'assistant',
        content: 'finished while you were away',
        seq: 1,
      });
    });
    expect(useChatStore.getState().chats['c-vis']!.lastReadSeq).toBe(0);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(useChatStore.getState().chats['c-vis']!.lastReadSeq).toBe(1);
  });
});
