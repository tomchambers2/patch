// A compact dropdown menu anchored at the top-right, for the chat-detail kebab
// (spec/15 § Chat detail). Deliberately NOT a centre-screen stacked-button
// Alert — that centred dialog was the "horrible pop-up". This is a small card
// that drops from under the header where the ⋯ lives, with a tap-outside
// backdrop to dismiss. Destructive items render in red. The composer's
// permission padlock reuses it with `placement="bottom"`, where a mode the
// chat's model cannot run is listed greyed (`disabled`) and the mode in force
// is ticked (`selected`).

import React from 'react';
import { BackHandler, Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import { fixed, fonts, radii, space, useTheme } from '../lib/theme';

export interface AnchoredMenuItem {
  id: string;
  label: string;
  destructive?: boolean;
  /** Shown greyed and un-pressable — offered for context, not for choosing. */
  disabled?: boolean;
  /** The option currently in force: ticked. */
  selected?: boolean;
  /** Test/automation handle for the row. */
  testID?: string;
}

export function AnchoredMenu({
  visible,
  items,
  onSelect,
  onDismiss,
  placement = 'top',
  nonModal = false,
}: {
  visible: boolean;
  items: AnchoredMenuItem[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
  /**
   * Where the card drops from: `top` under the header's ⋯ (the kebab), or
   * `bottom` over the composer's action row, for a control that lives there
   * (the permission padlock). Either way it is anchored to the right edge.
   */
  placement?: 'top' | 'bottom';
  /**
   * Skip react-native's <Modal>. On Android, Modal always clears
   * FLAG_NOT_FOCUSABLE right after showing (it has to, to receive touches),
   * which hands window focus to the dialog and kills whatever IME was open on
   * the window underneath — there is no prop that stops it. The composer's
   * permission padlock needs the menu to open without dropping the keyboard
   * mid-type, so it renders a plain absolute overlay instead.
   *
   * Only correct with `placement="bottom"` from a component that itself sits
   * flush against the screen's bottom edge, the way the composer does — the
   * backdrop below is sized from that assumption, not measured.
   */
  nonModal?: boolean;
}): React.ReactElement | null {
  const insets = useSafeAreaInsets();
  const colors = useTheme();
  const { height: windowHeight } = useWindowDimensions();

  React.useEffect(() => {
    if (!nonModal || !visible) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismiss();
      return true;
    });
    return () => sub.remove();
  }, [nonModal, visible, onDismiss]);

  const card = (
    <View
      style={{
        position: 'absolute',
        ...(placement === 'top'
          ? { top: insets.top + 52 }
          : { bottom: insets.bottom + space.xxxl + space.md }),
        right: space.md,
        minWidth: 180,
        backgroundColor: colors.paperRaised,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.divider,
        paddingVertical: space.xs,
        // Elevation/shadow so it reads as a floating menu.
        elevation: 8,
        shadowColor: fixed.shadow,
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          testID={item.testID}
          disabled={item.disabled}
          onPress={() => {
            if (item.disabled) return;
            onDismiss();
            onSelect(item.id);
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingVertical: space.sm,
            paddingHorizontal: space.md,
            backgroundColor: pressed ? colors.accentTint : 'transparent',
          })}
          accessibilityRole="menuitem"
          accessibilityLabel={item.label}
          accessibilityState={{
            disabled: item.disabled === true,
            selected: item.selected === true,
          }}
        >
          <Text
            style={{
              color: item.disabled ? colors.inkFaint : item.destructive ? colors.red : colors.ink,
              fontSize: 15,
              fontFamily: fonts.bodyMedium,
              flex: 1,
            }}
          >
            {item.label}
          </Text>
          {item.selected ? <Check size={16} color={colors.leaf} /> : null}
        </Pressable>
      ))}
    </View>
  );

  if (nonModal) {
    if (!visible) return null;
    return (
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: windowHeight }}
      >
        {/* Backdrop sized to the window height and anchored to this
            component's own bottom edge — which, for the composer padlock,
            coincides with the screen's bottom edge (nothing renders below the
            composer), so it reaches the full visible area above without
            measuring it. Tap anywhere on it, outside the card, to dismiss. */}
        <Pressable style={{ flex: 1 }} onPress={onDismiss} accessibilityLabel="Dismiss menu">
          {card}
        </Pressable>
      </View>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      {/* Full-screen backdrop — tap anywhere outside to dismiss. */}
      <Pressable style={{ flex: 1 }} onPress={onDismiss} accessibilityLabel="Dismiss menu">
        {card}
      </Pressable>
    </Modal>
  );
}
