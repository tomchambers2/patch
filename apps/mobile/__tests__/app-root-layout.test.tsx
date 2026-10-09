// Render coverage for the ROOT layout (app/_layout.tsx): bootstraps services,
// resolves Android launcher deep links (spec/15 ## Mobile equivalent of the
// menu bar), deep-links a tapped push notification into its chat (spec/15 §
// Push notifications), and mounts the persistent overlays.
//
// bootstrap()/checkForOtaUpdate() are fire-and-forget background calls (mocked
// so no real network/OTA/WS work happens under test); resolveDeepLink and
// startVoiceNote are mocked so this file pins _layout's OWN wiring of the
// deep-link effect, not resolveDeepLink's own branch logic (deepLink.test.ts's
// job). resolveNotificationAction is left REAL (it's a pure fn already covered
// by notificationLink.test.ts) so the notification-tap effect is exercised
// end-to-end. The three mounted overlays (IncomingCallSheet, VoiceNoteOverlay,
// ChatLongPressSheet) are rendered for REAL at their default
// (inactive) store state — their own internals are covered by their dedicated
// test files; here we only need them to mount without throwing.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  update,
  flush,
  actSync,
  findHost,
  findAllHost,
  byType,
} from './testUtils/render';
import { Text as RNText } from 'react-native';
import { routerMock, __resetRouterMock, __setRootNavigationReady } from './stubs/expo-router';
import { __setColorScheme } from './stubs/react-native';
import { __setLastNotificationResponse } from './stubs/expo-notifications';
import { __setFontsLoaded, __setFontsError } from './stubs/google-fonts';
import { fonts } from '../src/lib/theme';
import { useUiStore } from '../src/stores/uiStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useShareStore } from '../src/stores/shareStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useBatchStore } from '../src/stores/batchStore';
import { byTestId, queryHost } from './testUtils/render';
import {
  __setInitialURL,
  __emitUrl,
  __getOpenedUrls,
  __resetOpenedUrls,
} from './stubs/expo-linking';

const {
  bootstrapSpy,
  checkForOtaUpdateSpy,
  startOtaUpdatePollingSpy,
  stopOtaUpdatePollingSpy,
  resolveDeepLinkSpy,
  startVoiceNoteSpy,
  initShareIntentSpy,
} = vi.hoisted(() => {
  const stopOtaUpdatePollingSpy = vi.fn();
  return {
    bootstrapSpy: vi.fn(async () => undefined),
    checkForOtaUpdateSpy: vi.fn(async () => undefined),
    startOtaUpdatePollingSpy: vi.fn(() => stopOtaUpdatePollingSpy),
    stopOtaUpdatePollingSpy,
    resolveDeepLinkSpy: vi.fn((_url: string | null) => null as unknown),
    startVoiceNoteSpy: vi.fn(),
    initShareIntentSpy: vi.fn(),
  };
});
vi.mock('../src/lib/bootstrap', () => ({ bootstrap: bootstrapSpy }));
vi.mock('../src/lib/otaUpdates', () => ({
  checkForOtaUpdate: checkForOtaUpdateSpy,
  startOtaUpdatePolling: startOtaUpdatePollingSpy,
}));
vi.mock('../src/lib/deepLink', () => ({ resolveDeepLink: resolveDeepLinkSpy }));
vi.mock('../src/lib/voiceNote', () => ({ startVoiceNote: startVoiceNoteSpy }));
// The real module is exercised by nativeShare.test.ts; here we only need
// _layout's OWN wiring of "a pending share routes to /share" (below), which
// is driven directly through shareStore rather than the native bridge.
vi.mock('../src/lib/nativeShare', () => ({ initShareIntent: initShareIntentSpy }));

import RootLayout, { PENDING_NAVIGATION_TIMEOUT_MS } from '../app/_layout';

