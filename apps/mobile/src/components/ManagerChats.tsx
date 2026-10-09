// The Manager chat's "Conversation | Chats" switch and its Chats tab (spec/15
// § Voice tab (Manager)) — the phone's counterpart to the desktop Threads strip
// (spec/14 § Manager view). The Chats tab lists every active chat on every
// host, needs-you first, each with its status and the decision it is blocked
// on: Approve for a pending permission, Stop for a running turn, tap to open.
//
// Ordering is the shared rule in `@patch/wire` (`threadRows`), the same one the
// desktop strip calls, so the two surfaces never disagree about what is first.

import React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ListChecks, Square } from 'lucide-react-native';
import { SPECIAL_THREAD_IDS, threadRowState, threadRows, type ThreadRowState } from '@patch/wire';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { deriveBadge, type ChatRow } from '../stores/types';
import { getWs } from '../api/ws';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker';
import { deriveChatTitle } from '../lib/labels';
import { fonts, radii, space, textMin, typography, useTheme } from '../lib/theme';
import { EMPTY_STATES } from '../lib/emptyStates';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './EmptyState';

export type ManagerTab = 'conversation' | 'chats';

/**
 * Claude Code's own question tool. Approving it with no answers would reach
 * the agent as an empty answer — the failure the question card exists to
 * prevent — so a row blocked on one opens instead (matches the web strip).
 */
const ASK_USER_QUESTION = 'AskUserQuestion';

/** The short word under a row's name for the states its badge cannot tell apart. */
const STATE_LABEL: Partial<Record<ThreadRowState, string>> = {
  permission: 'needs approval',
  question: 'question for you',
  report: 'report',
};

/**
 * The Conversation | Chats switch at the top of the Manager chat. Renders
 * nothing on any other chat. The screen owns the value: it hides (rather than
 * unmounts) the conversation while Chats is showing, so the transcript's
 * scroll position and the composer draft survive a round trip.
 */
export function ManagerSegments({
  chatId,
  value,
  onChange,
}: {
  chatId: string;
  value: ManagerTab;
  onChange: (tab: ManagerTab) => void;
}): React.ReactElement | null {
  if (chatId !== SPECIAL_THREAD_IDS.manager) return null;
  return <SegmentedControl value={value} onChange={onChange} />;
}

