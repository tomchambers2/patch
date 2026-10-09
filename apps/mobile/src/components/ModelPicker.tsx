// The phone's model control (spec/15 § New chat flow → Model picker): a pill
// that names the model a chat will start on, opening the chosen host's live
// catalogue as a list.
//
// It mirrors the web picker's BEHAVIOUR — pill + list, a tick on the model in
// force, the catalogue's own loading/error state shown in place of the options
// — in mobile terms: a Modal with a tap-anywhere backdrop, as every other
// dismissible surface on this app uses (see `AnchoredMenu`). Open state is
// owned here because, unlike web's new-chat row, this screen has no sibling
// pop-up to stay mutually exclusive with.
//
// The chat composer reuses it as its model pill (spec/15 § Composer — Model
// pill): `variant="compact"` reads a short friendly name ("Opus 5.5"), and the
// catalogue is only fetched the first time the list is opened — every chat open
// would otherwise be a round trip to the host for a list nobody asked to see.
//
// Wherever the pill sits, the list opens over the composer at the foot of the
// screen, where the permission-mode list opens too. Never under the header:
// that is where a screen's own ⋯ menu drops, and a list opened from the
// new-chat screen's inline pill read as belonging to that instead (Todoist
// 6hf6qqRgf568HmPc).

import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown } from 'lucide-react-native';
import { useModelCatalog } from '../lib/models';
import { compactModelLabel } from '../lib/modelLabel';
import { fixed, fonts, radii, space, textMin, useTheme } from '../lib/theme';

export function ModelPicker({
  daemonId,
  selected,
  onSelect,
  disabled = false,
  variant = 'full',
  testID = 'new-chat-model-pill',
  pending = false,
  note,
}: {
  /** The host this chat will run on — the catalogue is that machine's. */
  daemonId: string | null;
  /** The model in force as an id, or null when there is none to name yet. */
  selected: string | null;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
  /** `compact`: the composer's short pill, catalogue read on first open. */
  variant?: 'full' | 'compact';
  testID?: string;
  /** A change has been asked for and the host has not confirmed it yet. */
  pending?: boolean;
  /** One line above the options, e.g. which turn a change applies to. */
  note?: string;
}): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = React.useState(false);
  const compact = variant === 'compact';
  // Latches on the first open, so a compact pill's catalogue — once read —
  // stays for the label and the next open instead of being dropped on close.
  const [wanted, setWanted] = React.useState(!compact);
  const catalog = useModelCatalog(wanted ? daemonId : null);

  // An id the catalogue does not carry (retired since, or not loaded yet) reads
  // as the raw id — surfaced, never blanked or swapped for a neighbour. The
  // compact pill reduces either to its short form (`compactModelLabel`).
  const catalogueLabel =
    selected === null ? undefined : catalog.models.find((m) => m.id === selected)?.label;
  const label =
    selected === null
      ? 'Choose a model…'
      : compact
        ? compactModelLabel(selected, catalogueLabel)
        : (catalogueLabel ?? selected);

  return (
    <>
      <Pressable
        testID={testID}
        accessibilityLabel="model"
        accessibilityRole="button"
        accessibilityState={{ disabled, busy: pending }}
        disabled={disabled}
        onPress={() => {
          setWanted(true);
          setOpen(true);
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: compact ? 2 : space.xs,
          paddingHorizontal: compact ? space.sm : space.md,
          paddingVertical: space.xs,
          borderRadius: radii.pill,
          borderWidth: 1,
          borderColor: colors.divider,
          backgroundColor: pressed ? colors.accentTint : colors.paperRaised,
          // Capped so a long model id can't squeeze the screen title it sits
          // beside; the label ellipsises inside it. The compact pill also
          // SHRINKS: on a 360dp phone it is the one thing on the composer row
          // that gives way, so Send is never pushed off the edge.
          maxWidth: compact ? 120 : 170,
          flexShrink: compact ? 1 : 0,
          opacity: pending ? 0.6 : 1,
        })}
      >
        <Text
          numberOfLines={1}
          style={{
            color: colors.ink2,
            fontFamily: fonts.body,
            fontSize: textMin,
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
        <ChevronDown size={14} color={colors.ink3} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Tap anywhere outside to dismiss; nothing is chosen by dismissing. */}
        <Pressable
          style={{ flex: 1 }}
          onPress={() => setOpen(false)}
          accessibilityLabel="Dismiss model list"
        >
          <View
            testID="model-picker-list"
            style={{
              position: 'absolute',
              bottom: insets.bottom + space.xxxl + space.md,
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
            {/* The catalogue's own state stands in the options' place — NO
                FALLBACK, so a failed read is read out rather than papered over
                with a list this host may not serve. */}
            {note !== undefined ? (
              <Text
                testID="model-picker-note"
                style={{
                  color: colors.ink3,
                  paddingHorizontal: space.md,
                  paddingVertical: space.xs,
                  fontSize: textMin,
                }}
              >
                {note}
              </Text>
            ) : null}
            {catalog.status === 'error' ? (
              <Text
                testID="new-chat-model-error"
                style={{
                  color: colors.red,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  fontSize: 13,
                }}
              >
                {catalog.error}
              </Text>
            ) : catalog.status !== 'ready' ? (
              <Text
                testID="new-chat-model-loading"
                style={{
                  color: colors.ink3,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  fontSize: 13,
                }}
              >
                Loading models…
              </Text>
            ) : catalog.models.length === 0 ? (
              <Text
                testID="new-chat-model-empty"
                style={{
                  color: colors.ink3,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  fontSize: 13,
                }}
              >
                No models on this host.
              </Text>
            ) : (
              <ScrollView>
                {catalog.models.map((m) => {
                  const active = m.id === selected;
                  return (
                    <Pressable
                      key={m.id}
                      testID={`new-chat-model-option-${m.id}`}
                      onPress={() => {
                        setOpen(false);
                        onSelect(m.id);
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
                        style={{ color: active ? colors.leaf : colors.ink, flex: 1, fontSize: 15 }}
                      >
                        {m.label}
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
