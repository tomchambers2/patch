// ReminderBar — the chat's reminder (`/remind`) above the transcript. Mobile
// port of web's ReminderBanner (packages/web/src/components/ReminderBanner.tsx),
// same data and route. One truncated line at rest; tapping it shows the whole
// reminder. × clears it — optimistic, reverting with a toast on failure. No bar
// when the chat has no reminder.

import React, { useState, type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Bell, X } from 'lucide-react-native';
import type { ChatRow } from '../../stores/types';
import { writeReminder } from '../../lib/chatMeta';
import { space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function ReminderBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const [open, setOpen] = useState(false);
  const reminder = row.reminder;
  if (reminder === null || reminder.trim() === '') return null;

  return (
    <BarShell testID="reminder-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Bell size={14} color={colors.ink2} />
        <Pressable
          testID="reminder-bar-summary"
          accessibilityRole="button"
          accessibilityLabel={open ? 'Collapse reminder' : 'Expand reminder'}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ flex: 1 }}
        >
          <Text
            testID="reminder-bar-text"
            numberOfLines={open ? undefined : 1}
            style={{ color: colors.ink2, fontSize: textMin }}
          >
            {reminder}
          </Text>
        </Pressable>
        <Pressable
          testID="reminder-clear-btn"
          accessibilityRole="button"
          accessibilityLabel="Clear reminder"
          onPress={() => void writeReminder(row.chatId, null)}
          hitSlop={8}
        >
          <X size={14} color={colors.ink3} />
        </Pressable>
      </View>
    </BarShell>
  );
}
