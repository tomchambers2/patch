// spec/04 § History — the provider-switch confirmation (mobile). Shown only
// when the composer's model pill picks a DIFFERENT harness than the chat's
// current one; a same-provider model change never reaches this. A small
// centered Modal, not a bottom sheet (ChatLongPressSheet's shape) and not
// `Alert.alert` (native alerts cannot carry the "don't show again" switch) —
// deliberately its own component so Tom's exact copy has no room for
// anything else: no token estimate, no other text.

import React from 'react';
import { Modal, Pressable, Switch, Text, View } from 'react-native';
import { radii, space, typography, useTheme } from '../lib/theme';
import { SettingsButton, ButtonRow } from './settings/ui';

export function ProviderSwitchModal({
  visible,
  onCancel,
  onSwitch,
}: {
  visible: boolean;
  onCancel: () => void;
  onSwitch: (dontShowAgain: boolean) => void;
}): React.ReactElement {
  const colors = useTheme();
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  // Reset the checkbox each time the modal is (re-)opened, so a previous
  // switch's tick never silently carries into the next one.
  React.useEffect(() => {
    if (visible) setDontShowAgain(false);
  }, [visible]);

  if (!visible) return <Modal visible={false} transparent animationType="fade" />;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        testID="provider-switch-modal-backdrop"
        style={{
          flex: 1,
          backgroundColor: colors.shade,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onPress={onCancel}
      >
        <Pressable
          testID="provider-switch-modal"
          onPress={() => {}}
          style={{
            backgroundColor: colors.paperRaised,
            borderRadius: radii.lg,
            padding: space.lg,
            width: '85%',
            maxWidth: 380,
          }}
        >
          <Text style={{ ...typography.body, color: colors.ink, marginBottom: space.md }}>
            Switching provider may cost more due to lack of a cache, are you sure?
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              marginBottom: space.lg,
            }}
          >
            <Switch
              testID="provider-switch-dont-show-again"
              accessibilityLabel="Don't show again"
              value={dontShowAgain}
              onValueChange={setDontShowAgain}
              trackColor={{ false: colors.divider, true: colors.leafSoft }}
              thumbColor={dontShowAgain ? colors.leaf : colors.paper}
            />
            <Text style={{ ...typography.secondary, color: colors.ink2 }}>
              Don&apos;t show again
            </Text>
          </View>
          <ButtonRow>
            <SettingsButton
              testID="provider-switch-cancel"
              label="Cancel"
              variant="quiet"
              onPress={onCancel}
            />
            <SettingsButton
              testID="provider-switch-switch"
              label="Switch"
              variant="primary"
              onPress={() => onSwitch(dontShowAgain)}
            />
          </ButtonRow>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
