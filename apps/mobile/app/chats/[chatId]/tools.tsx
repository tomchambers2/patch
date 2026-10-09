// Tools page — a chat's per-chat tool inventory as a pushed full screen
// (spec/15 § Chat detail → Tools), reached from the chat's ⋯ menu → Tools.
// It replaced a 75%-height bottom sheet opened from a header wrench: the list
// is long (every native and Patch tool, each with its definition), and a page
// gives it the whole screen and the system back gesture.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { ToolsList } from '../../../src/components/ToolsList';
import { useGoBack } from '../../../src/lib/goBack';
import { space, typography, useTheme } from '../../../src/lib/theme';

export default function ChatToolsScreen(): React.ReactElement {
  const colors = useTheme();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const goBack = useGoBack(`/chats/${chatId}`);
  if (typeof chatId !== 'string' || chatId === '') {
    throw new Error('Tools page opened without a chatId');
  }

  return (
    <View testID="tools-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          // The root layout's SafeAreaView already clears the status bar.
          paddingTop: space.sm,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          backgroundColor: colors.paperRaised,
          borderBottomWidth: 1,
          borderColor: colors.divider,
        }}
      >
        <Pressable
          onPress={goBack}
          style={{ padding: space.sm }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text
          style={{
            ...typography.title,
            color: colors.ink,
            paddingHorizontal: space.sm,
          }}
        >
          Tools
        </Text>
      </View>
      <ToolsList chatId={chatId} />
    </View>
  );
}
