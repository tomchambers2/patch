// ConnectionDiagnostics — the "can't reach the agent" error screen
// (spec/12 § Connection diagnostics screen; spec/15 § Offline / error states).
//
// Blocking only when this phone has NEVER got a link up and two attempts have
// failed: there is no roster and no transcript behind it, so a banner over an
// empty shell would be the bigger lie. Everything else (reconnecting after a
// good connection, or connected-with-daemon-offline) keeps the app navigable
// and opens this as a dismissible overlay from the banners' Diagnose action.
//
// Leading with it is NOT the same as trapping behind it. The blocking variant
// carries the same Close, and closing it latches for the session — a phone
// that has still never connected keeps failing attempts in the background, and
// re-taking the window each time would be an overlay the user cannot leave.
// The banners' Diagnose action is how it comes back.

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { getRoute } from '../config';
import * as Clipboard from 'expo-clipboard';
import {
  runDiagnostics,
  formatReport,
  type DiagnosticsReport,
  type CheckId,
} from '../lib/diagnostics';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { getWs } from '../api/ws';
import { radii, space, textMin, typography, useTheme } from '../lib/theme';

/** Attempts a never-connected surface gets before the screen takes over. */
export const BLOCKING_ATTEMPT_THRESHOLD = 2;

/** Headline named after the FIRST failing check — the most upstream cause. */
const HEADLINES: Record<CheckId, string> = {
  credential: "This phone isn't paired to your patch account",
  server: "Can't reach the patch server",
  agent: "Can't reach the agent",
  websocket: 'The live connection is down',
  protocol: 'This surface is older than the agent',
};

type CopyState = 'idle' | 'copied' | 'failed';

export function ConnectionDiagnostics({
  onDismiss,
}: {
  onDismiss?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [report, setReport] = React.useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = React.useState(true);
  const [copied, setCopied] = React.useState<CopyState>('idle');

  const run = React.useCallback(() => {
    setRunning(true);
    void runDiagnostics().then((r) => {
      setReport(r);
      setRunning(false);
    });
  }, []);

  React.useEffect(run, [run]);

  const retry = (): void => {
    // Don't wait out the backoff — dial now, then re-probe.
    getWs().reconnectNow();
    setCopied('idle');
    run();
  };

  const copy = (): void => {
    /* v8 ignore next -- defensive only: the Copy control is not rendered until a report exists, so this guard's true branch is unreachable through the UI. */
    if (report === null) return;
    void Clipboard.setStringAsync(formatReport(report)).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
  };

  const failed = report?.checks.find((c) => c.status === 'fail');
  const headline =
    report === null
      ? 'Checking the connection…'
      : failed === undefined
        ? 'Everything looks reachable'
        : HEADLINES[failed.id];

  const button = {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.bgSoft,
  };

  return (
    <View
      testID="connection-diagnostics"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.shade,
        justifyContent: 'center',
        padding: space.lg,
        // The overlay reaches the bottom of the window, and Android draws it
        // behind the system navigation bar. The button row is the bottom of
        // the card, so without this the Close sits under the bar and its press
        // never lands. The top inset is claimed once, app-wide, in the root
        // layout's SafeAreaView — only the bottom is owed here.
        paddingBottom: space.lg + insets.bottom,
      }}
    >
      <View
        style={{
          backgroundColor: colors.paperRaised,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.divider,
          padding: space.lg,
          maxHeight: '90%',
        }}
      >
        <Text testID="diagnostics-headline" style={{ ...typography.title, color: colors.ink }}>
          {headline}
        </Text>
        {running ? (
          <Text testID="diagnostics-running" style={{ color: colors.ink3, marginTop: space.sm }}>
            Running diagnostics…
          </Text>
        ) : null}
        {report !== null ? (
          <ScrollView style={{ marginTop: space.md }}>
            {report.checks.map((c) => (
              <View
                key={c.id}
                testID={`check-${c.id}`}
                style={{
                  borderWidth: 1,
                  borderColor: colors.lineSoft,
                  borderRadius: radii.sm,
                  padding: space.sm,
                  marginBottom: space.sm,
                }}
              >
                <Text style={{ color: colors.ink }}>{c.label}</Text>
                <Text
                  testID={`check-${c.id}-status`}
                  style={{
                    color: c.status === 'pass' ? colors.leaf : colors.red,
                    fontSize: textMin,
                  }}
                >
                  {c.status === 'pass' ? 'OK' : 'FAILED'}
                </Text>
                <Text style={{ ...typography.meta, color: colors.ink3 }}>{c.detail}</Text>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}
        >
          <Pressable
            testID="diagnostics-retry"
            accessibilityRole="button"
            disabled={running || getRoute() === null}
            onPress={retry}
            style={{ ...button, backgroundColor: colors.leaf, borderColor: colors.leaf }}
          >
            <Text style={{ color: colors.paper }}>Retry now</Text>
          </Pressable>
          <Pressable
            testID="diagnostics-pair"
            accessibilityRole="button"
            onPress={() => {
              useUiStore.getState().closeDiagnosticsBlocking();
              useUiStore.getState().setDiagnosticsOpen(false);
              onDismiss?.();
              router.push('/pair');
            }}
            style={button}
          >
            <Text style={{ color: colors.ink }}>Pair again</Text>
          </Pressable>
          {report !== null ? (
            <Pressable
              testID="diagnostics-copy"
              accessibilityRole="button"
              onPress={copy}
              style={button}
            >
              <Text style={{ color: colors.ink }}>
                {copied === 'copied'
                  ? 'Copied'
                  : copied === 'failed'
                    ? 'Copy failed'
                    : 'Copy report'}
              </Text>
            </Pressable>
          ) : null}
          {onDismiss ? (
            <Pressable
              testID="diagnostics-dismiss"
              accessibilityRole="button"
              onPress={onDismiss}
              style={button}
            >
              <Text style={{ color: colors.ink }}>Close</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Decides whether the diagnostics screen is showing, and in which mode.
 * Mounted once in the root layout.
 */
export function ConnectionDiagnosticsGate(): React.ReactElement | null {
  const connection = usePresenceStore((s) => s.connection);
  const everConnected = usePresenceStore((s) => s.everConnected);
  const failedAttempts = usePresenceStore((s) => s.failedAttempts);
  const open = useUiStore((s) => s.diagnosticsOpen);
  const setOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const blockingClosed = useUiStore((s) => s.diagnosticsBlockingClosed);
  const closeBlocking = useUiStore((s) => s.closeDiagnosticsBlocking);

  // No offline flash on load: the first `connecting` attempt gets the quiet
  // indicator, never this.
  const blocking =
    connection !== 'connected' &&
    !everConnected &&
    failedAttempts >= BLOCKING_ATTEMPT_THRESHOLD &&
    !blockingClosed;

  if (!blocking && !open) return null;

  const dismiss = (): void => {
    // Closing the takeover latches; closing an overlay the user opened from a
    // banner does not, or one look at diagnostics would disarm the takeover
    // this phone has not earned yet.
    if (blocking) closeBlocking();
    setOpen(false);
  };
  return <ConnectionDiagnostics onDismiss={dismiss} />;
}
