// One group on a Settings page (design/settings-redesign): a small uppercase
// label over a rounded, bordered card of rows (settings/ui.tsx `Row`). The
// label is optional — a lone card (Resume automatically…, Last checked) has
// none. `footer` sits under the card, e.g. the right-aligned Add account.

import React from 'react';
import { View } from 'react-native';
import { radii, space, useTheme } from '../lib/theme';
import { GroupLabel } from './settings/ui';

export function SettingsSection({
  title,
  testID,
  children,
  footer,
}: {
  title?: string;
  testID?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View testID={testID} style={{ marginBottom: space.xl }}>
      {title ? <GroupLabel>{title}</GroupLabel> : null}
      <View
        style={{
          backgroundColor: colors.paperRaised,
          borderRadius: radii.lg,
          borderWidth: 1,
          borderColor: colors.lineSoft,
          overflow: 'hidden',
        }}
      >
        {/* Every row draws its own top rule; pulling the first one up under the
            card's border hides it, so rules only ever sit BETWEEN rows. */}
        <View style={{ marginTop: -1 }}>{children}</View>
      </View>
      {footer ? <View style={{ marginTop: space.sm }}>{footer}</View> : null}
    </View>
  );
}
