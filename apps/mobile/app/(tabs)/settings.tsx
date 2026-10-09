// Settings tab (design/settings-redesign, phone layout): the title, then the
// pages as a grouped list — Agents, Setup, System — each a full-width row with
// a › that opens the page as its own screen (app/settings/[page].tsx). An
// orange pip on Updates says something is behind.
//
// This screen also keeps the shared `/api/settings` read fresh while the app
// is open (web polls it every 15s; so does this). It stays mounted under the
// pages pushed from it, so they read a current copy too.
//
// The tab bar below this screen already clears the system navigation bar, so
// the list pads only its own spacing at the bottom — the inset is counted once.

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { fonts, radii, space, textMin, useTheme } from '../../src/lib/theme';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { SETTINGS_PAGES, type SettingsGroup } from '../../src/components/settings/pages';
import { GroupLabel } from '../../src/components/settings/ui';
import { useUpdatesBehind } from '../../src/components/settings/VersionSection';

/** How often the shared `/api/settings` read is refreshed — web's interval. */
const SETTINGS_REFRESH_MS = 15_000;

const GROUPS: readonly SettingsGroup[] = ['Agents', 'Setup', 'System'];

export default function SettingsScreen(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const behind = useUpdatesBehind();
  // The server cannot read its stored accounts and keys, so no host is sent settings.
  const problem = useSettingsStore((s) => s.data?.shared?.problem);

  React.useEffect(() => {
    const load = (): void => void useSettingsStore.getState().load();
    load();
    const timer = setInterval(load, SETTINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <ScrollView
      testID="settings-list"
      style={{ flex: 1, backgroundColor: colors.paper }}
      contentContainerStyle={{
        paddingHorizontal: space.md,
        paddingTop: space.lg,
        paddingBottom: space.xl,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          fontFamily: fonts.display,
          fontSize: 26,
          lineHeight: 34,
          color: colors.ink,
          marginHorizontal: space.xs,
          marginBottom: space.sm,
        }}
      >
        Settings
      </Text>
      {problem ? (
        <Text
          testID="settings-secrets-problem"
          accessibilityRole="alert"
          style={{
            fontFamily: fonts.body,
            fontSize: textMin,
            lineHeight: 18,
            color: colors.ink2,
            backgroundColor: colors.waitingTint,
            borderRadius: radii.sm,
            paddingVertical: space.sm,
            paddingHorizontal: space.md,
            marginHorizontal: space.xs,
            marginTop: space.sm,
          }}
        >
          {problem}
        </Text>
      ) : null}
      {GROUPS.map((group) => (
        <View key={group} testID={`settings-group-${group}`} style={{ marginTop: space.md }}>
          <View style={{ marginHorizontal: space.xs, marginBottom: -2 }}>
            <GroupLabel>{group}</GroupLabel>
          </View>
          {SETTINGS_PAGES.filter((p) => p.group === group).map((p) => (
            <Pressable
              key={p.id}
              testID={`settings-row-${p.id}`}
              accessibilityRole="button"
              accessibilityLabel={p.title}
              onPress={() => router.push({ pathname: '/settings/[page]', params: { page: p.id } })}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: space.md + 2,
                paddingHorizontal: space.lg,
                marginTop: -1,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                backgroundColor: pressed ? colors.bgSoft : colors.paperRaised,
              })}
            >
              <Text
                style={{
                  flex: 1,
                  fontFamily: fonts.bodyMedium,
                  fontSize: 15,
                  lineHeight: 21,
                  color: colors.ink2,
                }}
              >
                {p.title}
              </Text>
              {p.id === 'updates' && behind ? (
                <View
                  testID="settings-updates-pip"
                  accessibilityLabel="Something is behind"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: colors.waiting,
                    marginRight: space.md,
                  }}
                />
              ) : null}
              <Text style={{ fontSize: 18, color: colors.inkFaint }}>›</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
