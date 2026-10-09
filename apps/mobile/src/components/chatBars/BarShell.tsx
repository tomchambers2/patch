// BarShell — the one frame every chat-detail status bar sits in (spec/15 §
// Chat detail → Status bars): a compact raised strip above the transcript. The
// bars stack, so each is kept to a single line at rest and only grows when
// the user opens it — the frame is deliberately tighter than the wake/snoozed
// bars' so four of them together still leave the transcript the screen.

import React, { type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';
import { radii, space, useTheme } from '../../lib/theme';

export function BarShell({
  testID,
  children,
  tone = 'plain',
  role,
}: {
  testID: string;
  children: ReactNode;
  /** `alert` draws the border in the error colour (Claude disconnected). */
  tone?: 'plain' | 'alert';
  role?: 'alert';
}): ReactElement {
  const colors = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole={role}
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: tone === 'alert' ? colors.red : colors.lineSoft,
        borderWidth: 1,
        borderRadius: radii.md,
        marginHorizontal: space.sm,
        marginTop: space.xs,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
      }}
    >
      {children}
    </View>
  );
}