beforeEach(() => {
  __resetRouterMock();
  __setColorScheme('light');
  __setLastNotificationResponse(null);
  __setInitialURL(null);
  __resetOpenedUrls();
  __setFontsLoaded(true);
  __setFontsError(null);
  __setRootNavigationReady(true);
  useUiStore.setState({ errors: [], diagnosticsOpen: false, diagnosticsBlockingClosed: false });
  usePresenceStore.setState({ connection: 'connecting', everConnected: false, failedAttempts: 0 });
  bootstrapSpy.mockClear();
  checkForOtaUpdateSpy.mockClear();
  startOtaUpdatePollingSpy.mockClear();
  stopOtaUpdatePollingSpy.mockClear();
  resolveDeepLinkSpy.mockClear();
  resolveDeepLinkSpy.mockReturnValue(null);
  startVoiceNoteSpy.mockClear();
  initShareIntentSpy.mockClear();
  useShareStore.getState().clear();
  useBatchStore.getState()._reset();
});

describe('RootLayout — bootstrap', () => {
  it('kicks off checkForOtaUpdate + bootstrap on mount (fire-and-forget)', () => {
    renderRN(<RootLayout />);
    expect(checkForOtaUpdateSpy).toHaveBeenCalledTimes(1);
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });

  // A launch-only check leaves a long-lived app on old JS indefinitely, so the
  // polling must actually start — and must be torn down, or every remount leaks
  // another interval and AppState listener.
  it('starts OTA polling on mount and stops it on unmount', () => {
    const r = renderRN(<RootLayout />);
    expect(startOtaUpdatePollingSpy).toHaveBeenCalledTimes(1);
    expect(stopOtaUpdatePollingSpy).not.toHaveBeenCalled();
    // Unmount inside act() so React flushes the effect cleanups.
    actSync(() => r.unmount());
    expect(stopOtaUpdatePollingSpy).toHaveBeenCalledTimes(1);
  });
});

describe('RootLayout — structure', () => {
  it('mounts the SafeAreaView, StatusBar, Stack, and every persistent overlay', () => {
    const r = renderRN(<RootLayout />);
    expect(findHost(r.root, byType('SafeAreaProvider'))).toBeTruthy();
    expect(findHost(r.root, byType('SafeAreaView'))).toBeTruthy();
    expect(findHost(r.root, byType('StatusBar'))).toBeTruthy();
    expect(findHost(r.root, byType('Stack'))).toBeTruthy();
    // The IncomingCallSheet/VoiceNoteOverlay/ChatLongPressSheet
    // are all mounted at default (inactive) store state, so they render null —
    // this just confirms RootLayout renders without throwing with all three
    // wired in (their own behaviour is covered by their dedicated test files).
    expect(r.toJSON()).not.toBeNull();
  });

  it('the new-chat Stack.Screen has animation "none" (no slide-up, no dim — spec/15 New chat flow)', () => {
    const r = renderRN(<RootLayout />);
    const screens = findAllHost(r.root, byType('Stack.Screen'));
    const newChat = screens.find((s) => s.props.name === 'new-chat')!;
    expect(newChat.props.options.animation).toBe('none');
  });

  it('StatusBar uses light glyphs in dark mode and dark glyphs in light mode (spec/15 Dark mode)', () => {
    __setColorScheme('dark');
    const r = renderRN(<RootLayout />);
    expect(findHost(r.root, byType('StatusBar')).props.style).toBe('light');

    __setColorScheme('light');
    const r2 = renderRN(<RootLayout />);
    expect(findHost(r2.root, byType('StatusBar')).props.style).toBe('dark');
  });
});

