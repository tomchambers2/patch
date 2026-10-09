// Shared empty-state component (spec/15 § Empty states). One pattern for every
// empty surface: a centred touch-sized lucide icon (ink-3), an upright-Fraunces
// title, one line of ink-3 plain-sentence helper text, and an optional primary
// action button. Never bare, parenthesised, or bracketed text.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { fonts, radii, space, useTheme } from '../lib/theme';

interface Props {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}

export function EmptyState({ icon: Icon, title, body, action }: Props): React.ReactElement {
  const colors = useTheme();
  return (
    <View
      testID="empty-state"
      style={{ alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: space.xxl }}
    >
      <Icon size={32} color={colors.ink3} />
      <Text
        style={{
          fontFamily: fonts.brand,
          fontSize: 20,
          color: colors.ink,
          marginTop: space.md,
          textAlign: 'center',
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 14,
          color: colors.ink3,
          marginTop: space.xs,
          textAlign: 'center',
        }}
      >
        {body}
      </Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={{
            marginTop: space.lg,
            backgroundColor: colors.leaf,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
            borderRadius: radii.md,
          }}
          accessibilityRole="button"
          accessibilityLabel={action.label}
        >
          <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