function SegmentedControl({
  value,
  onChange,
}: {
  value: ManagerTab;
  onChange: (tab: ManagerTab) => void;
}): React.ReactElement {
  const colors = useTheme();
  const segments: { key: ManagerTab; label: string }[] = [
    { key: 'conversation', label: 'Conversation' },
    { key: 'chats', label: 'Chats' },
  ];
  return (
    <View
      testID="manager-segments"
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        marginHorizontal: space.lg,
        marginVertical: space.sm,
        borderWidth: 1,
        borderColor: colors.divider,
        borderRadius: radii.md,
        backgroundColor: colors.paperRaised,
        padding: 2,
      }}
    >
      {segments.map((s) => {
        const selected = s.key === value;
        return (
          <Pressable
            key={s.key}
            onPress={() => onChange(s.key)}
            accessibilityRole="tab"
            accessibilityLabel={s.label}
            accessibilityState={{ selected }}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: space.sm,
              borderRadius: radii.sm,
              backgroundColor: selected ? colors.leaf : 'transparent',
            }}
          >
            <Text
              style={{
                fontFamily: fonts.bodyBold,
                fontSize: 14,
                color: selected ? colors.onAccent : colors.ink2,
              }}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Send one frame, surfacing a dropped link as an error toast rather than
 * swallowing it — the button must never look like it worked when it did not.
 */
function sendOrReport(send: () => void): boolean {
  try {
    send();
    return true;
  } catch (e) {
    useUiStore.getState().pushError((e as Error).message);
    return false;
  }
}

export function approveThreadPermission(chatId: string, requestId: string): void {
  // Routed through `permissionDeliveryTracker`, not `sendOrReport` — see
  // permissionDeliveryTracker.ts. A dropped send here is invisible on the
  // wire (readyState can lag a dead link), so `sendOrReport`'s throw-based
  // error toast cannot catch it; the tracker redelivers until it observes the
  // host's echo instead.
  permissionDeliveryTracker.send({
    type: 'chat.permission_response',
    chatId,
    requestId,
    approve: true,
    decision: 'approve',
  });
  useChatStore.getState().resolvePermission(chatId, requestId, 'approve');
}

export function stopThread(chatId: string): void {
  sendOrReport(() => getWs().send({ type: 'chat.stop_request', chatId }));
}

export function ManagerChatsList(): React.ReactElement {
  const chats = useChatStore((s) => s.chats);
  const rows = React.useMemo(() => threadRows(chats, Date.now()), [chats]);
  return (
    <FlatList
      testID="manager-chats"
      style={{ flex: 1 }}
      data={rows}
      keyExtractor={(r) => r.chatId}
      renderItem={({ item }) => <ThreadRow row={item} />}
      ListEmptyComponent={
        <EmptyState
          icon={ListChecks}
          title={EMPTY_STATES.managerChats.title}
          body={EMPTY_STATES.managerChats.body}
        />
      }
    />
  );
}

function ThreadRow({ row }: { row: ChatRow }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const hostName = usePresenceStore((s) => s.hosts[row.daemonId]?.host?.hostName ?? row.daemonId);
  const state = threadRowState(row);
  const title = deriveChatTitle(row);
  const permission =
    state === 'permission'
      ? row.pendingPermissions.find((p) => p.tool !== ASK_USER_QUESTION)
      : undefined;
  const label = STATE_LABEL[state];
  const where = [hostName, row.folder].filter((s) => s !== '').join(' · ');
  return (
    <Pressable
      testID={`manager-thread-${row.chatId}`}
      onPress={() => router.push(`/chats/${row.chatId}`)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderBottomWidth: 1,
        borderColor: colors.divider,
      }}
    >
      <View style={{ width: 24, alignItems: 'center', marginRight: space.sm }}>
        <StatusBadge badge={deriveBadge(row)} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: colors.ink }}
        >
          {title}
        </Text>
        {where !== '' ? (
          <Text numberOfLines={1} style={{ ...typography.meta, color: colors.ink3 }}>
            {where}
          </Text>
        ) : null}
        {label ? (
          <Text
            testID={`manager-thread-state-${row.chatId}`}
            style={{ fontFamily: fonts.bodyBold, fontSize: textMin, color: colors.waiting }}
          >
            {label}
          </Text>
        ) : null}
        {row.statusSummary ? (
          <Text
            numberOfLines={2}
            style={{ fontFamily: fonts.body, fontSize: textMin, color: colors.ink2, marginTop: 2 }}
          >
            {row.statusSummary}
          </Text>
        ) : null}
      </View>
      {permission ? (
        <Pressable
          onPress={() => approveThreadPermission(row.chatId, permission.requestId)}
          accessibilityRole="button"
          accessibilityLabel={`Approve ${title}`}
          style={{
            marginLeft: space.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radii.sm,
            backgroundColor: colors.leaf,
          }}
        >
          <Text style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: colors.onAccent }}>
            Approve
          </Text>
        </Pressable>
      ) : null}
      {state === 'working' ? (
        <Pressable
          onPress={() => stopThread(row.chatId)}
          accessibilityRole="button"
          accessibilityLabel={`Stop ${title}`}
          style={{
            marginLeft: space.sm,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radii.sm,
            borderWidth: 1,
            borderColor: colors.divider,
          }}
        >
          <Square size={12} color={colors.ink} />
          <Text
            style={{
              fontFamily: fonts.bodyBold,
              fontSize: 14,
              color: colors.ink,
              marginLeft: space.xs,
            }}
          >
            Stop
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}