// Fonts are remote Google fonts. Blocking first paint on them is what made a
// cold start on poor signal look like a broken, slow-loading app — seconds of
// blank screen with the whole tree already ready behind it. The app must paint
// on the platform default face and swap the real faces in when they land
// (spec/15 § Display font).
describe('RootLayout — fonts never block first paint', () => {
  /** The style the layout has installed as every <Text>'s default. */
  function textDefaultStyle(): { fontFamily?: string; color?: string } | undefined {
    return (
      RNText as unknown as { defaultProps?: { style?: { fontFamily?: string; color?: string } } }
    ).defaultProps?.style;
  }

  it('renders the whole shell while fonts are still loading', () => {
    // The vitest alias map points ALL THREE @expo-google-fonts/* packages at
    // one shared stub, so this single flag holds every font unloaded.
    __setFontsLoaded(false);
    const r = renderRN(<RootLayout />);
    expect(r.toJSON()).not.toBeNull();
    // The navigator in particular has to exist, or expo-router throws on any
    // launch-time navigation.
    expect(findHost(r.root, byType('Stack'))).toBeTruthy();
    expect(findHost(r.root, byType('SafeAreaView'))).toBeTruthy();
  });

  it('paints on the platform default face until the fonts register, then swaps them in', () => {
    __setFontsLoaded(false);
    const r = renderRN(<RootLayout />);
    // No fontFamily named while unloaded — Android resolves an unregistered
    // family to nothing useful. Colour still applies.
    expect(textDefaultStyle()?.fontFamily).toBeUndefined();
    expect(textDefaultStyle()?.color).toBeTruthy();

    __setFontsLoaded(true);
    update(r, <RootLayout />);
    expect(textDefaultStyle()?.fontFamily).toBe(fonts.body);
  });

  // NO SILENT FALLBACK: running on the default face is fine as a transient, but
  // a font set that genuinely failed must say so rather than leave the app
  // quietly wrong forever.
  it('raises a visible error when the font set fails to load', () => {
    __setFontsError(new Error('network unreachable'));
    renderRN(<RootLayout />);
    const messages = useUiStore.getState().errors.map((e) => e.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('network unreachable');
  });

  it('reports a font failure once, not on every re-render', () => {
    __setFontsError(new Error('boom'));
    const r = renderRN(<RootLayout />);
    update(r, <RootLayout />);
    expect(useUiStore.getState().errors).toHaveLength(1);
  });

  it('says nothing when the fonts load cleanly', () => {
    renderRN(<RootLayout />);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });
});

// THE regression this file exists to guard. A push tapped while the app is
// KILLED delivers its response before the NavigationContainer has marked itself
// ready, so expo-router throws from router.* rather than queueing. Navigating
// eagerly therefore lost Tom's destination and dropped him on the default
// screen; the warm path always worked, which is why it went unnoticed.
describe('RootLayout — cold start (no navigator yet)', () => {
  function notificationResponse(id: string, data: Record<string, unknown>): unknown {
    return { notification: { request: { identifier: id, content: { data } } } };
  }

  /** Fonts finish loading and the root navigator mounts. */
  function navigatorMounts(r: ReturnType<typeof renderRN>): void {
    __setFontsLoaded(true);
    __setRootNavigationReady(true);
    update(r, <RootLayout />);
  }

  it('a notification tapped before the navigator exists still opens that chat once it does', () => {
    __setFontsLoaded(false);
    __setRootNavigationReady(false);
    __setLastNotificationResponse(notificationResponse('cold-1', { chatId: 'c-cold' }));

    // Must not throw, and must not have navigated yet — the navigator has not
    // marked itself ready, so router.* would throw. The shell itself DOES
    // paint; it is only the navigation that waits.
    const r = renderRN(<RootLayout />);
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(r.toJSON()).not.toBeNull();

    navigatorMounts(r);
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c-cold');
  });

  it('does not re-fire the held navigation on later re-renders', () => {
    __setFontsLoaded(false);
    __setRootNavigationReady(false);
    __setLastNotificationResponse(notificationResponse('cold-2', { chatId: 'c2' }));
    const r = renderRN(<RootLayout />);
    navigatorMounts(r);
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    update(r, <RootLayout />);
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
  });

  it('a cold-start patch:// chat link is held and delivered the same way', async () => {
    __setFontsLoaded(false);
    __setRootNavigationReady(false);
    __setInitialURL('patch://chats/c-link');
    resolveDeepLinkSpy.mockReturnValue({ kind: 'navigate', route: '/chats/c-link' });

    const r = renderRN(<RootLayout />);
    await flush();
    expect(routerMock.navigate).not.toHaveBeenCalled();

    navigatorMounts(r);
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c-link');
  });

  it('a destination resolved AFTER the navigator is ready goes straight out, once', async () => {
    __setInitialURL('patch://new-chat');
    resolveDeepLinkSpy.mockReturnValue({ kind: 'navigate', route: '/new-chat' });
    const r = renderRN(<RootLayout />);
    await flush();
    expect(routerMock.navigate).toHaveBeenCalledWith('/new-chat');
    // Nothing was held, so a later re-render must not replay it.
    const delivered = routerMock.navigate.mock.calls.length;
    update(r, <RootLayout />);
    expect(routerMock.navigate.mock.calls.length).toBe(delivered);
  });

  it('holds every destination when more than one arrives before the navigator', async () => {
    __setFontsLoaded(false);
    __setRootNavigationReady(false);
    __setInitialURL('patch://chats/c-link');
    resolveDeepLinkSpy.mockReturnValue({ kind: 'navigate', route: '/chats/c-link' });
    __setLastNotificationResponse(notificationResponse('cold-3', { chatId: 'c-push' }));

    const r = renderRN(<RootLayout />);
    await flush();
    expect(routerMock.navigate).not.toHaveBeenCalled();

    navigatorMounts(r);
    // Both survive — a second destination must not evict the first.
    expect(routerMock.navigate.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/chats/c-link',
      '/chats/c-push',
    ]);
  });

  // NO FALLBACK: if the navigator never arrives the destination is genuinely
  // lost, and the user must be told which chat failed to open — not silently
  // left on whatever screen the app happened to show.
  it('surfaces a visible error when the navigator never becomes ready', () => {
    vi.useFakeTimers();
    try {
      __setFontsLoaded(false);
      __setRootNavigationReady(false);
      __setLastNotificationResponse(notificationResponse('cold-4', { chatId: 'c-lost' }));
      renderRN(<RootLayout />);
      expect(useUiStore.getState().errors).toHaveLength(0);

      actSync(() => {
        vi.advanceTimersByTime(PENDING_NAVIGATION_TIMEOUT_MS);
      });
      const messages = useUiStore.getState().errors.map((e) => e.message);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('/chats/c-lost');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave the timeout running after unmount', () => {
    vi.useFakeTimers();
    try {
      __setFontsLoaded(false);
      __setRootNavigationReady(false);
      __setLastNotificationResponse(notificationResponse('cold-5', { chatId: 'c-gone' }));
      const r = renderRN(<RootLayout />);
      actSync(() => r.unmount());
      actSync(() => {
        vi.advanceTimersByTime(PENDING_NAVIGATION_TIMEOUT_MS * 2);
      });
      expect(useUiStore.getState().errors).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the timeout once the navigator arrives', () => {
    vi.useFakeTimers();
    try {
      __setFontsLoaded(false);
      __setRootNavigationReady(false);
      __setLastNotificationResponse(notificationResponse('cold-6', { chatId: 'c-ok' }));
      const r = renderRN(<RootLayout />);
      navigatorMounts(r);
      actSync(() => {
        vi.advanceTimersByTime(PENDING_NAVIGATION_TIMEOUT_MS * 2);
      });
      expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c-ok');
      expect(useUiStore.getState().errors).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RootLayout — deep links (spec/15 ## Mobile equivalent of the menu bar)', () => {
  it('a cold-start voice-note deep link starts the note on the resolved chat', async () => {
    __setInitialURL('patch://voice-note?chat=c9');
    resolveDeepLinkSpy.mockReturnValue({ kind: 'voice-note', chatId: 'c9' });
    renderRN(<RootLayout />);
    await flush();
    expect(resolveDeepLinkSpy).toHaveBeenCalledWith('patch://voice-note?chat=c9');
    expect(startVoiceNoteSpy).toHaveBeenCalledWith('c9');
  });

  it('a foregrounded url event with a navigate action pushes the route', async () => {
    resolveDeepLinkSpy.mockReturnValue({ kind: 'navigate', route: '/new-chat' });
    renderRN(<RootLayout />);
    await flush();
    __emitUrl('patch://new-chat');
    expect(routerMock.navigate).toHaveBeenCalledWith('/new-chat');
  });

  it('a null action (no match) does nothing', async () => {
    resolveDeepLinkSpy.mockReturnValue(null);
    renderRN(<RootLayout />);
    await flush();
    __emitUrl('patch://unknown');
    expect(startVoiceNoteSpy).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('removes the url listener on unmount', async () => {
    const r = renderRN(<RootLayout />);
    await flush();
    r.unmount();
    // Emitting after unmount must not throw and must not reach a since-removed
    // handler (the listener Set no longer contains it).
    expect(() => __emitUrl('patch://new-chat')).not.toThrow();
  });
});

describe('RootLayout — share sheet routing (spec/15 ## Mobile equivalent of the menu bar)', () => {
  it('calls initShareIntent on mount, alongside the other bootstrap calls', () => {
    renderRN(<RootLayout />);
    expect(initShareIntentSpy).toHaveBeenCalledTimes(1);
  });

  it('routes to /share once shareStore has a pending share', async () => {
    renderRN(<RootLayout />);
    await flush();
    expect(routerMock.navigate).not.toHaveBeenCalledWith('/share');
    useShareStore.getState().setPending({ text: 'https://example.com', files: [] });
    await flush();
    expect(routerMock.navigate).toHaveBeenCalledWith('/share');
  });

  it('a pending share already set before mount is picked up immediately', async () => {
    useShareStore.getState().setPending({ text: 'https://example.com/already-there', files: [] });
    renderRN(<RootLayout />);
    await flush();
    expect(routerMock.navigate).toHaveBeenCalledWith('/share');
  });
});

describe('RootLayout — notification tap deep-link (spec/15 § Push notifications)', () => {
  function notificationResponse(
    id: string,
    data: Record<string, unknown>,
    text: { title?: string; body?: string } = {},
  ): unknown {
    return { notification: { request: { identifier: id, content: { data, ...text } } } };
  }

  it('does nothing when there is no last notification response', () => {
    renderRN(<RootLayout />);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('navigates to the source chat on a tapped message notification', () => {
    __setLastNotificationResponse(notificationResponse('n1', { chatId: 'c1' }));
    renderRN(<RootLayout />);
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c1');
  });

  it('falls back to {} when content.data is absent, and does not navigate', () => {
    __setLastNotificationResponse({
      notification: { request: { identifier: 'n-no-data', content: {} } },
    });
    renderRN(<RootLayout />);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate for a call-kind notification (handled by ConnectionService instead)', () => {
    __setLastNotificationResponse(notificationResponse('n-call', { kind: 'call' }));
    renderRN(<RootLayout />);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('does not re-navigate for the same response id on a re-render (dedup)', () => {
    __setLastNotificationResponse(notificationResponse('n2', { chatId: 'c2' }));
    const r = renderRN(<RootLayout />);
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    // A fresh response object carrying the SAME identifier (e.g. the hook
    // re-firing on an unrelated re-render) must be treated as already handled.
    __setLastNotificationResponse(notificationResponse('n2', { chatId: 'c2' }));
    update(r, <RootLayout />);
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
  });

  it('opens the deepLink via the OS instead of navigating, when the notification names it (spec/09 § push)', () => {
    __setLastNotificationResponse(
      notificationResponse(
        'n-deeplink',
        {
          chatId: 'c3',
          deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
        },
        { title: 'Patch', body: 'Leave in 6 minutes — the route is in Citymapper.' },
      ),
    );
    renderRN(<RootLayout />);
    expect(__getOpenedUrls()).toEqual([
      'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
    ]);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // The whole point of the gate: a link the notification's text never mentions
  // is NOT handed to the OS. The tap lands in the chat the push came from.
  it('opens the source chat, not the deepLink, when the notification text does not name it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setLastNotificationResponse(
      notificationResponse(
        'n-deeplink-mismatch',
        { chatId: 'c4', deepLink: 'https://todoist.com/showTask?id=99' },
        { title: 'Patch', body: 'The garden watering finished early.' },
      ),
    );
    renderRN(<RootLayout />);
    expect(__getOpenedUrls()).toEqual([]);
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c4');
    // Refused, never swallowed: the decision is on the log with the link and
    // the reason.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('link-not-named-in-notification-text'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('https://todoist.com/showTask?id=99'),
    );
    warn.mockRestore();
  });

  it('tapping a batch notification switches to batch mode and lands on the Chats tab (spec/15 § Batch view)', () => {
    __setLastNotificationResponse(notificationResponse('n-batch', { kind: 'batch' }));
    renderRN(<RootLayout />);
    expect(useBatchStore.getState().mode).toBe('batch');
    expect(routerMock.navigate).toHaveBeenCalledWith('/(tabs)/chats');
  });
});

// The diagnostics takeover draws over the WHOLE app from the root layout, so
// its escape hatch is only real if it survives the real tree — ErrorToasts and
// the other overlays mount after it. Exercised here at the actual mount point
// rather than on the gate in isolation.
describe('RootLayout — connection diagnostics takeover', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response,
      ),
    );
  });

  it('a never-connected phone can close the takeover and get the app back', async () => {
    actSync(() => {
      usePresenceStore.setState({
        connection: 'offline',
        everConnected: false,
        failedAttempts: 2,
      });
    });
    const r = renderRN(<RootLayout />);
    await flush();
    expect(queryHost(r.root, byTestId('connection-diagnostics'))).not.toBeNull();
    findHost(r.root, byTestId('diagnostics-dismiss')).props.onPress();
    await flush();
    expect(queryHost(r.root, byTestId('connection-diagnostics'))).toBeNull();
    // And the Stack (the app itself) is still mounted behind where it was.
    expect(findAllHost(r.root, byType('Stack')).length).toBe(1);
    vi.unstubAllGlobals();
  });
});

// spec/15 § Manager incoming-call UX — the call lives inside its chat, so an
// ANSWERED incoming call opens that chat (both answer paths start the call and
// then clear `incomingCall`). A decline clears it with no call: no navigation.
describe('RootLayout — an answered incoming call opens its chat', () => {
  const incoming = {
    callId: 'call-1',
    chatId: 'thread_manager',
    message: undefined,
    receivedAt: 0,
  };

  it('navigates to the call’s chat when the incoming call is answered', () => {
    renderRN(<RootLayout />);
    actSync(() => useVoiceStore.setState({ incomingCall: incoming, activeSession: null }));
    routerMock.navigate.mockClear();
    actSync(() =>
      useVoiceStore.setState({
        activeSession: { sessionId: '', chatId: 'thread_manager', audioUrl: '', startedAt: 0 },
        incomingCall: null,
      }),
    );
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/thread_manager');
    actSync(() => useVoiceStore.setState({ activeSession: null }));
  });

  it('does not navigate on a decline (no call started)', () => {
    renderRN(<RootLayout />);
    actSync(() => useVoiceStore.setState({ incomingCall: incoming, activeSession: null }));
    routerMock.navigate.mockClear();
    actSync(() => useVoiceStore.setState({ incomingCall: null }));
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('ignores store changes that are not an answer', () => {
    renderRN(<RootLayout />);
    routerMock.navigate.mockClear();
    actSync(() => useVoiceStore.setState({ callMuted: true }));
    actSync(() => useVoiceStore.setState({ incomingCall: incoming }));
    actSync(() => useVoiceStore.setState({ callMuted: false }));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    actSync(() => useVoiceStore.setState({ incomingCall: null }));
  });
});
