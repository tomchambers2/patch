// GoalBar — the chat's goal (`/goal`) above the transcript. Mobile port of web's
// GoalBanner (packages/web/src/components/GoalBanner.tsx), same data and route.
// At rest it is one truncated line; tapping it opens the full goal, whose text
// is then tap-to-edit (InlineEditText). × clears it. Optimistic, reverting with
// a toast on failure (lib/chatMeta). No bar when the chat has no goal.

import React, { useState, type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ChevronDown, ChevronUp, Target, X } from 'lucide-react-native';
import type { ChatRow } from '../../stores/types';
import { writeGoal } from '../../lib/chatMeta';
import { space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';
import { InlineEditText } from './InlineEditText';

export function GoalBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const [open, setOpen] = useState(false);
  const goal = row.goal;
  if (goal === null || goal.trim() === '') return null;
  const textStyle = { color: colors.ink2, fontSize: textMin };

  return (
    <BarShell testID="goal-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Target size={14} color={colors.ink2} />
        {open ? (
          <InlineEditText
            testID="goal-bar-text"
            editLabel="Edit goal"
            value={goal}
            onCommit={(next) => void writeGoal(row.chatId, next)}
            textStyle={textStyle}
          />
        ) : (
          <Pressable
            testID="goal-bar-summary"
            accessibilityRole="button"
            accessibilityLabel="Show goal"
            onPress={() => setOpen(true)}
            style={{ flex: 1 }}
          >
            <Text numberOfLines={1} style={textStyle}>
              {goal}
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="goal-bar-toggle"
          accessibilityRole="button"
          accessibilityLabel={open ? 'Collapse goal' : 'Expand goal'}
          onPress={() => setOpen(!open)}
          hitSlop={8}
        >
          {open ? (
            <ChevronUp size={14} color={colors.ink3} />
          ) : (
            <ChevronDown size={14} color={colors.ink3} />
          )}
        </Pressable>
        <Pressable
          testID="goal-clear-btn"
          accessibilityRole="button"
          accessibilityLabel="Clear goal"
          onPress={() => void writeGoal(row.chatId, null)}
          hitSlop={8}
        >
          <X size={14} color={colors.ink3} />
        </Pressable>
      </View>
    </BarShell>
  );
}
