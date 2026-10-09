// Render coverage for the Chats-tab row (spec/15 § Row tools). Pins:
//   - tap → router.push to the chat, long-press AND the ⋯ kebab both open
//     the same row-actions sheet (showChatLongPressSheet)
//   - active-row highlight (accentTint/accentSoft border) vs inactive styling
//   - the pinned-icon and folder-mono-font conditional branches
//   - useSettledPreview: the row holds its OLD preview steady for
//     PREVIEW_SETTLE_MS after the underlying preview changes, then updates —
//     so a burst of chat.replay events doesn't flicker the row through every
//     intermediate message (see ChatRow.tsx's own comment on this).
//   - the swipe tray reads Pin, Snooze, Archive
//   - a snoozed row shows its wake time compactly in the right-hand slot

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  update,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  actSync,
  actAsync,
} from './testUtils/render';
import { ChatRowItem, useSettledPreview } from '../src/components/ChatRow';
import type { ChatRow as ChatRowT } from '../src/stores/types';
import { useChatStore } from '../src/stores/chatStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import {
  applySnooze,
  showChatLongPressSheet,
  showChatSnoozeSheet,
  toggleArchive,
  togglePin,
} from '../src/components/ChatLongPressSheet';
import { fonts, lightColors, typography } from '../src/lib/theme';
import { formatWakeTimeCompact } from '../src/lib/snooze';

// The title/preview Text nodes are picked out by their distinctive style
// rather than array index, because the StatusBadge itself renders an extra
// Text glyph ('✓') for a 'read' row — indexing would silently pick the wrong
// node depending on the row's badge state.
const byTitle = (i: { props: { style?: { fontFamily?: string } } }): boolean =>
  i.props.style?.fontFamily === typography.rowTitle.fontFamily;
const byPreview = (i: { props: { style?: { marginTop?: number } } }): boolean =>
  i.props.style?.marginTop === 2;

vi.mock('../src/components/ChatLongPressSheet', () => ({
  showChatLongPressSheet: vi.fn(),
  showChatSnoozeSheet: vi.fn(),
  toggleArchive: vi.fn(),
  togglePin: vi.fn(),
  applySnooze: vi.fn(),
}));

function makeRow(overrides: Partial<ChatRowT> = {}): ChatRowT {
  return {
    chatId: 'chat-1',
    name: 'Weekend plan',
    folder: '/home/tom/projects/weekend',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 100,
    awaitingPermission: false,
    lastVisitedAt: 200, // > lastUpdated → 'read' badge by default
    preview: 'Sounds good, see you then',
    pendingPermissions: [],
    lastSeq: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useChatStore.setState({ activeChatId: null });
  __resetRouterMock();
  vi.mocked(showChatLongPressSheet).mockClear();
  vi.mocked(showChatSnoozeSheet).mockClear();
  vi.mocked(toggleArchive).mockClear();
  vi.mocked(togglePin).mockClear();
  vi.mocked(applySnooze).mockClear();
});

describe('ChatRowItem — navigation', () => {
  it('tapping the row body pushes to the chat detail route', () => {
    const row = makeRow();
    const r = renderRN(<ChatRowItem row={row} />);
    findHost(
      r.root,
      (i) =>
        i.props.accessibilityRole === 'button' &&
        i.props.accessibilityLabel?.startsWith('Open chat'),
    ).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/chat-1');
  });

  it('long-pressing the row body opens the row-actions sheet', () => {
    const row = makeRow();
    const r = renderRN(<ChatRowItem row={row} />);
    findHost(r.root, (i) =>
      i.props.accessibilityLabel?.startsWith('Open chat'),
    ).props.onLongPress();
    expect(showChatLongPressSheet).toHaveBeenCalledWith(row);
  });

  it('tapping the ⋯ kebab ALSO opens the same row-actions sheet', () => {
    const row = makeRow();
    const r = renderRN(<ChatRowItem row={row} />);
    findHost(
      r.root,
      (i) => i.props.accessibilityLabel === 'Chat actions for Weekend plan',
    ).props.onPress();
    expect(showChatLongPressSheet).toHaveBeenCalledWith(row);
  });

  it('the ⋯ kebab dims to opacity 0.5 while pressed, and back to 1 on release', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    const kebab = (): ReturnType<typeof findHost> =>
      findHost(r.root, (i) => i.props.accessibilityLabel === 'Chat actions for Weekend plan');
    expect(kebab().props.style.opacity).toBe(1);
    actSync(() => kebab().props.onPressIn());
    expect(kebab().props.style.opacity).toBe(0.5);
    actSync(() => kebab().props.onPressOut());
    expect(kebab().props.style.opacity).toBe(1);
  });
});

