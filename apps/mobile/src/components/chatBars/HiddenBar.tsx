// HiddenBar — names a hidden chat's state, with Show beside it (spec/04 §
// Hidden). A hidden chat still opens with its transcript and composer, so
// without this the chat looks ordinary while being absent from the active
// list. Show is the very function the Hidden row's tray, its sheet and the ⋯
// menu call. Drawn only while the chat is also active: an archived chat that
// keeps the flag gets the Archived bar instead.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EyeOff } from 'lucide-react-native';
import type { ChatRow } from '../../stores/types';
import { isHidden } from '../../stores/types';
import { showHiddenChat } from '../ChatLongPressSheet';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function HiddenBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  if (!isHidden(row)) return null;
  return (
    <BarShell testID="hidden-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <EyeOff size={14} color={colors.ink2} />
        <Text
          style={{ flex: 1, color: colors.ink2, fontSize: textMin, fontFamily: fonts.bodyMedium }}
        >
          Hidden
        </Text>
        <Pressable
          testID="show-bar-btn"
          accessibilityRole="button"
          accessibilityLabel="Show chat"
          onPress={() => showHiddenChat(row.chatId)}
          hitSlop={8}
        >
          <Text style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyMedium }}>
            Show
          </Text>
        </Pressable>
      </View>
    </BarShell>
  );
}
