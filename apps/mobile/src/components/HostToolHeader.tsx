// The top bar shared by the host Files, editor and terminal screens (spec/15
// § Host files and terminal): back, a title, the host it is acting on, and an
// optional action on the right. The host name is always shown — these screens
// act on ONE machine's filesystem, and which one must never be a guess.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { space, typography, useTheme } from '../lib/theme';

export function HostToolHeader({
  title,
  hostName,
  onBack,
  right,
}: {
  title: string;
  hostName: string;
  onBack: () => void;
  right?: React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space.sm,
        paddingVertical: space.sm,
        borderBottomWidth: 1,
        borderColor: colors.divider,
      }}
    >
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        testID="host-tool-back"
        style={{ padding: space.sm }}
      >
        <ChevronLeft size={22} color={colors.ink} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ ...typography.title, color: colors.ink }}
          testID="host-tool-title"
        >
          {title}
        </Text>
        <Text numberOfLines={1} style={{ ...typography.meta, color: colors.ink3 }}>
          {hostName}
        </Text>
      </View>
      {right}
    </View>
  );
}
