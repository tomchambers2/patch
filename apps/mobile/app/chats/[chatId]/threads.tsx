// Side threads page — a chat's side threads as a pushed full screen (spec/15
// § Side threads screen), reached from the long-press "Open side thread"
// action on a message, or from a message's own side-thread marker. Mirrors
// `tools.tsx`'s thin-route-delegates-to-component shape.

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SideThreadsScreen } from '../../../src/components/SideThreadsScreen';

export default function ChatSideThreadsPage(): React.ReactElement {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  if (typeof chatId !== 'string' || chatId === '') {
    throw new Error('Threads page opened without a chatId');
  }
  return <SideThreadsScreen chatId={chatId} />;
}
