// Generic dropdown/picker: a pill naming the current choice, opening a list
// of options as a dismissible sheet. Same shape as `ModelPicker` (spec/15 §
// New chat flow → Model picker) — pill + list + a tick on the active option,
// a Modal with a tap-anywhere backdrop like every other dismissible surface
// in this app (`AnchoredMenu`) — generalised so the job editor's Skill,
// Model and Folder fields (spec/15 § Job editor: "skill is a dropdown of the
// target folder's skills", "Model … offering the chosen host's catalogue")
// can all reuse ONE picker rather than three separate wrapping-chip rows.

import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown } from 'lucide-react-native';
import { fixed, fonts, radii, space, textMin, useTheme } from '../lib/theme';

export interface OptionPickerOption {
  id: string;
  label: string;
}

export function OptionPicker({
  testID,
  selectedId,
  selectedLabel,
  options,
  onSelect,
  emptyText,
  disabled = false,
}: {
  testID: string;
  /** The active option's id — drives the checkmark. Compared by id, not by
   * label: two options can legitimately share display text (e.g. a skill
   * literally named the same as another folder's). */
  selectedId: string;
  /** What the closed pill shows — the caller derives this (e.g. falling back
   * to a raw id the current option list no longer carries), same rule
   * `ModelPicker` follows: surfaced, never blanked or swapped for a neighbour. */
  selectedLabel: string;
  options: OptionPickerOption[];
  onSelect: (id: string) => void;
  /** Shown in the open list instead of any options, when there are none. */
  emptyText: string;
  disabled?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Pressable
        testID={testID}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.xs,
          alignSelf: 'flex-start',
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.divider,
          backgroundColor: pressed ? colors.accentTint : colors.paperRaised,
          opacity: disabled ? 0.5 : 1,
        })}
      >
        <Text
          numberOfLines={1}
          style={{
            color: colors.ink,
            fontFamily: fonts.body,
            fontSize: textMin,
          }}
        >
          {selectedLabel}
        </Text>
        <ChevronDown size={14} color={colors.ink3} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1 }}
          onPress={() => setOpen(false)}
          accessibilityLabel={`Dismiss ${testID} list`}
        >
          <View
            style={{
              position: 'absolute',
              top: insets.top + 52,
              left: space.md,
              right: space.md,
              maxHeight: 360,
              backgroundColor: colors.paperRaised,
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: colors.divider,
              paddingVertical: space.xs,
              elevation: 8,
              shadowColor: fixed.shadow,
              shadowOpacity: 0.18,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
            }}
          >
            {options.length === 0 ? (
              <Text
                testID={`${testID}-empty`}
                style={{
                  color: colors.ink3,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  fontSize: 13,
                }}
              >
                {emptyText}
              </Text>
            ) : (
              <ScrollView>
                {options.map((o) => {
                  const active = o.id === selectedId;
                  return (
                    <Pressable
                      key={o.id}
                      testID={`${testID}-option-${o.id === '' ? 'default' : o.id}`}
                      onPress={() => {
                        setOpen(false);
                        onSelect(o.id);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: space.sm,
                        paddingHorizontal: space.md,
                        backgroundColor: pressed ? colors.accentTint : 'transparent',
                      })}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          color: active ? colors.leaf : colors.ink,
                          fontFamily: fonts.body,
                          flex: 1,
                          fontSize: 15,
                        }}
                      >
                        {o.label}
                      </Text>
                      {active ? <Check size={16} color={colors.leaf} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
