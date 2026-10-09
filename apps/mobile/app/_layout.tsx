// Root layout: bootstraps services, mounts persistent overlays.

import React from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import { Text, useColorScheme } from 'react-native';
import {
  useFonts as useFraunces,
  Fraunces_400Regular_Italic,
  Fraunces_500Medium,
  Fraunces_500Medium_Italic,
} from '@expo-google-fonts/fraunces';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono';
import { installRelayTransport } from '../src/lib/relayTransport';
import { bootstrap } from '../src/lib/bootstrap';
import { checkForOtaUpdate, startOtaUpdatePolling } from '../src/lib/otaUpdates';
import { resolveNotificationAction } from '../src/lib/notificationLink';
import { resolveDeepLink } from '../src/lib/deepLink';
import { initShareIntent } from '../src/lib/nativeShare';
import { useShareStore } from '../src/stores/shareStore';
import { startVoiceNote } from '../src/lib/voiceNote';
import { useBatchWatcher } from '../src/lib/batchNotifier';
import { VoiceNoteOverlay } from '../src/components/VoiceNoteOverlay';
import { IncomingCallSheet } from '../src/components/IncomingCallSheet';
import { ChatLongPressSheet } from '../src/components/ChatLongPressSheet';
import { ConnectionDiagnosticsGate } from '../src/components/ConnectionDiagnostics';
import { SignedOutRedirect } from '../src/components/SignedOutRedirect';
import { ErrorToasts } from '../src/components/ErrorToasts';
import { fonts, useTheme } from '../src/lib/theme';
import { useUiStore } from '../src/stores/uiStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useBatchStore } from '../src/stores/batchStore';

// Before anything makes a request: a device paired through a relay reaches its
// server by a placeholder address this teaches `fetch` and `WebSocket` to carry.
installRelayTransport();

/** Every in-app destination this layout can be asked to open. */
type NavTarget = `/chats/${string}` | '/new-chat' | '/share' | '/(tabs)/chats';

/**
 * How long a held navigation waits for the root navigator. Fonts load and the
 * navigator mounts far inside this on a cold start; blowing through it means
 * the app never finished starting, and the destination is genuinely lost.
 */
export const PENDING_NAVIGATION_TIMEOUT_MS = 10_000;

