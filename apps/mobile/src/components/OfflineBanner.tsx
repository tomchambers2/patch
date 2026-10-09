// Amber WS banner at the top of the chat list. Shown for `reconnecting` /
// `offline` ONLY — never for the initial `connecting` state (NO offline flash
// on load) and never when connected — and only after the link has been down
// for the disconnect grace with the app in the foreground, so opening an idle
// app does not flash it. Per spec/15 § Offline / error states.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { offlineBannerText } from '../lib/connection';
import { fonts, radii, space, useTheme } from '../lib/theme';

export function OfflineBanner(): React.ReactElement | null {
  const colors = useTheme();
  const conn = usePresenceStore((s) => s.connection);
  const outageVisible = usePresenceStore((s) => s.outageVisible);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const label = offlineBannerText(conn, outageVisible);
  if (label === null) return null;
  return (
    <View
      testID="offline-banner"
      style={{
        backgroundColor: colors.amber,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        margin: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>{label}</Text>
      {/* spec/12 § Connection diagnostics screen: 'Reconnecting…' on its own is
          a dead end — the banner must open the diagnostics screen. */}
      <Pressable
        testID="offline-diagnose"
        accessibilityRole="button"
        accessibilityLabel="Diagnose the connection"
        onPress={() => setDiagnosticsOpen(true)}
      >
        <Text style={{ color: colors.onAccent, textDecorationLine: 'underline' }}>Diagnose</Text>
      </Pressable>
    </View>
  );
}
