// Where a host Files browser or terminal starts (spec/15 § Host files and
// terminal): the host user's Home, then the host's published project folders
// (spec/04 § Folders) — the recent-projects quick-pick. Two shapes of the same
// list: a full-width list for the terminal's "Start in" step, and a strip of
// chips across the top of the Files browser for jumping between places.
//
// `null` stands for Home: its absolute path is the host's to say (the first
// listing with no path reports it), so nothing here guesses at it.

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Folder, House } from 'lucide-react-native';
import { folderName } from '@patch/wire';
import { radii, space, textMin, typography, useTheme } from '../lib/theme';

export function PlacesList({
  folders,
  onPick,
  disabled,
}: {
  folders: readonly string[];
  onPick: (path: string | null) => void;
  disabled?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  const row = (key: string, label: string, detail: string | null, path: string | null) => (
    <Pressable
      key={key}
      testID={`place-${key}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => onPick(path)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: pressed ? colors.accentTint : 'transparent',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {path === null ? (
        <House size={16} color={colors.leaf} />
      ) : (
        <Folder size={16} color={colors.ink3} />
      )}
      <View style={{ marginLeft: space.sm, flex: 1 }}>
        <Text style={{ color: colors.ink }} numberOfLines={1}>
          {label}
        </Text>
        {detail !== null ? (
          <Text style={{ color: colors.ink3, ...typography.meta }} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
  return (
    <View testID="places-list">
      {row('home', 'Home', null, null)}
      {folders.map((f) => row(f, folderName(f), f, f))}
    </View>
  );
}

export function PlacesChips({
  folders,
  current,
  home,
  onPick,
}: {
  folders: readonly string[];
  /** The directory on screen, so the place it IS can be marked. */
  current: string | null;
  /** Home's absolute path once the host has said it, else null. */
  home: string | null;
  onPick: (path: string | null) => void;
}): React.ReactElement {
  const colors = useTheme();
  const chip = (key: string, label: string, path: string | null) => {
    const selected = current !== null && (path ?? home) === current;
    return (
      <Pressable
        key={key}
        testID={`place-chip-${key}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        onPress={() => onPick(path)}
        style={{
          paddingHorizontal: space.md,
          paddingVertical: space.xs,
          borderRadius: radii.lg,
          borderWidth: 1,
          borderColor: selected ? colors.leaf : colors.divider,
          backgroundColor: selected ? colors.accentTint : colors.paperRaised,
          marginRight: space.sm,
        }}
      >
        <Text style={{ color: selected ? colors.leaf : colors.ink2, fontSize: textMin }}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="places-chips"
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}
      keyboardShouldPersistTaps="handled"
    >
      {chip('home', 'Home', null)}
      {folders.map((f) => chip(f, folderName(f), f))}
    </ScrollView>
  );
}
