// Inline delegate transcript (spec/15 § Chat detail — Delegate tool row): a
// `patch_delegate` subagent's own message exchange, read-only — no composer,
// no tool calls, no permission cards — rendered beneath the collapsible
// delegate row inside the parent chat. A subagent is never a chat this
// surface can open the ordinary way (spec/04 § Chats and folders —
// Subagent), so the parent's row is the only door into it. Polls while the
// subagent is still going, same pattern as `SideThreadsScreen`'s
// `useBranchHistory` (nothing broadcasts a subagent's own traffic to this
// surface — spec/02 § Native subagent dispatch).

import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useChatStore } from '../stores/chatStore';
import { api } from '../api/rest';
import { ChatMarkdown } from './ChatMarkdown';
import { Text } from 'react-native';
import { space, typography, useTheme } from '../lib/theme';

interface DelegateHistoryEvent {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function useDelegateHistory(
  parentId: string,
  delegateId: string,
  live: boolean,
): DelegateHistoryEvent[] {
  const [events, setEvents] = React.useState<DelegateHistoryEvent[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api.getDelegateHistory(parentId, delegateId).then((r) => {
        if (!cancelled) setEvents(r.events as unknown as DelegateHistoryEvent[]);
      });
    };
    load();
    if (!live)
      return () => {
        cancelled = true;
      };
    const t = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [parentId, delegateId, live]);
  return events;
}

export function DelegateTranscript({
  chatId,
  delegateId,
}: {
  /** The PARENT chat's id — the subagent is never in the chat registry. */
  chatId: string;
  delegateId: string;
}): React.ReactElement {
  const colors = useTheme();
  const status = useChatStore((s) => s.delegateUpdates[chatId]?.[delegateId]?.status ?? 'running');
  const isLive = status === 'running' || status === 'awaiting-permission';
  const events = useDelegateHistory(chatId, delegateId, isLive);

  return (
    <View
      testID="delegate-transcript-stream"
      style={{
        marginTop: space.xs,
        paddingTop: space.sm,
        borderTopWidth: 1,
        borderColor: colors.lineSoft,
      }}
    >
      {events.length === 0 ? (
        <ActivityIndicator color={colors.ink3} />
      ) : (
        events.map((e) => (
          <View key={e.seq} testID="delegate-transcript-msg" style={{ marginBottom: space.md }}>
            <Text style={{ ...typography.meta, color: colors.ink3, marginBottom: space.xs }}>
              {e.role}
            </Text>
            <ChatMarkdown content={e.content} color={colors.ink} />
          </View>
        ))
      )}
    </View>
  );
}
