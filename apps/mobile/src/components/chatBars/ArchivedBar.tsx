// ArchivedBar — names an archived chat's state, with Unarchive beside it. Mobile
// port of web's ArchivedBanner (packages/web/src/components/ArchivedBanner.tsx).
// An archived chat still opens with its transcript and composer (archive is
// sticky — sending does not un-archive, spec/04 § Lifecycle), so without this
// the chat looks ordinary while being absent from the active list. Unarchive is
// the very toggle the Chats-tab row tools and the ⋯ menu call.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Archive, PackageOpen } from 'lucide-react-native';
import type { ChatRow } from '../../stores/types';
import { toggleArchive } from '../ChatLongPressSheet';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function ArchivedBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  if (row.status !== 'archived') return null;
  return (
    <BarShell testID="archived-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Archive size={14} color={colors.ink2} />
        <Text
          style={{ flex: 1, color: colors.ink2, fontSize: textMin, fontFamily: fonts.bodyMedium }}
        >
          Archived
        </Text>
        <Pressable
          testID="unarchive-bar-btn"
          accessibilityRole="button"
          accessibilityLabel="Unarchive chat"
          onPress={() => toggleArchive(row)}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
        >
          <PackageOpen size={14} color={colors.leaf} />
          <Text style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyMedium }}>
            Unarchive
          </Text>
        </Pressable>
      </View>
    </BarShell>
  );
}
