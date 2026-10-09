// ArtifactBar — every artifact this chat has published, above the transcript
// (spec/15 § Artifacts; mirrors web's `packages/web/src/components/
// ArtifactBar.tsx`). The transcript already carries each artifact as its own
// card, but finding an earlier one again means scrolling back to find it.
// This bar is the standing index: one chip per artifact, newest first,
// tapping a chip opens exactly what tapping its card would. Nothing to show
// when the chat has published nothing.

import React, { type ReactElement } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { LayoutTemplate } from 'lucide-react-native';
import { apiUrl } from '../../config';
import { useChatStore } from '../../stores/chatStore';
import { deriveArtifacts } from '../../lib/artifacts';
import { openArtifactViewer } from '../ArtifactViewer';
import { radii, space, textMin, useTheme } from '../../lib/theme';

export function ArtifactBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const artifacts = deriveArtifacts(timeline ?? []);
  if (artifacts.length === 0) return null;

  return (
    <ScrollView
      testID="artifact-bar"
      accessibilityRole="toolbar"
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexDirection: 'row',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingTop: space.xs,
      }}
    >
      {artifacts.map((artifact) => (
        <Pressable
          key={artifact.artifactId}
          testID="artifact-bar-chip"
          accessibilityRole="button"
          accessibilityLabel={artifact.title}
          onPress={() => openArtifactViewer(apiUrl(artifact.url), artifact.title)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            backgroundColor: colors.paperRaised,
            borderColor: colors.lineSoft,
            borderWidth: 1,
            borderRadius: radii.pill,
            paddingHorizontal: space.sm,
            paddingVertical: 6,
          }}
        >
          <LayoutTemplate size={14} color={colors.ink2} />
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: textMin, maxWidth: 160 }}>
            {artifact.title}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
