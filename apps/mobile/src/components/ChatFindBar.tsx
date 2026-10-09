// Find in this chat (spec/15 § Find in chat): the bar under the chat header.
// Presentational — the screen owns the query and the position.

import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import { space, typography, useTheme } from '../lib/theme';

export function ChatFindBar({
  query,
  onQuery,
  position,
  count,
  onStep,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  /** 0-based index of the current match, -1 when none. */
  position: number;
  count: number;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}): React.JSX.Element {
  const colors = useTheme();
  return (
    <View
      testID="chat-find-bar"
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md }}
    >
      <TextInput
        testID="chat-find-input"
        autoFocus
        value={query}
        onChangeText={onQuery}
        onSubmitEditing={() => onStep(1)}
        placeholder="Find in chat"
        placeholderTextColor={colors.inkFaint}
        returnKeyType="search"
        style={{ flex: 1, ...typography.body, color: colors.ink, paddingVertical: space.sm }}
      />
      <Text testID="chat-find-count" style={{ ...typography.meta, color: colors.inkFaint }}>
        {query.trim() === '' ? '' : count === 0 ? '0' : `${position + 1}/${count}`}
      </Text>
      <Pressable
        testID="chat-find-prev"
        accessibilityLabel="Previous match"
        onPress={() => onStep(-1)}
        style={{ padding: space.sm }}
      >
        <ChevronUp size={20} color={colors.ink} />
      </Pressable>
      <Pressable
        testID="chat-find-next"
        accessibilityLabel="Next match"
        onPress={() => onStep(1)}
        style={{ padding: space.sm }}
      >
        <ChevronDown size={20} color={colors.ink} />
      </Pressable>
      <Pressable
        testID="chat-find-close"
        accessibilityLabel="Close find"
        onPress={onClose}
        style={{ padding: space.sm }}
      >
        <X size={20} color={colors.ink} />
      </Pressable>
    </View>
  );
}
