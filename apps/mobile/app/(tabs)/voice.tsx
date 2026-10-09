// Voice tab: opens the Manager thread directly. Re-uses the chat-detail
// rendering by redirecting to /chats/thread_manager.

import React from 'react';
import { Redirect } from 'expo-router';

export default function VoiceTab(): React.ReactElement {
  return <Redirect href="/chats/thread_manager" />;
}