describe('ChatRowItem — active-row highlight', () => {
  it('is NOT highlighted when a different chat is active', () => {
    useChatStore.setState({ activeChatId: 'some-other-chat' });
    const row = makeRow();
    const r = renderRN(<ChatRowItem row={row} />);
    // The row's own styled surface is the Animated.View the swipe gesture
    // moves — trays behind it are separate sibling Views, not this node.
    const outer = findHost(r.root, byTestId('chat-row-surface'));
    expect(outer.props.style.backgroundColor).toBe(lightColors.paperRaised);
    expect(outer.props.style.borderColor).toBe(lightColors.lineSoft);
  });

  it('IS highlighted (accentTint bg, accentSoft border) when this row is the active chat', () => {
    useChatStore.setState({ activeChatId: null });
    const inactive = renderRN(<ChatRowItem row={makeRow()} />);
    const inactiveStyle = findHost(inactive.root, byTestId('chat-row-surface')).props.style;
    expect(inactiveStyle.backgroundColor).toBe(lightColors.paperRaised);
    expect(inactiveStyle.borderColor).toBe(lightColors.lineSoft);

    useChatStore.setState({ activeChatId: 'chat-1' });
    const active = renderRN(<ChatRowItem row={makeRow()} />);
    const activeStyle = findHost(active.root, byTestId('chat-row-surface')).props.style;
    expect(activeStyle.backgroundColor).toBe(lightColors.accentTint);
    expect(activeStyle.borderColor).toBe(lightColors.accentSoft);
  });
});

describe('ChatRowItem — pinned + folder conditionals', () => {
  it('renders a Pin icon when pinned, and none when not', () => {
    // Scoped to the row surface: the swipe trays behind it also carry a Pin
    // icon (the Pin/Unpin tray button), which would otherwise double-count.
    const pinned = renderRN(<ChatRowItem row={makeRow({ pinned: true })} />);
    const pinnedSurface = findHost(pinned.root, byTestId('chat-row-surface'));
    expect(
      findHost(pinnedSurface, (i) => i.type === 'Icon' && i.props.name === 'Pin'),
    ).toBeDefined();

    const unpinned = renderRN(<ChatRowItem row={makeRow({ pinned: false })} />);
    const unpinnedSurface = findHost(unpinned.root, byTestId('chat-row-surface'));
    expect(
      unpinnedSurface.findAll(
        (i) => typeof i.type === 'string' && i.type === 'Icon' && i.props.name === 'Pin',
      ).length,
    ).toBe(0);
  });

  it('renders the preview in the body face at the meta size, folder or not — never mono', () => {
    for (const folder of ['/x/y', '']) {
      const r = renderRN(<ChatRowItem row={makeRow({ folder })} />);
      const preview = findHost(r.root, byPreview);
      expect(preview.props.style.fontSize).toBe(typography.meta.fontSize);
      expect(preview.props.style.fontFamily).toBe(fonts.body);
    }
  });
});

describe('ChatRowItem — badge-derived title colour', () => {
  it('shows the muted ink3 title colour for a read (idle, already-visited) row', () => {
    const readRow = makeRow({ activity: 'idle', lastUpdated: 1, lastVisitedAt: 2 }); // read
    const r = renderRN(<ChatRowItem row={readRow} />);
    const title = findHost(r.root, byTitle);
    expect(title.props.style.color).toBe(lightColors.ink3);
  });

  it('shows the full ink title colour for a non-read (unread/done) row', () => {
    const doneRow = makeRow({ activity: 'idle', lastUpdated: 2, lastVisitedAt: 1 }); // done
    const r = renderRN(<ChatRowItem row={doneRow} />);
    const title = findHost(r.root, byTitle);
    expect(title.props.style.color).toBe(lightColors.ink);
  });
});

