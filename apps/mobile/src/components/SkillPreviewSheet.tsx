// The composer skill chip's tap preview (spec/15 § Skill autocomplete): the
// same information web's hover preview shows — full description, the rest of
// the frontmatter, an Edit link — reached by tapping the chip instead of
// hovering it, since a phone has no hover. A bottom sheet, matching every
// other tap-triggered card on this surface (ChatLongPressSheet.tsx).
//
// NO FALLBACK: a skill with no description or no frontmatter shows only what
// it actually has — never an invented description or a "no description"
// filler line (matches packages/web/src/components/SkillPreviewPanel.tsx).

import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { radii, space, typography, fonts, useTheme } from '../lib/theme';
import { editRoute } from '../lib/hostFiles';
import { resolveSkillEditTarget } from '../lib/jobEditor';

/** Frontmatter fields already shown elsewhere in the sheet — excluded from
 *  the "rest of the frontmatter" list so nothing repeats. */
const SHOWN_ELSEWHERE = new Set(['name', 'description']);

export interface SkillPreviewSheetProps {
  /** `null` closes the sheet. */
  skill: { name: string; description: string | undefined } | null;
  frontmatter: Record<string, Record<string, string>> | undefined;
  paths: Record<string, string> | undefined;
  daemonId: string;
  onClose(): void;
}

export function SkillPreviewSheet({
  skill,
  frontmatter,
  paths,
  daemonId,
  onClose,
}: SkillPreviewSheetProps): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  if (!skill) {
    return <Modal visible={false} transparent animationType="fade" />;
  }
  const fields = frontmatter?.[skill.name];
  const extraFields = fields
    ? Object.entries(fields).filter(([key]) => !SHOWN_ELSEWHERE.has(key))
    : [];
  const editTarget = resolveSkillEditTarget({ skill: skill.name, paths, daemonId });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        testID="skill-preview-backdrop"
        style={{ flex: 1, backgroundColor: colors.shade }}
        onPress={onClose}
      >
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => {}}>
          <ScrollView
            testID="skill-preview-sheet"
            style={{
              maxHeight: 320,
              backgroundColor: colors.paperRaised,
              borderTopLeftRadius: radii.lg,
              borderTopRightRadius: radii.lg,
            }}
            contentContainerStyle={{ padding: space.lg }}
          >
            <Text style={{ ...typography.title, fontSize: 16, color: colors.ink }}>
              /{skill.name}
            </Text>
            {skill.description ? (
              <Text
                testID="skill-preview-desc"
                style={{ ...typography.secondary, color: colors.ink2, marginTop: space.xs }}
              >
                {skill.description}
              </Text>
            ) : null}
            {extraFields.length > 0 ? (
              <View testID="skill-preview-fields" style={{ marginTop: space.sm, gap: space.xs }}>
                {extraFields.map(([key, value]) => (
                  <View key={key} style={{ flexDirection: 'row', gap: space.xs }}>
                    <Text
                      style={{
                        ...typography.secondary,
                        fontFamily: fonts.bodyBold,
                        color: colors.ink3,
                      }}
                    >
                      {key}
                    </Text>
                    <Text style={{ ...typography.secondary, color: colors.ink3, flexShrink: 1 }}>
                      {value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {editTarget && 'daemonId' in editTarget ? (
              <Pressable
                testID="skill-preview-edit"
                style={{ marginTop: space.sm }}
                onPress={() => {
                  onClose();
                  router.push(editRoute(editTarget.daemonId, editTarget.path));
                }}
              >
                <Text
                  style={{
                    ...typography.secondary,
                    color: colors.leaf,
                    fontFamily: fonts.bodyBold,
                  }}
                >
                  Edit
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
