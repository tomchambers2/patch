// SnoozedBanner — the chat-detail bar naming the wake time of a snoozed chat
// (spec/15 § Chat detail → Snoozed banner; spec/04 § Snooze). Mirrors the web
// SnoozedBanner (packages/web/src/components/SnoozedBanner.tsx).
//
// A snoozed chat still OPENS normally — from its Snoozed row, a deep link or a
// push tap — so nothing is hidden; the chat simply names its own state. Without
// this bar the chat would look ordinary while quietly being absent from the
// active list, which is the confusing case.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AlarmClock } from 'lucide-react-native';
import type { ChatRow } from '../stores/types';
import { isSnoozed } from '../stores/types';
import { formatWakeTime } from '../lib/snooze';
import { applySnooze } from './ChatLongPressSheet';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';

export function SnoozedBanner({ row }: { row: ChatRow | undefined }): ReactElement | null {
  const colors = useTheme();
  // Derived from the clock, so a phone that was asleep through the wake time
  // drops the banner on first paint without waiting for an event.
  if (!row || !isSnoozed(row) || row.snoozedUntil === null) return null;

  return (
    <View
      testID="snoozed-banner"
      accessibilityRole="text"
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: colors.divider,
        borderWidth: 1,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.sm,
        margin: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
      }}
    >
      <AlarmClock size={14} color={colors.ink2} />
      <Text
        style={{
          color: colors.ink2,
          fontFamily: fonts.bodyMedium,
          fontSize: textMin,
          flexShrink: 1,
        }}
      >
        Snoozed until {formatWakeTime(row.snoozedUntil)}
      </Text>
      <Pressable
        testID="unsnooze-banner-btn"
        accessibilityLabel="Unsnooze chat"
        onPress={() => applySnooze(row.chatId, null)}
        style={{ marginLeft: 'auto' }}
      >
        <Text style={{ color: colors.leaf, fontFamily: fonts.bodyMedium, fontSize: textMin }}>
          Unsnooze
        </Text>
      </Pressable>
    </View>
  );
}
