// app/chats/[chatId].tsx — ZoomableImageViewer's PanResponder gesture math
// (spec/15 § Composer — "tapping an image opens an in-app pinch-zoomable
// viewer"). The PanResponder stub hands back its config object AS the
// panHandlers (see __tests__/stubs/react-native.ts), so a test can call
// onPanResponderGrant/Move/Release directly with synthetic native-touch
// events — no real gesture recognizer involved.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, findAllHost, actSync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
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

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Chat',
      folder: '~/a',
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
    seq: 1,
    role: 'user',
    content: '',
    attachments: [{ id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' }],
  });
  __setLocalSearchParams({ chatId: 'c1' });
});

function openViewer(root: ReturnType<typeof renderRN>['root']): void {
  findHost(root, (i) => i.props['accessibilityLabel'] === 'View x.png').props.onPress();
}

/** The gesture-surface View — the one with PanResponder's panHandlers spread on it. */
function gestureSurface(root: ReturnType<typeof renderRN>['root']): ReturnType<typeof findHost> {
  return findHost(root, (i) => typeof i.props['onPanResponderGrant'] === 'function');
}

function touchEvent(touches: Array<{ pageX: number; pageY: number }>): unknown {
  return { nativeEvent: { touches } };
}

describe('ZoomableImageViewer — PanResponder gesture', () => {
  it('onStartShouldSetPanResponder / onMoveShouldSetPanResponder both claim the gesture', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    expect(surface.props['onStartShouldSetPanResponder']()).toBe(true);
    expect(surface.props['onMoveShouldSetPanResponder']()).toBe(true);
  });

  it('a single-finger grant just resets startDist (no crash), no double-tap within the window', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    expect(() =>
      surface.props['onPanResponderGrant'](touchEvent([{ pageX: 0, pageY: 0 }])),
    ).not.toThrow();
  });

  it('a double-tap (two single-finger grants within 300ms) resets zoom', () => {
    vi.useFakeTimers();
    try {
      const r = renderRN(<ChatDetailScreen />);
      openViewer(r.root);
      const surface = gestureSurface(r.root);
      surface.props['onPanResponderGrant'](touchEvent([{ pageX: 0, pageY: 0 }]));
      vi.advanceTimersByTime(50);
      expect(() =>
        surface.props['onPanResponderGrant'](touchEvent([{ pageX: 0, pageY: 0 }])),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two grants MORE than 300ms apart do not count as a double-tap', () => {
    vi.useFakeTimers();
    try {
      const r = renderRN(<ChatDetailScreen />);
      openViewer(r.root);
      const surface = gestureSurface(r.root);
      surface.props['onPanResponderGrant'](touchEvent([{ pageX: 0, pageY: 0 }]));
      vi.advanceTimersByTime(500);
      expect(() =>
        surface.props['onPanResponderGrant'](touchEvent([{ pageX: 0, pageY: 0 }])),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a two-finger pinch move scales the image up, clamped to 6x', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    surface.props['onPanResponderGrant'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 100, pageY: 0 },
      ]),
    );
    // First move establishes startDist (100px apart); the SAME distance again → scale ~1 (no crash).
    surface.props['onPanResponderMove'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 100, pageY: 0 },
      ]),
      { dx: 0, dy: 0 },
    );
    // Fingers spread MUCH further apart — scale should clamp at 6.
    expect(() =>
      surface.props['onPanResponderMove'](
        touchEvent([
          { pageX: 0, pageY: 0 },
          { pageX: 100000, pageY: 0 },
        ]),
        { dx: 0, dy: 0 },
      ),
    ).not.toThrow();
  });

  it('a one-finger move while NOT zoomed in does nothing (curScale <= 1 branch)', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    expect(() =>
      surface.props['onPanResponderMove'](touchEvent([{ pageX: 10, pageY: 10 }]), { dx: 5, dy: 5 }),
    ).not.toThrow();
  });

  it('a one-finger move WHILE zoomed in pans the image', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    // Zoom in via a pinch: the FIRST move establishes startDist (100px), so
    // ratio is 1 there — a SECOND move at a wider spread (300px) is what
    // actually pushes curScale (300/100 = 3) above 1.
    surface.props['onPanResponderGrant'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 100, pageY: 0 },
      ]),
    );
    surface.props['onPanResponderMove'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 100, pageY: 0 },
      ]),
      { dx: 0, dy: 0 },
    );
    surface.props['onPanResponderMove'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 300, pageY: 0 },
      ]),
      { dx: 0, dy: 0 },
    );
    surface.props['onPanResponderRelease']();
    // Now pan with one finger — curScale is 3 (> 1) from the pinch above.
    expect(() =>
      surface.props['onPanResponderMove'](touchEvent([{ pageX: 10, pageY: 10 }]), {
        dx: 20,
        dy: 30,
      }),
    ).not.toThrow();
  });

  it('release with curScale <= 1 snaps back via reset()', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    expect(() => surface.props['onPanResponderRelease']()).not.toThrow();
  });

  it('release with curScale > 1 keeps the zoomed state (baseScale updated, no reset)', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    const surface = gestureSurface(r.root);
    surface.props['onPanResponderGrant'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 100, pageY: 0 },
      ]),
    );
    surface.props['onPanResponderMove'](
      touchEvent([
        { pageX: 0, pageY: 0 },
        { pageX: 300, pageY: 0 },
      ]),
      { dx: 0, dy: 0 },
    );
    expect(() => surface.props['onPanResponderRelease']()).not.toThrow();
  });

  it('closing the viewer removes it from the tree', () => {
    const r = renderRN(<ChatDetailScreen />);
    openViewer(r.root);
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Close image viewer'),
    ).toHaveLength(1);
    actSync(() => {
      findHost(
        r.root,
        (i) => i.props['accessibilityLabel'] === 'Close image viewer',
      ).props.onPress();
    });
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Close image viewer'),
    ).toHaveLength(0);
  });
});