export default function RootLayout(): React.ReactElement | null {
  const router = useRouter();
  const colors = useTheme();
  const scheme = useColorScheme();
  // Fonts are NOT blocked on (spec/15 § Display font). They are remote Google
  // fonts, so on a cold start with poor signal `fontsLoaded` stays false for
  // seconds — and returning null for that whole window is exactly what made the
  // app "slow loading": a blank screen with the work already done behind it.
  // The tree paints from the first frame on the platform default face and the
  // custom faces apply below as soon as they register.
  const [fontsLoaded, fontError] = useFraunces({
    Fraunces_400Regular_Italic,
    Fraunces_500Medium,
    Fraunces_500Medium_Italic,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_400Regular,
  });

  // NO SILENT FALLBACK: painting on the default face is a deliberate,
  // temporary state, but a font set that genuinely FAILED is an error and has
  // to say so — otherwise the app just looks subtly wrong forever with nothing
  // anywhere reporting why.
  React.useEffect(() => {
    if (!fontError) return;
    useUiStore.getState().pushError(`fonts failed to load: ${fontError.message}`);
  }, [fontError]);

  React.useEffect(() => {
    // Fetch any OTA JS update in the background (no-op in dev / Expo Go). It is
    // only DOWNLOADED — it launches at the next cold start, so startup is never
    // interrupted by a reload (spec/11 § Mobile OTA "NO automatic reload").
    void checkForOtaUpdate();
    void bootstrap();
    // Android share-sheet entry point (spec/15 ## Mobile equivalent of the
    // menu bar): reads a share that launched the app and subscribes to ones
    // that arrive while it's already running (src/lib/nativeShare.ts).
    initShareIntent();
    // Keep checking while the app stays open — a launch-only check leaves a
    // long-lived app on old JS indefinitely.
    return startOtaUpdatePolling();
  }, []);

  // Navigation readiness (spec/15 § Push notifications — a tap that arrives
  // before the app can navigate is held, never dropped).
  //
  // The <Stack> below renders on the very first commit, but the navigator is
  // only MARKED ready by the NavigationContainer's own effect, which runs after
  // this component's effects in that same commit — and until then expo-router
  // THROWS ("Attempted to navigate before mounting the Root Layout component")
  // rather than queueing. Both a tapped push and a patch:// launch URL can
  // resolve inside that window, which is why a notification tapped from a
  // killed app used to land on the default screen instead of its chat while a
  // warm tap worked fine.
  //
  // The test is on `.key`, not truthiness: `store.initialize()` pre-seeds
  // `rootState` from the launch URL before anything mounts, and that partial
  // state carries no key. Font loading is deliberately NOT part of this — the
  // navigator exists whether or not the fonts have arrived, and gating on them
  // would hold a tapped notification behind a font download.
  //
  // So nothing here navigates directly: destinations go through
  // `navigateWhenReady`, which hands over immediately if the navigator is up
  // and otherwise holds them until it is.
  const rootNavState = useRootNavigationState();
  const navReady = rootNavState?.key !== undefined;
  const navReadyRef = React.useRef(false);
  const heldRoutes = React.useRef<NavTarget[]>([]);
  const heldTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const navigateWhenReady = React.useCallback(
    (route: NavTarget): void => {
      if (navReadyRef.current) {
        // `navigate`, not `push`: tapping a notification for the chat already
        // on screen must land on it, not stack a second copy to back out of.
        router.navigate(route);
        return;
      }
      heldRoutes.current.push(route);
      if (heldTimer.current !== null) return;
      heldTimer.current = setTimeout(() => {
        heldTimer.current = null;
        // NO FALLBACK: the destination is lost, so say which one rather than
        // leaving the user on whatever screen the app happened to open.
        for (const lost of heldRoutes.current.splice(0)) {
          useUiStore
            .getState()
            .pushError(`Could not open ${lost} — the app never finished starting up.`);
        }
      }, PENDING_NAVIGATION_TIMEOUT_MS);
    },
    [router],
  );

  // Android launcher long-press shortcuts + patch:// deep links
  // (spec/15 ## Mobile equivalent of the menu bar). A `?credential=` link is
  // consumed by bootstrap; here we route voice-note / new-chat / chats links.
  React.useEffect(() => {
    const act = (url: string | null): void => {
      const action = resolveDeepLink(url);
      if (!action) return;
      if (action.kind === 'voice-note') {
        startVoiceNote(action.chatId);
      } else if (action.kind === 'navigate') {
        navigateWhenReady(action.route as NavTarget);
      }
    };
    void Linking.getInitialURL().then(act);
    const sub = Linking.addEventListener('url', (e) => act(e.url));
    return () => sub.remove();
  }, [navigateWhenReady]);

  // A share landing in shareStore (cold-start or already-running — see
  // src/lib/nativeShare.ts) routes to the destination picker. Keyed on the
  // pending TEXT itself, not just truthiness, so a second share while the
  // first is still being acted on is not dropped for looking unchanged.
  const pendingShare = useShareStore((s) => s.pending);
  React.useEffect(() => {
    if (pendingShare !== null) navigateWhenReady('/share');
  }, [pendingShare, navigateWhenReady]);

  // Notification-tap deep-link (spec/09 § `### push`, spec/15 § Push
  // notifications). useLastNotificationResponse fires for both a cold-start tap
  // (app killed) and a warm tap, and returns the last response so we navigate
  // to the source chat — or, when the push carried a `deepLink` that the
  // notification's own text names, hand off to the OS to open that external URI
  // instead. A link the text does not name is refused and logged rather than
  // followed; the tap opens the chat. A `kind: 'call'` payload is handled by the
  // push listener / Connection service, not here, so we only act on message
  // notifications.
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledResponseRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!lastResponse) return;
    const id = lastResponse.notification.request.identifier;
    if (handledResponseRef.current === id) return;
    // Safe to mark handled up front only because `navigateWhenReady` cannot
    // drop a destination — it either navigates or holds. Marking it handled
    // ahead of a navigation that could FAIL is what stopped the cold-start tap
    // ever being retried once the navigator did arrive.
    handledResponseRef.current = id;
    const content = lastResponse.notification.request.content;
    const data = content.data ?? {};
    const { action, rejectedDeepLink } = resolveNotificationAction(data, {
      title: content.title,
      body: content.body,
    });
    if (rejectedDeepLink) {
      console.warn(
        `[patch-push] deepLink refused (${rejectedDeepLink.reason}): ${rejectedDeepLink.url} — looked for [${rejectedDeepLink.words.join(', ')}] in "${content.title ?? ''} ${content.body ?? ''}"`,
      );
    }
    if (!action) return;
    if (action.type === 'external') {
      void Linking.openURL(action.url);
    } else if (action.type === 'batch') {
      // Batch notification (spec/15 § Batch view) — land on the Batch tab,
      // not a chat; setting the mode is what BatchView reads to draw itself.
      useBatchStore.getState().setMode('batch');
      navigateWhenReady('/(tabs)/chats');
    } else {
      navigateWhenReady(action.route as `/chats/${string}`);
    }
  }, [lastResponse, navigateWhenReady]);

  // Polls the server-held batch (spec/15 § Batch view) for the app's whole
  // lifetime, not just while the Chats tab is mounted — the count on the view
  // dropdown has to stay live wherever the user is in the app. The check-in
  // notification itself is a real push, handled above like any other.
  useBatchWatcher();

  // An answered incoming call opens its chat (spec/15 § Manager incoming-call
  // UX): the call lives inside the chat — its stream is the transcript and its
  // control bar docks there — so answering must land the user on it. Both
  // answer paths (the in-app sheet and the native ConnectionService UI) start
  // the call and then clear `incomingCall`; a decline clears it with no call.
  React.useEffect(
    () =>
      useVoiceStore.subscribe((state, prev) => {
        const answered = prev.incomingCall;
        if (answered === null || state.incomingCall !== null) return;
        if (state.activeSession?.chatId !== answered.chatId) return;
        navigateWhenReady(`/chats/${answered.chatId}`);
      }),
    [navigateWhenReady],
  );

  // Declared AFTER both producers above so that on the very first commit —
  // where `navReadyRef` is still false even on a warm start — anything they
  // hand over is released in that same commit rather than a frame later.
  React.useEffect(() => {
    navReadyRef.current = navReady;
    if (!navReady) return;
    if (heldTimer.current !== null) {
      clearTimeout(heldTimer.current);
      heldTimer.current = null;
    }
    for (const route of heldRoutes.current.splice(0)) router.navigate(route);
  }, [navReady, router]);

  // A held destination outlives the effect above (it is keyed on readiness, not
  // on unmount), so its timer needs clearing separately or it fires into a torn
  // down tree.
  React.useEffect(
    () => () => {
      if (heldTimer.current !== null) clearTimeout(heldTimer.current);
    },
    [],
  );

  // Apply Inter as the default body font for any <Text> without an explicit
  // fontFamily, by mutating the Text defaultProps. Only once the files are
  // actually registered: naming a family Android has not loaded yet resolves to
  // nothing useful, so until then we set the ink colour alone and the platform
  // default face carries the first frames.
  type TextWithDefaults = typeof Text & {
    defaultProps?: { style?: { fontFamily?: string; color?: string } };
  };
  const T = Text as TextWithDefaults;
  T.defaultProps = T.defaultProps ?? {};
  T.defaultProps.style = fontsLoaded
    ? { fontFamily: fonts.body, color: colors.ink }
    : { color: colors.ink };

  return (
    <SafeAreaProvider>
      {/* Top-edge safe-area inset applied ONCE, app-wide (spec/15 § Safe area):
          the app draws its own header with headerShown off, so without this the
          wordmark/title/back-bar collide with the status bar on every screen.
          Screens keep their normal space.* gap on top of this inset. The bottom
          tab bar handles its own bottom inset, so only 'top' is claimed here. */}
      <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.paper }}>
        {/* System bars adapt to the scheme: light glyphs on the dark paper,
            dark glyphs on the light paper (spec/15 § Dark mode). */}
        {/* Background matches the theme dynamically (spec/15 § Dark mode —
            "status bar adapts with the scheme"). app.config.ts's
            `androidStatusBar` only covers the native splash window before
            this component mounts; without this prop that native color (a
            fixed light-mode value) would stay wrong for the rest of a
            dark-mode session instead of just the first frame. */}
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} backgroundColor={colors.paper} />
        <Stack screenOptions={{ headerShown: false }}>
          {/* New-chat is an INLINE flow — no slide-up-from-the-bottom animation
              and no dimmed/black overlay. It appears instantly, matching the
              web new-chat's "rendered immediately, no flash" feel (spec/15
              ## New chat flow). */}
          <Stack.Screen name="new-chat" options={{ animation: 'none' }} />
        </Stack>
        <IncomingCallSheet />
        <VoiceNoteOverlay />
        <ChatLongPressSheet />
        <ConnectionDiagnosticsGate />
        {/* A credential the server REFUSED is terminal, not a link that might
            come back — leave for pairing rather than sit in a shell that can
            never load anything (spec/10 § Surface). */}
        <SignedOutRedirect />
        {/* Queued errors from every failing path (uploads, REST, WS). Without
            this the app pushes errors nowhere and a failure reads as a dead
            control (NO SILENT FAILURE). Mounted last so it draws on top. */}
        <ErrorToasts />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
