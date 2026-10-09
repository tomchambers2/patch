// app/chats/[chatId].tsx — scroll behaviour (spec/15 § Chat detail: "open at
// the latest message, or restore the user's last position if they had
// scrolled up") + the keyboard-show re-pin effect. `chatScrollMemory` is a
// private module-level Map inside the screen, KEYED BY chatId, that persists
// for the lifetime of the test file (no reset hook) — so every test below
// uses its OWN unique chatId to avoid one test's remembered position leaking
// into another's. Behaviour is observed indirectly via the FlatList stub's
// call log (__flatListCalls, __tests__/stubs/react-native.ts).
//
// The transcript is an INVERTED list (data newest-first, `inverted` flips the
// render direction back to normal reading order — see the block comment on
// `chatScrollMemory` in the screen itself). Offset 0 is always the newest
// message, so `scrollToOffset({ offset: 0 })` is "go to the newest message" —
// there is no separate `scrollToEnd` the way a non-inverted list has one.
// `AT_BOTTOM_SLOP` (24) is the tolerance around offset 0 that still counts as
// "at the newest".
//
// A prior, non-inverted version of this screen needed extra machinery to
// survive content streaming in while the user was mid-gesture — a growing
// "bottom" could fool a plain position test, so follow-mode changes also
// needed a movement-based check, and a dedicated describe block guarded
// against a streaming replay stranding the list at the top. Neither problem
// exists on an inverted list: offset 0 doesn't move as the transcript grows
// (a new message becomes the new item 0; everything else shifts away from
// it, not the other way round), and follow-mode only ever changes inside an
// owned drag/gesture cycle. That whole class of test has no analogue here.
//
// The FlatList stub fires `onContentSizeChange` on a MICROTASK (matching a
// real device, where it always arrives after the current commit's
// synchronous mount effects — see that stub's comment), so every assertion
// that depends on it awaits `flush()` after the render/interaction that
// changed the list's item count.

import React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  update,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __emitKeyboardEvent, __flatListCalls, __resetFlatListCalls } from './stubs/react-native';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

// The screen arms a real settle timer on mount (SETTLE_DEBOUNCE_MS /
// SETTLE_MAX_MS in the screen itself) that fires asynchronously, after the
// test that created it may already have finished. A renderer left mounted
// would still receive that timer's `setSettled(true)` later, outside any
// test's `act()` — unmount it (which runs the chatId-effect's cleanup and
// clears the pending timer) before the next test starts.
const mounted: ReactTestRenderer[] = [];
function render(element: React.ReactElement): ReactTestRenderer {
  const r = renderRN(element);
  mounted.push(r);
  return r;
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetFlatListCalls();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

/** Hydrate a fresh chat (with N messages) under a chatId unique to this call. */
function seedChatWithMessages(chatId: string, count = 3): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      name: 'Chat',
      folder: '~/a',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  for (let i = 0; i < count; i++) {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId,
      seq: i + 1,
      role: 'assistant',
      content: `msg ${i}`,
    });
  }
}

function flatListNode(root: ReturnType<typeof renderRN>['root']): ReturnType<typeof findHost> {
  return findHost(root, (i) => i.type === 'FlatList');
}

// Only `contentOffset` reaches production code (see the file header) — no
// contentSize/layoutMeasurement needed to drive any of this screen's scroll
// logic any more.
function scrollEvent(y: number): unknown {
  return { nativeEvent: { contentOffset: { y } } };
}

/** True once a `scrollToOffset({ offset: 0, ... })` call — "go to the newest
 * message" — appears in the call log. */
