// BarDetailSheet — the full-size view a status bar opens when tapped (wake,
// background tasks): a centred modal card over a dimming backdrop. Bars stay
// one line at rest; this is where their whole text and controls live.

import React, { type ReactElement, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import { fonts, radii, space, useTheme } from '../../lib/theme';

export function BarDetailSheet({
  testID,
  title,
  onClose,
  children,
}: {
  testID: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  const colors = useTheme();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        testID={`${testID}-backdrop`}
        style={{
          flex: 1,
          backgroundColor: colors.shade,
          justifyContent: 'center',
          padding: space.lg,
        }}
        onPress={onClose}
      >
        <Pressable onPress={() => {}}>
          <View
            testID={testID}
            style={{
              backgroundColor: colors.paperRaised,
              borderRadius: radii.md,
              padding: space.md,
              maxHeight: '80%',
              gap: space.sm,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, color: colors.ink, fontFamily: fonts.bodyMedium }}>
                {title}
              </Text>
              <Pressable
                testID={`${testID}-close`}
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onClose}
                hitSlop={8}
              >
                <X size={18} color={colors.ink3} />
              </Pressable>
            </View>
            <ScrollView>{children}</ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
