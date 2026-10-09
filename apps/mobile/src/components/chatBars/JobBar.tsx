// JobBar — the chat-detail bar linking a job-created chat to its job (spec/15
// § Chat detail → Status bars). Mirrors the web JobBar
// (packages/web/src/components/JobBar.tsx). No bar on a chat no job created.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Zap } from 'lucide-react-native';
import type { ChatRow } from '../../stores/types';
import { fonts, radii, space, textMin, useTheme } from '../../lib/theme';

export function JobBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  if (!row.jobId) return null;

  return (
    <View
      testID="job-bar"
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: colors.divider,
        borderWidth: 1,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.sm,
        margin: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
      }}
    >
      <Zap size={14} color={colors.ink2} />
      <Text style={{ color: colors.ink2, fontFamily: fonts.bodyMedium, fontSize: textMin }}>
        Run by a job
      </Text>
      <Pressable
        testID="job-bar-link"
        accessibilityLabel="Open job"
        onPress={() =>
          router.push(`/settings/job-editor?id=${row.jobId}` as `/settings/job-editor`)
        }
        style={{ marginLeft: 'auto' }}
      >
        <Text style={{ color: colors.leaf, fontFamily: fonts.bodyMedium, fontSize: textMin }}>
          Open job
        </Text>
      </Pressable>
    </View>
  );
}