function wasScrolledToNewest(): boolean {
  return __flatListCalls.some(
    (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 0,
  );
}

/** Real wait, comfortably past the screen's own SETTLE_DEBOUNCE_MS (80ms) —
 * the reveal gate is a genuine setTimeout, so only a real clock advances it. */
async function waitForSettle(): Promise<void> {
  await actAsync(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
}

/**
 * A GENUINE user scroll, which is the only thing that changes follow mode.
 * The screen keys follow off `onScrollBeginDrag` … `onMomentumScrollEnd`
 * rather than trying to tell its own programmatic scrolls apart from the
 * user's.
 */
function userScrollTo(list: ReturnType<typeof findHost>, y: number): void {
  actSync(() => {
    list.props.onScrollBeginDrag(scrollEvent(y));
    list.props.onScroll(scrollEvent(y));
    list.props.onMomentumScrollEnd(scrollEvent(y));
  });
}

/**
 * A FLING: the finger lifts at `liftY` while the list is still moving, and
 * momentum carries it on to `restY`. The two are deliberately different, and
 * on opposite sides of the at-newest line in the tests below — where the list
 * comes to REST is the user's position, not where their finger happened to
 * leave it. `AT_BOTTOM_SLOP` is 24, so offsets <= 24 are "at the newest".
 */
function userFling(list: ReturnType<typeof findHost>, liftY: number, restY: number): void {
  actSync(() => {
    list.props.onScrollBeginDrag(scrollEvent(liftY));
    list.props.onScroll(scrollEvent(liftY));
    list.props.onScrollEndDrag(scrollEvent(liftY));
    list.props.onMomentumScrollEnd(scrollEvent(restY));
  });
}

describe('initial open — no remembered position', () => {
  it('scrolls to the newest message (offset 0) on first content measurement', async () => {
    seedChatWithMessages('scroll-initial-1');
    __setLocalSearchParams({ chatId: 'scroll-initial-1' });
    render(<ChatDetailScreen />);
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  it('does not scroll at all for an empty timeline', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'scroll-empty-1',
        name: 'Chat',
        folder: '~/a',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    __setLocalSearchParams({ chatId: 'scroll-empty-1' });
    render(<ChatDetailScreen />);
    await flush();
    expect(__flatListCalls.length).toBe(0);
  });
});

describe('reveal — hidden until the transcript has gone quiet', () => {
  // A freshly opened chat must never be seen painting top-down, or trickling
  // in as background virtualization mounts more of a long chat (that is the
  // "starts at the top" / "loads in one at a time" bug this opacity gate
  // exists to fix) — so the first paint is hidden, and it stays hidden until
  // content-size has stopped changing for SETTLE_DEBOUNCE_MS (or
  // SETTLE_MAX_MS has elapsed, for a chat that never goes quiet).
  it('the list is hidden (opacity 0, no touches) on the first paint, before content is measured', () => {
    seedChatWithMessages('scroll-reveal-1');
    __setLocalSearchParams({ chatId: 'scroll-reveal-1' });
    const r = render(<ChatDetailScreen />);
    const list = flatListNode(r.root);
    expect(list.props.style).toMatchObject({ opacity: 0 });
    expect(list.props.pointerEvents).toBe('none');
  });

  it('stays hidden through the landing scroll, and only reveals once things go quiet', async () => {
    seedChatWithMessages('scroll-reveal-2');
    __setLocalSearchParams({ chatId: 'scroll-reveal-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    // The landing scroll has already been issued (covered elsewhere), but the
    // debounce hasn't fired yet — still hidden.
    expect(wasScrolledToNewest()).toBe(true);
    expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 0 });
    await waitForSettle();
    const list = flatListNode(r.root);
    expect(list.props.style).toMatchObject({ opacity: 1 });
    expect(list.props.pointerEvents).toBe('auto');
  });

  // Background virtualization work (more of a long chat mounting after the
  // first paint) re-arms the debounce on every content-size change — so the
  // reveal keeps waiting for as long as that keeps happening, not just for
  // the first one. The stub fires `onContentSizeChange` when the item count
  // changes (mirroring real RN re-measuring layout after content changes —
  // see the stub's own comment), so a new message is what triggers it here.
  it('a content-size change after the first one re-arms the debounce, delaying reveal further', async () => {
    seedChatWithMessages('scroll-reveal-4');
    __setLocalSearchParams({ chatId: 'scroll-reveal-4' });
    const r = render(<ChatDetailScreen />);
    await flush();
    // Fake timers for THIS test only. It is the one case in the file that
    // asserts the reveal has NOT happened yet, so it depends on the clock
    // staying INSIDE an 80ms window — a 20ms margin against a real sleep,
    // which a loaded machine overshoots. It failed a deploy exactly that way
    // (deploy-2026-10-06T10-21-59: "expected opacity 1 to match 0") while
    // passing every time in isolation. The rest of the file waits for the
    // reveal to have happened, which only ever gets safer under load.
    vi.useFakeTimers();
    try {
      // Most of the way to settling, then another batch mounts.
      await actAsync(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 0 });
      actSync(() => {
        useChatStore.getState().applyEvent({
          type: 'chat.message',
          chatId: 'scroll-reveal-4',
          seq: 99,
          role: 'assistant',
          content: 'more content mounting',
        });
      });
      await actAsync(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Had the debounce NOT re-armed, it would have fired ~20ms from now.
      await actAsync(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
      expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 0 });
      // Past the re-armed debounce, and past SETTLE_MAX_MS either way.
      await actAsync(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  // The escape hatch: a chat opened mid-stream (new tokens keep arriving)
  // never goes quiet on its own. Without SETTLE_MAX_MS it would stay hidden —
  // and the typing indicator, which lives inside the same hidden FlatList,
  // with it — for as long as the reply keeps generating.
  it('reveals within SETTLE_MAX_MS even if content never stops changing', async () => {
    seedChatWithMessages('scroll-reveal-5');
    __setLocalSearchParams({ chatId: 'scroll-reveal-5' });
    const r = render(<ChatDetailScreen />);
    await flush();
    // Keep re-arming faster than the debounce (80ms) would ever settle on its
    // own, well past SETTLE_MAX_MS (500ms) — a new message every 30ms, each
    // one changing the item count the stub keys its re-fire on.
    for (let i = 0; i < 20; i++) {
      await actAsync(async () => {
        await new Promise((res) => setTimeout(res, 30));
      });
      actSync(() => {
        useChatStore.getState().applyEvent({
          type: 'chat.message',
          chatId: 'scroll-reveal-5',
          seq: 100 + i,
          role: 'assistant',
          content: `streamed ${i}`,
        });
      });
      await flush();
    }
    expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 1 });
  });

  it('reveals once a restore-to-a-remembered-offset has been issued too', async () => {
    seedChatWithMessages('scroll-reveal-3');
    seedChatWithMessages('scroll-reveal-other', 2);
    __setLocalSearchParams({ chatId: 'scroll-reveal-3' });
    const first = render(<ChatDetailScreen />);
    await flush();
    userScrollTo(flatListNode(first.root), 300); // away from the newest message
    __setLocalSearchParams({ chatId: 'scroll-reveal-other' });
    update(first, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-reveal-3' });
    update(first, <ChatDetailScreen />);
    // Re-opening the same chat starts hidden again — a remembered position is
    // still an unlanded scroll on this fresh mount.
    expect(flatListNode(first.root).props.style).toMatchObject({ opacity: 0 });
    await waitForSettle();
    expect(flatListNode(first.root).props.style).toMatchObject({ opacity: 1 });
  });

  // Todoist 6hfFww7fH7JQFWj4 ("the new chat should start in that window with
  // no flickering"): `newChatRoute` sends the screen here with
  // `justCreated=1` right off the send that created this chat — its one
  // message is already in the store, synchronously, from that send's own
  // optimistic echo, so there is nothing behind it for the settle-hide to be
  // covering. It must skip the hide entirely, not just shorten it — even the
  // 80ms debounce is a blank flash between "sent" and "message appears".
  it('a chat opened with justCreated=1 is never hidden, even for an instant', () => {
    seedChatWithMessages('scroll-justcreated-1');
    __setLocalSearchParams({ chatId: 'scroll-justcreated-1', justCreated: '1' });
    const r = render(<ChatDetailScreen />);
    const list = flatListNode(r.root);
    expect(list.props.style).toMatchObject({ opacity: 1 });
    expect(list.props.pointerEvents).toBe('auto');
  });

  it('leaving a justCreated chat and reopening it normally hides it again, as any other chat', async () => {
    seedChatWithMessages('scroll-justcreated-2');
    seedChatWithMessages('scroll-justcreated-other', 2);
    __setLocalSearchParams({ chatId: 'scroll-justcreated-2', justCreated: '1' });
    const r = render(<ChatDetailScreen />);
    expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 1 });
    __setLocalSearchParams({ chatId: 'scroll-justcreated-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-justcreated-2' });
    update(r, <ChatDetailScreen />);
    // No `justCreated` this time (a plain re-open from the chat list) — the
    // ordinary settle-hide applies, exactly as for any other chat.
    expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 0 });
    await waitForSettle();
    expect(flatListNode(r.root).props.style).toMatchObject({ opacity: 1 });
  });
});

describe('onScroll — follow-mode tracking', () => {
  it('a scroll that lands away from the newest flips follow off (no further auto-scroll on new content)', async () => {
    seedChatWithMessages('scroll-follow-off-1');
    __setLocalSearchParams({ chatId: 'scroll-follow-off-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    userScrollTo(list, 300);
    __flatListCalls.length = 0;
    // New content arrives — the FlatList stub re-fires onContentSizeChange
    // whenever the item count grows (mirroring real RN re-measuring layout
    // after content changes).
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-follow-off-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(false);
  });

  it('a scroll that lands at the newest keeps follow on (auto-scrolls on new content)', async () => {
    seedChatWithMessages('scroll-follow-on-1');
    __setLocalSearchParams({ chatId: 'scroll-follow-on-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    userScrollTo(list, 0);
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-follow-on-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  // A drag that stays within the slop band never really left the newest
  // message, so follow must stay on; one that clears it must flip off
  // immediately on the drag itself, not wait for a release.
  it('a drag within AT_BOTTOM_SLOP keeps follow on; clearing it turns follow off mid-drag', async () => {
    seedChatWithMessages('scroll-slop-1');
    __setLocalSearchParams({ chatId: 'scroll-slop-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    actSync(() => {
      list.props.onScrollBeginDrag(scrollEvent(0));
      list.props.onScroll(scrollEvent(0));
      list.props.onScroll(scrollEvent(10)); // inside the 24px slop
    });
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).toBeNull();
    actSync(() => {
      list.props.onScroll(scrollEvent(40)); // outside the slop
    });
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).not.toBeNull();
  });

  // spec/15 § Chat detail: sending a message re-pins to the bottom even if the
  // user had scrolled up — the sent turn + its reply must be in view. Matches
  // web's `ChatRoute.tsx` "scrolls to the bottom when the user sends a
  // message, even after scrolling up" behaviour.
  it('re-pins to the newest message when the user sends a message, even after scrolling up', async () => {
    seedChatWithMessages('scroll-send-repin-1');
    __setLocalSearchParams({ chatId: 'scroll-send-repin-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    // User scrolls away to read history → follow off.
    userScrollTo(list, 300);
    __flatListCalls.length = 0;
    // User sends: the composer's optimistic echo path.
    actSync(() => {
      useChatStore.getState().appendLocalUserMessage('scroll-send-repin-1', 'hello', 'L-new');
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  // A fling is one gesture reported in two parts, and the part that matters is
  // the second. Reading follow mode off the finger-lift leaves the user sitting
  // at the newest message with following turned off, so new messages stop
  // scrolling in — and writes that stale offset into the remembered position.
  it('a fling DOWN to the newest message re-engages follow from where it comes to rest', async () => {
    seedChatWithMessages('scroll-fling-down-1');
    __setLocalSearchParams({ chatId: 'scroll-fling-down-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    // Lifts at 300 (away from newest), momentum carries it to 0 (the newest).
    userFling(list, 300, 0);
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-fling-down-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  it('dragging back to the newest message re-engages follow', async () => {
    seedChatWithMessages('scroll-drag-back-down-1');
    __setLocalSearchParams({ chatId: 'scroll-drag-back-down-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    actSync(() => {
      list.props.onScrollBeginDrag(scrollEvent(0));
      list.props.onScroll(scrollEvent(0));
      list.props.onScroll(scrollEvent(300)); // away into history → follow off
      list.props.onScroll(scrollEvent(0)); // and back to the newest
      list.props.onScrollEndDrag(scrollEvent(0));
      list.props.onMomentumScrollEnd(scrollEvent(0));
    });
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-drag-back-down-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  // The mirror image: still within the at-newest slop at the moment of
  // release, but the fling carries them away into history. Reading the lift
  // leaves follow on and the next content growth yanks them straight back.
  it('a fling UP into history disengages follow from where it comes to rest', async () => {
    seedChatWithMessages('scroll-fling-up-1');
    __setLocalSearchParams({ chatId: 'scroll-fling-up-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    // Lifts at 0 (still at the newest), momentum carries it away to 300.
    userFling(list, 0, 300);
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-fling-up-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(false);
  });

  it('a fling remembers where it came to rest, not where the finger lifted', async () => {
    seedChatWithMessages('scroll-fling-memory-1', 3);
    seedChatWithMessages('scroll-fling-memory-other', 2);
    __setLocalSearchParams({ chatId: 'scroll-fling-memory-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    userFling(flatListNode(r.root), 0, 300);
    __setLocalSearchParams({ chatId: 'scroll-fling-memory-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-fling-memory-1' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    const offsetCall = __flatListCalls.find(
      (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 300,
    );
    expect(offsetCall).toBeDefined();
  });

  // A release that throws no fling is complete at the finger-lift: there is no
  // momentum end coming, so that settle has to be the one that counts.
  it('a release with no momentum still records the position', async () => {
    seedChatWithMessages('scroll-no-momentum-1');
    __setLocalSearchParams({ chatId: 'scroll-no-momentum-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    actSync(() => {
      list.props.onScrollBeginDrag(scrollEvent(300));
      list.props.onScroll(scrollEvent(300));
      list.props.onScrollEndDrag(scrollEvent(300));
    });
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-no-momentum-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(false);
  });

  // A mark of ours that never got its settle (an animated scroll with nowhere
  // to go emits none) must not be left standing where the next fling's settle
  // can land on it.
  it('an unconsumed self-scroll mark does not swallow the next fling', async () => {
    seedChatWithMessages('scroll-stale-mark-1');
    __setLocalSearchParams({ chatId: 'scroll-stale-mark-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    // Two animated re-pins, neither of which reports a settle.
    actSync(() => {
      __emitKeyboardEvent('keyboardDidShow');
    });
    actSync(() => {
      __emitKeyboardEvent('keyboardDidShow');
    });
    userFling(list, 0, 300);
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-stale-mark-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(false);
  });

  // The recurrence Tom re-filed on 2026-09-07, three weeks after the send
  // re-pin first shipped. The re-pin itself was firing; a settle event for our
  // OWN animated scroll was cancelling it before the new row was measured.
  it('the sent turn still lands in view when our own momentum-end races the send', async () => {
    seedChatWithMessages('scroll-send-race-1');
    __setLocalSearchParams({ chatId: 'scroll-send-race-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    actSync(() => {
      useChatStore.getState().appendLocalUserMessage('scroll-send-race-1', 'hello', 'L-race');
      __emitKeyboardEvent('keyboardDidShow');
    });
    actSync(() => {
      // Ignored regardless of offset: the keyboard's own animated scroll just
      // above already cleared `gestureOpenRef`, so this momentum-end has no
      // drag behind it to own.
      list.props.onMomentumScrollEnd(scrollEvent(999));
    });
    __flatListCalls.length = 0;
    // The new row finally measures — the only correction left, and it is gated
    // on follow mode.
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  // onMomentumScrollEnd is not a user-only signal on Android: an animated
  // programmatic scroll emits one too. Follow mode answers "does the USER want
  // to stay pinned", so a settle no drag opened must leave it alone.
  it('a momentum-end with no drag behind it does not turn follow off', async () => {
    seedChatWithMessages('scroll-self-momentum-1');
    __setLocalSearchParams({ chatId: 'scroll-self-momentum-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    actSync(() => {
      __emitKeyboardEvent('keyboardDidShow');
    });
    actSync(() => {
      list.props.onMomentumScrollEnd(scrollEvent(999));
    });
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-self-momentum-1',
        seq: 99,
        role: 'assistant',
        content: 'new one',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  // ...and it must not poison the remembered position either: a chat the user
  // never scrolled away in has to re-open at its newest message.
  it('a momentum-end with no drag behind it does not record a scrolled-away position', async () => {
    seedChatWithMessages('scroll-self-momentum-2', 3);
    seedChatWithMessages('scroll-self-momentum-other', 2);
    __setLocalSearchParams({ chatId: 'scroll-self-momentum-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    actSync(() => {
      // No onScrollBeginDrag ever fired — gestureOpenRef is false, so this is
      // ignored. If it were wrongly recorded anyway, 555 would show up as a
      // remembered offset below.
      list.props.onMomentumScrollEnd(scrollEvent(555));
    });
    __setLocalSearchParams({ chatId: 'scroll-self-momentum-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-self-momentum-2' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
    expect(
      __flatListCalls.some(
        (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 555,
      ),
    ).toBe(false);
  });

  // The echo is the last entry only at the instant it is appended. Anything the
  // turn emits next — here the permission-mode marker (spec/02 § Permission
  // mode) — shares the commit, and a re-pin that only ever reads
  // `timeline[length - 1]` stops firing the moment that happens.
  it('re-pins even when the sent echo is not the last timeline entry', async () => {
    seedChatWithMessages('scroll-send-not-last-1');
    __setLocalSearchParams({ chatId: 'scroll-send-not-last-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    userScrollTo(list, 300);
    __flatListCalls.length = 0;
    actSync(() => {
      useChatStore.getState().appendLocalUserMessage('scroll-send-not-last-1', 'hello', 'L-nl');
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-send-not-last-1',
        seq: 60,
        role: 'system',
        content: 'Permission mode: plan',
        permissionModeChange: 'plan',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
  });

  // Searching backwards for the newest still-pending echo must not re-yank the
  // list when a NEWER echo reconciles away and an older unacked one becomes the
  // newest again — that turn was sent long ago and has already been scrolled to.
  it('does not re-yank when a newer echo reconciles and an older pending one resurfaces', async () => {
    seedChatWithMessages('scroll-send-two-1');
    __setLocalSearchParams({ chatId: 'scroll-send-two-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    actSync(() => {
      useChatStore.getState().appendLocalUserMessage('scroll-send-two-1', 'first', 'L-a');
    });
    await flush();
    actSync(() => {
      useChatStore.getState().appendLocalUserMessage('scroll-send-two-1', 'second', 'L-b');
    });
    await flush();
    const list = flatListNode(r.root);
    // The user goes back to read history; only a genuine drag may turn follow off.
    userScrollTo(list, 300);
    __flatListCalls.length = 0;
    // The SECOND send's persisted copy lands and clears its localId, making the
    // first send's still-pending echo the newest one carrying a localId again.
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-send-two-1',
        seq: 70,
        role: 'user',
        content: 'second',
        localId: 'L-b',
      });
    });
    await flush();
    expect(wasScrolledToNewest()).toBe(false);
  });
});

describe('remembered scroll position across a re-open', () => {
  it('re-opening the same chat after scrolling away restores the saved offset instead of re-pinning to the newest', async () => {
    seedChatWithMessages('scroll-remember-1', 3);
    seedChatWithMessages('scroll-remember-other', 2); // a DIFFERENT count, so the
    // FlatList stub's item-count-keyed effect actually re-fires on the swap below.
    __setLocalSearchParams({ chatId: 'scroll-remember-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    userScrollTo(list, 123);
    // Navigate away (a chat with a different message count) then BACK — the
    // FlatList stub re-fires onContentSizeChange whenever the item count
    // changes, mirroring a real FlatList re-measuring layout after a content
    // swap (expo-router keeps the screen instance alive across a param
    // change on a dynamic route, matching `update()` here rather than a hard
    // unmount/remount).
    __setLocalSearchParams({ chatId: 'scroll-remember-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-remember-1' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    const offsetCall = __flatListCalls.find((c) => c.method === 'scrollToOffset');
    expect(offsetCall).toBeDefined();
    expect((offsetCall!.args[0] as { offset: number }).offset).toBe(123);
  });

  // Settling within the slop band (not exactly 0) still counts as "at the
  // newest" — and reopening snaps to the true newest (offset 0), not back to
  // that imprecise resting offset, which is what tells apart "pinned to the
  // newest" from "restored to a remembered offset" now that both are
  // `scrollToOffset` calls.
  it('re-opening after having stayed at the newest re-pins to offset 0, not the imprecise resting offset', async () => {
    seedChatWithMessages('scroll-remember-2', 3);
    seedChatWithMessages('scroll-remember-other2', 2);
    __setLocalSearchParams({ chatId: 'scroll-remember-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    userScrollTo(list, 10); // inside AT_BOTTOM_SLOP, not exactly 0
    __setLocalSearchParams({ chatId: 'scroll-remember-other2' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-remember-2' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    expect(wasScrolledToNewest()).toBe(true);
    expect(
      __flatListCalls.some(
        (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 10,
      ),
    ).toBe(false);
  });

  // An echo still carrying a localId at OPEN time was sent before this open —
  // typically an unacked one held for redelivery (spec/12 § Guaranteed input
  // delivery). It is not a send happening now, so it must not override the
  // remembered position the way a live send does.
  it('a pending echo already in the transcript at open time does not count as a send', async () => {
    seedChatWithMessages('scroll-open-pending-1', 3);
    seedChatWithMessages('scroll-open-pending-other', 2);
    useChatStore.getState().appendLocalUserMessage('scroll-open-pending-1', 'unacked', 'L-old');
    __setLocalSearchParams({ chatId: 'scroll-open-pending-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    userScrollTo(flatListNode(r.root), 321);
    __setLocalSearchParams({ chatId: 'scroll-open-pending-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-open-pending-1' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    const offsetCall = __flatListCalls.find((c) => c.method === 'scrollToOffset');
    expect(offsetCall).toBeDefined();
    expect((offsetCall!.args[0] as { offset: number }).offset).toBe(321);
  });

  // A send is a more recent statement of where the user wants to be than the
  // remembered offset is. Re-opening a chat the user had scrolled away in and
  // typing into it straight away used to have the first content measurement
  // restore the old offset ON TOP of the send's re-pin, and turn following off
  // with it — so the reply never scrolled in either.
  it('a send before the first content measurement outranks the remembered position', async () => {
    seedChatWithMessages('scroll-send-beats-restore-1', 3);
    seedChatWithMessages('scroll-send-beats-restore-other', 2);
    __setLocalSearchParams({ chatId: 'scroll-send-beats-restore-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    userScrollTo(flatListNode(r.root), 123);
    __setLocalSearchParams({ chatId: 'scroll-send-beats-restore-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    // Re-open, and send before the list has had its first measurement.
    __setLocalSearchParams({ chatId: 'scroll-send-beats-restore-1' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    actSync(() => {
      useChatStore
        .getState()
        .appendLocalUserMessage('scroll-send-beats-restore-1', 'hello', 'L-beats');
    });
    await flush();
    expect(
      __flatListCalls.some(
        (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 123,
      ),
    ).toBe(false);
    expect(__flatListCalls[__flatListCalls.length - 1]).toMatchObject({
      method: 'scrollToOffset',
      args: [{ offset: 0, animated: false }],
    });
  });
});

// FlatList's own answer to "what's on screen" (`onViewableItemsChanged`) is
// the mobile equivalent of web's DOM-measurement anchor (`ChatRoute.tsx`,
// commit a4a1256a): restoring by the message that was on screen, rather than
// a raw pixel offset that stops meaning the same thing once the rows above it
// change (Todoist: "switching chat puts you in a different position when you
// come back" — also true here, since this screen's `onContentSizeChange`
// restore had the exact same raw-offset shape).
describe('remembered scroll position — anchored to a message, not a raw offset', () => {
  it('restores to the anchor message’s current index (scrollToIndex) even after new messages have shifted every index, not the stale raw offset', async () => {
    seedChatWithMessages('scroll-anchor-1', 3); // seq 1..3; invertedRows: [3, 2, 1]
    seedChatWithMessages('scroll-anchor-other', 2);
    __setLocalSearchParams({ chatId: 'scroll-anchor-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    // Scroll away, and report that the row at invertedRows[1] (seq 2) is what
    // FlatList says is on screen — the anchor a real device would capture via
    // viewability, not the (irrelevant to this test) raw pixel offset.
    actSync(() => {
      list.props.onScrollBeginDrag(scrollEvent(300));
      list.props.onScroll(scrollEvent(300));
      list.props.onViewableItemsChanged({ viewableItems: [{ index: 1 }] });
      list.props.onScrollEndDrag(scrollEvent(300));
      list.props.onMomentumScrollEnd(scrollEvent(300));
    });
    // Navigate away, and a NEW message arrives while the chat is closed — on
    // an inverted list that shifts every existing row's index by one
    // (invertedRows becomes [4, 3, 2, 1]; seq 2 moves from index 1 to index
    // 2). A raw offset survives this by accident in this stub (it doesn't
    // model row heights at all) — a real device's rows would have reflowed
    // under it, which is the bug being fixed. What this test can prove
    // directly is that the anchor is looked up by IDENTITY at restore time,
    // landing on seq 2's index AS OF THE REOPEN, not the index it had when
    // the position was recorded.
    __setLocalSearchParams({ chatId: 'scroll-anchor-other' });
    update(r, <ChatDetailScreen />);
    await flush();
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'scroll-anchor-1',
        seq: 4,
        role: 'assistant',
        content: 'msg 3',
      });
    });
    __setLocalSearchParams({ chatId: 'scroll-anchor-1' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    expect(__flatListCalls).toContainEqual({
      method: 'scrollToIndex',
      args: [{ index: 2, viewPosition: 0.5, animated: false }],
    });
    expect(
      __flatListCalls.some(
        (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 300,
      ),
    ).toBe(false);
  });

  it('falls back to the raw offset when no anchor was captured (e.g. the list settled before any viewability report)', async () => {
    seedChatWithMessages('scroll-anchor-2', 3);
    seedChatWithMessages('scroll-anchor-other2', 2);
    __setLocalSearchParams({ chatId: 'scroll-anchor-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    // Scrolls away WITHOUT ever firing onViewableItemsChanged.
    userScrollTo(flatListNode(r.root), 250);
    __setLocalSearchParams({ chatId: 'scroll-anchor-other2' });
    update(r, <ChatDetailScreen />);
    await flush();
    __setLocalSearchParams({ chatId: 'scroll-anchor-2' });
    __flatListCalls.length = 0;
    update(r, <ChatDetailScreen />);
    await flush();
    expect(
      __flatListCalls.some(
        (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 250,
      ),
    ).toBe(true);
  });
});

describe('keyboard-show re-pin (spec/15 § Composer)', () => {
  it('re-pins to the newest message on keyboardDidShow while following', async () => {
    seedChatWithMessages('scroll-kbd-1');
    __setLocalSearchParams({ chatId: 'scroll-kbd-1' });
    render(<ChatDetailScreen />);
    await flush();
    __flatListCalls.length = 0;
    actSync(() => {
      __emitKeyboardEvent('keyboardDidShow');
    });
    const call = __flatListCalls.find(
      (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 0,
    );
    expect(call).toBeDefined();
    expect((call!.args[0] as { animated: boolean }).animated).toBe(true);
  });

  it('does NOT re-pin on keyboardDidShow once the user has scrolled away (follow off)', async () => {
    seedChatWithMessages('scroll-kbd-2');
    __setLocalSearchParams({ chatId: 'scroll-kbd-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    userScrollTo(list, 300);
    __flatListCalls.length = 0;
    actSync(() => {
      __emitKeyboardEvent('keyboardDidShow');
    });
    expect(wasScrolledToNewest()).toBe(false);
  });

  // Todoist: "Patch opening keyboard should keep same content focused on
  // mobile. I'm looking at something and I want to keep it in view while I
  // write a response". The window is `adjustResize`, so the keyboard shrinks
  // the list. An inverted list keeps its offset, which is measured from the
  // NEWEST end — so left alone, the whole transcript slides up by the
  // keyboard's height and what the reader was looking at goes off the top.
  // Holding the top of the view means scrolling further into history by
  // exactly the height the list lost (and back again when it is returned).
  function layout(list: ReturnType<typeof findHost>, height: number): void {
    actSync(() => {
      list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } });
    });
  }
  function offsetsScrolledTo(): number[] {
    return __flatListCalls
      .filter((c) => c.method === 'scrollToOffset')
      .map((c) => (c.args[0] as { offset: number }).offset);
  }

  it('keeps what was at the top of the view in place when the keyboard shrinks the list', async () => {
    seedChatWithMessages('scroll-kbd-hold-1');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    layout(list, 700);
    userFling(list, 300, 300);
    __flatListCalls.length = 0;

    layout(list, 400); // the keyboard takes 300 of the list's 700
    actSync(() => {
      __emitKeyboardEvent('keyboardDidShow');
    });

    expect(offsetsScrolledTo()).toEqual([600]);
    const call = __flatListCalls.find((c) => c.method === 'scrollToOffset');
    expect((call!.args[0] as { animated: boolean }).animated).toBe(false);
  });

  it('gives the room back the same way when the keyboard closes', async () => {
    seedChatWithMessages('scroll-kbd-hold-2');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    layout(list, 700);
    userFling(list, 300, 300);
    layout(list, 400);
    // The platform reports the compensating scroll like any other.
    actSync(() => {
      list.props.onScroll(scrollEvent(600));
    });
    __flatListCalls.length = 0;

    layout(list, 700);

    expect(offsetsScrolledTo()).toEqual([300]);
  });

  it('never compensates while following — the newest message stays pinned instead', async () => {
    seedChatWithMessages('scroll-kbd-hold-3');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-3' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    layout(list, 700);
    __flatListCalls.length = 0;

    layout(list, 400);

    expect(offsetsScrolledTo().filter((o) => o !== 0)).toEqual([]);
  });

  it('the first layout of an open is a measurement, not a resize', async () => {
    seedChatWithMessages('scroll-kbd-hold-4');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-4' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    userFling(list, 300, 300);
    __flatListCalls.length = 0;

    layout(list, 400);

    expect(offsetsScrolledTo()).toEqual([]);
  });

  it("leaves the offset to the open's own restore until the transcript has settled", async () => {
    seedChatWithMessages('scroll-kbd-hold-5');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-5' });
    const r = render(<ChatDetailScreen />);
    await flush();
    const list = flatListNode(r.root);
    layout(list, 700);
    userFling(list, 300, 300);
    __flatListCalls.length = 0;

    layout(list, 400);

    expect(offsetsScrolledTo()).toEqual([]);
  });

  it('a relayout at the same height moves nothing', async () => {
    seedChatWithMessages('scroll-kbd-hold-6');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-6' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    layout(list, 700);
    userFling(list, 300, 300);
    __flatListCalls.length = 0;

    layout(list, 700);

    expect(offsetsScrolledTo()).toEqual([]);
  });

  it("a resize under a finger still on the list is the finger's to settle", async () => {
    seedChatWithMessages('scroll-kbd-hold-7');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-7' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    layout(list, 700);
    userFling(list, 300, 300);
    actSync(() => {
      list.props.onScrollBeginDrag(scrollEvent(300));
    });
    __flatListCalls.length = 0;

    layout(list, 400);

    expect(offsetsScrolledTo()).toEqual([]);
  });

  it('never scrolls past the newest message when the list grows by more than the offset', async () => {
    seedChatWithMessages('scroll-kbd-hold-8');
    __setLocalSearchParams({ chatId: 'scroll-kbd-hold-8' });
    const r = render(<ChatDetailScreen />);
    await flush();
    await waitForSettle();
    const list = flatListNode(r.root);
    layout(list, 400);
    userFling(list, 100, 100);
    __flatListCalls.length = 0;

    layout(list, 700);

    expect(offsetsScrolledTo()).toEqual([0]);
  });

  it('the keyboard listener is removed on unmount (cleanup does not throw)', async () => {
    seedChatWithMessages('scroll-kbd-3');
    __setLocalSearchParams({ chatId: 'scroll-kbd-3' });
    const r = render(<ChatDetailScreen />);
    await flush();
    expect(() => r.unmount()).not.toThrow();
    expect(() => __emitKeyboardEvent('keyboardDidShow')).not.toThrow();
  });
});

describe('floating "scroll to bottom" button — mirrors follow mode', () => {
  it('is hidden while at the newest message (the default, freshly-opened state)', async () => {
    seedChatWithMessages('scroll-fab-1');
    __setLocalSearchParams({ chatId: 'scroll-fab-1' });
    const r = render(<ChatDetailScreen />);
    await flush();
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).toBeNull();
  });

  it('appears once the user scrolls away from the newest message', async () => {
    seedChatWithMessages('scroll-fab-2');
    __setLocalSearchParams({ chatId: 'scroll-fab-2' });
    const r = render(<ChatDetailScreen />);
    await flush();
    userScrollTo(flatListNode(r.root), 300);
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).not.toBeNull();
  });

  it('tapping it scrolls to the newest message and hides itself again', async () => {
    seedChatWithMessages('scroll-fab-3');
    __setLocalSearchParams({ chatId: 'scroll-fab-3' });
    const r = render(<ChatDetailScreen />);
    await flush();
    userScrollTo(flatListNode(r.root), 300);
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).not.toBeNull();
    __flatListCalls.length = 0;
    actSync(() => {
      findHost(r.root, byTestId('scroll-to-bottom')).props.onPress();
    });
    expect(wasScrolledToNewest()).toBe(true);
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).toBeNull();
  });

  it('re-pinning by sending a message also hides it', async () => {
    seedChatWithMessages('scroll-fab-4');
    __setLocalSearchParams({ chatId: 'scroll-fab-4' });
    const r = render(<ChatDetailScreen />);
    await flush();
    userScrollTo(flatListNode(r.root), 300);
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).not.toBeNull();
    actSync(() => {
      useChatStore.getState().appendLocalUserMessage('scroll-fab-4', 'hello', 'L-fab-4');
    });
    await flush();
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).toBeNull();
  });
});