describe('useSettledPreview — settles instead of flickering through history', () => {
  it('holds the previous preview for PREVIEW_SETTLE_MS, then adopts the new one', async () => {
    vi.useFakeTimers();
    try {
      function Probe({ row }: { row: ChatRowT }): React.ReactElement {
        const shown = useSettledPreview(row);
        return React.createElement('Text', null, shown);
      }
      const r = renderRN(<Probe row={makeRow({ preview: 'first' })} />);
      expect((r.toJSON() as { children: string[] }).children[0]).toBe('first');

      update(r, <Probe row={makeRow({ preview: 'second' })} />);
      // Immediately after the update the OLD value must still show.
      expect((r.toJSON() as { children: string[] }).children[0]).toBe('first');

      await actAsync(async () => {
        vi.advanceTimersByTime(250);
      });
      expect((r.toJSON() as { children: string[] }).children[0]).toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the pending settle timer when the target changes again before it fires', async () => {
    vi.useFakeTimers();
    try {
      function Probe({ row }: { row: ChatRowT }): React.ReactElement {
        const shown = useSettledPreview(row);
        return React.createElement('Text', null, shown);
      }
      const r = renderRN(<Probe row={makeRow({ preview: 'a' })} />);
      update(r, <Probe row={makeRow({ preview: 'b' })} />);
      vi.advanceTimersByTime(100); // not yet settled
      update(r, <Probe row={makeRow({ preview: 'c' })} />); // re-targets + cancels 'b's timer
      await actAsync(async () => {
        vi.advanceTimersByTime(250);
      });
      // Lands on the LATEST target, never on the superseded 'b'.
      expect((r.toJSON() as { children: string[] }).children[0]).toBe('c');
    } finally {
      vi.useRealTimers();
    }
  });
});

// The RN stub's PanResponder.create() returns the config object itself as
// `panHandlers` (see that stub's comment) — a test can call
// `surface.props.onPanResponderMove(event, gesture)` directly rather than
// simulating real touch negotiation. `translateX` in the surface's own
// `transform` style is the live AnimatedValueImpl, so `.getValue()` reads
// exactly where the row has animated to.
describe('ChatRowItem — swipe-to-reveal tray (spec/15 § Row tools)', () => {
  function surfaceOf(r: ReturnType<typeof renderRN>): ReturnType<typeof findHost> {
    return findHost(r.root, byTestId('chat-row-surface'));
  }
  function translateXOf(r: ReturnType<typeof renderRN>): number {
    const style = surfaceOf(r).props.style as {
      transform: [{ translateX: { getValue(): number } }];
    };
    return style.transform[0].translateX.getValue();
  }

  it('starts closed (translateX 0)', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    expect(translateXOf(r)).toBe(0);
  });

  it('does not claim the gesture for a mostly-vertical drag (leaves scrolling to the FlatList)', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    const claims = surfaceOf(r).props.onMoveShouldSetPanResponder({}, { dx: 5, dy: 40 }) as boolean;
    expect(claims).toBe(false);
  });

  it('claims the gesture for a clearly horizontal drag past the deadzone', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    const claims = surfaceOf(r).props.onMoveShouldSetPanResponder({}, { dx: 30, dy: 2 }) as boolean;
    expect(claims).toBe(true);
  });

  it('dragging right past the open threshold and releasing snaps open (reveals the left tray)', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    actSync(() => {
      surfaceOf(r).props.onPanResponderGrant();
      surfaceOf(r).props.onPanResponderMove({}, { dx: 120, dy: 0 });
      surfaceOf(r).props.onPanResponderRelease({}, { dx: 120, dy: 0 });
    });
    expect(translateXOf(r)).toBe(168); // TRAY_WIDTH = 3 * 56
  });

  it('dragging right but releasing under the threshold springs back closed', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    actSync(() => {
      surfaceOf(r).props.onPanResponderGrant();
      surfaceOf(r).props.onPanResponderMove({}, { dx: 30, dy: 0 });
      surfaceOf(r).props.onPanResponderRelease({}, { dx: 30, dy: 0 });
    });
    expect(translateXOf(r)).toBe(0);
  });

  it('dragging left past the threshold snaps open the other way (reveals the right tray)', () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    actSync(() => {
      surfaceOf(r).props.onPanResponderGrant();
      surfaceOf(r).props.onPanResponderMove({}, { dx: -120, dy: 0 });
      surfaceOf(r).props.onPanResponderRelease({}, { dx: -120, dy: 0 });
    });
    expect(translateXOf(r)).toBe(-168);
  });

  // Both edges carry an identical tray (spec/15 § Row tools — a swipe from
  // either side reveals the same three actions), so a label lookup is scoped
  // to ONE tray to avoid matching its mirror on the other edge.
  function leftTrayOf(r: ReturnType<typeof renderRN>): ReturnType<typeof findHost> {
    return findHost(r.root, byTestId('swipe-tray-left'));
  }

  it('the revealed tray Archive button calls the SAME toggleArchive the row-actions sheet uses, then closes', () => {
    const r = renderRN(<ChatRowItem row={makeRow({ status: 'active' })} />);
    findHost(leftTrayOf(r), (i) => i.props.accessibilityLabel === 'Archive chat').props.onPress();
    expect(toggleArchive).toHaveBeenCalledWith(makeRow({ status: 'active' }));
    expect(translateXOf(r)).toBe(0);
  });

  it('shows "Unarchive chat" on an already-archived row', () => {
    const r = renderRN(<ChatRowItem row={makeRow({ status: 'archived' })} />);
    expect(() =>
      findHost(leftTrayOf(r), (i) => i.props.accessibilityLabel === 'Unarchive chat'),
    ).not.toThrow();
  });

  // The icon itself flips too — an open box for the way back, not the closed
  // Archive glyph used to put a chat away.
  it('renders the open-box PackageOpen icon (not Archive) on an already-archived row', () => {
    const r = renderRN(<ChatRowItem row={makeRow({ status: 'archived' })} />);
    expect(() => findHost(leftTrayOf(r), (i) => i.props.name === 'PackageOpen')).not.toThrow();
  });

  it('the tray Pin button calls the SAME togglePin the row-actions sheet uses', () => {
    const r = renderRN(<ChatRowItem row={makeRow({ pinned: false })} />);
    findHost(leftTrayOf(r), (i) => i.props.accessibilityLabel === 'Pin chat').props.onPress();
    expect(togglePin).toHaveBeenCalledWith(makeRow({ pinned: false }));
  });

  it('the tray Snooze button opens the snooze preset sheet when not snoozed', () => {
    const r = renderRN(<ChatRowItem row={makeRow({ snoozedUntil: null })} />);
    findHost(leftTrayOf(r), (i) => i.props.accessibilityLabel === 'Snooze chat').props.onPress();
    expect(showChatSnoozeSheet).toHaveBeenCalledWith(makeRow({ snoozedUntil: null }));
  });

  it('the tray Snooze button unsnoozes directly (via applySnooze) when already snoozed', () => {
    const row = makeRow({ snoozedUntil: Date.now() + 60_000 });
    const r = renderRN(<ChatRowItem row={row} />);
    findHost(leftTrayOf(r), (i) => i.props.accessibilityLabel === 'Unsnooze chat').props.onPress();
    expect(applySnooze).toHaveBeenCalledWith(row.chatId, null);
  });
});

describe('ChatRowItem — tray order', () => {
  it("reads Pin, Snooze, Archive — the long-press sheet's first three, in order", () => {
    const r = renderRN(<ChatRowItem row={makeRow()} />);
    const labels = findAllHost(
      findHost(r.root, byTestId('swipe-tray-left')),
      (i) =>
        typeof i.props.accessibilityLabel === 'string' && i.props.accessibilityRole === 'button',
    ).map((i) => i.props.accessibilityLabel as string);
    expect(labels).toEqual(['Pin chat', 'Snooze chat', 'Archive chat']);
  });
});

describe('ChatRowItem — snoozed wake time', () => {
  it('shows the wake time compactly in the right-hand slot, with no extra line', () => {
    const at = Date.now() + 60 * 60_000;
    const r = renderRN(<ChatRowItem row={makeRow({ chatId: 'c9', snoozedUntil: at })} />);
    const slot = findHost(r.root, byTestId('wake-time-c9'));
    expect(slot.props.accessibilityLabel).toMatch(/^Snoozed until /);
    const text = findHost(slot, (i) => i.type === 'Text');
    expect(text.children[0]).toBe(formatWakeTimeCompact(at));
    // No second line under the row carrying an inline Unsnooze.
    expect(queryHost(r.root, byTestId('unsnooze-c9'))).toBeNull();
  });

  it('draws no wake time on a row that is not snoozed, or whose snooze has lapsed', () => {
    const r1 = renderRN(<ChatRowItem row={makeRow({ chatId: 'c1', snoozedUntil: null })} />);
    expect(queryHost(r1.root, byTestId('wake-time-c1'))).toBeNull();
    const r2 = renderRN(
      <ChatRowItem row={makeRow({ chatId: 'c2', snoozedUntil: Date.now() - 1000 })} />,
    );
    expect(queryHost(r2.root, byTestId('wake-time-c2'))).toBeNull();
  });
});
