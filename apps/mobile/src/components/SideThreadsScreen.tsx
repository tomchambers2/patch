// Side threads screen (spec/15 § Side threads screen) — mobile's equivalent
// of the web/desktop Threads panel. Mobile "stays the single view it has
// always been" (spec/04 § Branching), so a side thread opens as its OWN
// SCREEN rather than a docked panel: a tab strip across the top, Back to the
// main chat, and one tab active at a time — each tab a small chat of its own
// (transcript from the fork point on, its own composer, stop, send back).
//
// A side branch's content is pull-based (spec/04 § Parallel branches — not
// broadcast live), so the active tab polls `GET /api/chats/:id/history`
// while its branch is `running`, same as the web panel.

import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatBranch } from '@patch/wire';
import { useChatStore } from '../stores/chatStore';
import type { PendingPermission } from '../stores/types';
import {
  useSideThreadsStore,
  DRAFT_TAB_ID,
  type SideThreadDraft,
} from '../stores/sideThreadsStore';
import {
  startSideThread,
  sendToBranch,
  stopBranch,
  sendBackToChat,
  openSideThreadDraft,
} from '../lib/sideThreadActions';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker';
import { api } from '../api/rest';
import { useGoBack } from '../lib/goBack';
import { ChatMarkdown } from './ChatMarkdown';
import { fonts, radii, space, textMin, typography, useTheme } from '../lib/theme';

interface BranchHistoryEvent {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function useBranchHistory(
  chatId: string,
  branchId: string,
  running: boolean,
): BranchHistoryEvent[] {
  const [events, setEvents] = React.useState<BranchHistoryEvent[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api.getChatHistory(chatId, { branchId }).then((r) => {
        if (!cancelled) setEvents(r.events as unknown as BranchHistoryEvent[]);
      });
    };
    load();
    if (!running)
      return () => {
        cancelled = true;
      };
    const t = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [chatId, branchId, running]);
  return events;
}

function StatusDot({ color }: { color: string }): React.ReactElement {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />;
}

export function SideThreadsScreen({ chatId }: { chatId: string }): React.ReactElement {
  const colors = useTheme();
  const goBack = useGoBack(`/chats/${chatId}`);
  const branchGraph = useChatStore((s) => s.branchGraphs[chatId]);
  const draft = useSideThreadsStore((s) => s.draftByChatId[chatId]);
  const activeTabId = useSideThreadsStore((s) => s.activeTabByChatId[chatId]);
  const setActiveTab = useSideThreadsStore((s) => s.setActiveTab);
  const pendingNewTab = useSideThreadsStore((s) => s.pendingNewTab[chatId] ?? false);
  const openThread = useSideThreadsStore((s) => s.openThread);

  const sideBranches = (branchGraph?.branches ?? []).filter((b) => b.sideThread);

  // spec/15 § TRIGGER — the host mints the new branch's id, so the trigger
  // can only ARM an expectation; this reconciler opens the tab once
  // `chat.branches` reports the real branch. Mirrors web's SideThreadsPanel.
  const seenRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const ids = sideBranches.map((b) => b.branchId);
    const seen = seenRef.current;
    seenRef.current = new Set(ids);
    if (seen === null || !pendingNewTab) return;
    const newId = ids.find((id) => !seen.has(id));
    if (newId) openThread(chatId, newId);
  }, [chatId, sideBranches.map((b) => b.branchId).join(','), pendingNewTab, openThread]);

  const tabIds = draft
    ? [...sideBranches.map((b) => b.branchId), DRAFT_TAB_ID]
    : sideBranches.map((b) => b.branchId);
  const resolvedActive =
    activeTabId !== undefined && tabIds.includes(activeTabId)
      ? activeTabId
      : (tabIds[tabIds.length - 1] ?? null);
  const activeBranch = sideBranches.find((b) => b.branchId === resolvedActive);

  return (
    <View testID="side-threads-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
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
          accessibilityLabel="Back to the main chat"
          testID="side-threads-back"
        >
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text style={{ ...typography.title, color: colors.ink, paddingHorizontal: space.sm }}>
          Threads
        </Text>
      </View>
      <ScrollView
        horizontal
        testID="side-threads-tabs"
        showsHorizontalScrollIndicator={false}
        style={{
          flexGrow: 0,
          borderBottomWidth: 1,
          borderColor: colors.divider,
          backgroundColor: colors.paperRaised,
        }}
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
      >
        {sideBranches.map((b) => (
          <ThreadTab
            key={b.branchId}
            chatId={chatId}
            branch={b}
            active={resolvedActive === b.branchId}
            onPress={() => setActiveTab(chatId, b.branchId)}
          />
        ))}
        {draft ? (
          <Pressable
            testID="side-threads-tab-draft"
            onPress={() => setActiveTab(chatId, DRAFT_TAB_ID)}
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radii.md,
              backgroundColor: resolvedActive === DRAFT_TAB_ID ? colors.accentTint : 'transparent',
            }}
          >
            <Text style={{ color: colors.ink2, fontFamily: fonts.body, fontSize: 14 }}>
              New thread
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
      {resolvedActive === DRAFT_TAB_ID && draft ? (
        <DraftPane chatId={chatId} draft={draft} />
      ) : activeBranch ? (
        <ThreadPane chatId={chatId} branch={activeBranch} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.ink3 }}>No side threads yet</Text>
        </View>
      )}
    </View>
  );
}

function ThreadTab({
  chatId,
  branch,
  active,
  onPress,
}: {
  chatId: string;
  branch: ChatBranch;
  active: boolean;
  onPress: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const needsYou =
    (useChatStore((s) => s.sideThreadPermissions[`${chatId}::${branch.branchId}`])?.length ?? 0) >
    0;
  const dotColor = needsYou || branch.running ? colors.waiting : colors.ink3;
  return (
    <Pressable
      testID={`side-threads-tab-${branch.branchId}`}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        backgroundColor: active ? colors.accentTint : 'transparent',
      }}
    >
      <StatusDot color={dotColor} />
      <Text style={{ color: colors.ink, fontFamily: fonts.body, fontSize: 14 }} numberOfLines={1}>
        {branch.name ?? branch.label}
      </Text>
    </Pressable>
  );
}

function DraftPane({
  chatId,
  draft,
}: {
  chatId: string;
  draft: SideThreadDraft;
}): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = React.useState('');
  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    startSideThread(chatId, draft.seq, trimmed, draft.fromBranchId);
  };
  return (
    <View style={{ flex: 1 }}>
      <Text
        testID="side-threads-draft-quote"
        style={{ margin: space.md, color: colors.ink3, fontSize: textMin }}
      >
        {`Off "${draft.quotedMessage.slice(0, 90)}"`}
      </Text>
      <View style={{ flex: 1 }} />
      <View
        testID="side-threads-draft-footer"
        style={{
          flexDirection: 'row',
          padding: space.md,
          paddingBottom: space.md + insets.bottom,
          gap: space.sm,
        }}
      >
        <TextInput
          testID="side-threads-draft-composer"
          autoFocus
          value={text}
          onChangeText={setText}
          placeholder="Ask a side question…"
          placeholderTextColor={colors.inkFaint}
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: radii.md,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            color: colors.ink,
            backgroundColor: colors.paperRaised,
          }}
        />
        <Pressable
          testID="side-threads-draft-send"
          onPress={send}
          style={{
            backgroundColor: colors.leaf,
            borderRadius: radii.md,
            paddingHorizontal: space.lg,
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyBold }}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ThreadPane({
  chatId,
  branch,
}: {
  chatId: string;
  branch: ChatBranch;
}): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const branchId = branch.branchId;
  const events = useBranchHistory(chatId, branchId, branch.running === true);
  const mainTimeline = useChatStore((s) => s.timelines[chatId]);
  const branchGraph = useChatStore((s) => s.branchGraphs[chatId]);
  const permissions = useChatStore(
    (s) => s.sideThreadPermissions[`${chatId}::${branchId}`] ?? EMPTY_PERMISSIONS,
  );
  const resolveSideThreadPermission = useChatStore((s) => s.resolveSideThreadPermission);
  const [text, setText] = React.useState('');

  const quoted =
    branch.forkFromSeq === null
      ? null
      : branch.parentBranchId === branchGraph?.activeBranchId
        ? ((mainTimeline ?? []).find((e) => e.seq === branch.forkFromSeq)?.content ?? null)
        : null;

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    sendToBranch(chatId, branchId, trimmed);
    setText('');
  };

  return (
    <View style={{ flex: 1 }} testID={`side-threads-pane-${branchId}`}>
      {quoted !== null ? (
        <Text style={{ margin: space.md, marginBottom: 0, color: colors.ink3, fontSize: textMin }}>
          {`Off "${quoted.slice(0, 90)}"`}
        </Text>
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md }}>
        {events.length === 0 ? <ActivityIndicator color={colors.ink3} /> : null}
        {events.map((e) => (
          <Pressable
            key={e.seq}
            testID={`side-threads-msg-${e.seq}`}
            onLongPress={() => openSideThreadDraft(chatId, e.seq, e.content, branchId)}
            delayLongPress={350}
            style={{
              alignSelf: e.role === 'user' ? 'flex-end' : 'stretch',
              maxWidth: e.role === 'user' ? '85%' : '100%',
              marginBottom: space.sm,
              backgroundColor: e.role === 'user' ? colors.accentTint : undefined,
              borderRadius: e.role === 'user' ? radii.lg : 0,
              paddingHorizontal: e.role === 'user' ? space.md : 0,
              paddingVertical: e.role === 'user' ? space.sm : 0,
            }}
          >
            <ChatMarkdown content={e.content} color={colors.ink} selectable={false} />
          </Pressable>
        ))}
        {permissions.map((p) => (
          <View
            key={p.requestId}
            testID="side-threads-permission-card"
            style={{
              backgroundColor: colors.waitingTint,
              borderRadius: radii.md,
              padding: space.md,
              marginBottom: space.sm,
            }}
          >
            <Text style={{ fontFamily: fonts.bodyBold, color: colors.ink }}>{p.tool}</Text>
            {p.description ? (
              <Text style={{ color: colors.ink2, marginTop: 2 }}>{p.description}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
              <Pressable
                testID="side-threads-permission-deny"
                onPress={() => {
                  permissionDeliveryTracker.send({
                    type: 'chat.permission_response',
                    chatId,
                    requestId: p.requestId,
                    approve: false,
                  });
                  resolveSideThreadPermission(chatId, branchId, p.requestId);
                }}
                style={{
                  borderWidth: 1,
                  borderColor: colors.divider,
                  borderRadius: radii.sm,
                  paddingHorizontal: space.md,
                  paddingVertical: space.xs,
                }}
              >
                <Text style={{ color: colors.ink }}>Deny</Text>
              </Pressable>
              <Pressable
                testID="side-threads-permission-approve"
                onPress={() => {
                  permissionDeliveryTracker.send({
                    type: 'chat.permission_response',
                    chatId,
                    requestId: p.requestId,
                    approve: true,
                  });
                  resolveSideThreadPermission(chatId, branchId, p.requestId);
                }}
                style={{
                  backgroundColor: colors.leaf,
                  borderRadius: radii.sm,
                  paddingHorizontal: space.md,
                  paddingVertical: space.xs,
                }}
              >
                <Text style={{ color: colors.onAccent }}>Approve</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
      <View
        testID={`side-threads-footer-${branchId}`}
        style={{ paddingBottom: insets.bottom, borderTopWidth: 1, borderColor: colors.divider }}
      >
        <View style={{ flexDirection: 'row', padding: space.sm, gap: space.sm }}>
          {branch.running ? (
            <Pressable
              testID="side-threads-stop"
              onPress={() => stopBranch(chatId, branchId)}
              style={{
                borderWidth: 1,
                borderColor: colors.divider,
                borderRadius: radii.md,
                paddingHorizontal: space.md,
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: colors.red }}>Stop</Text>
            </Pressable>
          ) : null}
          <Pressable
            testID="side-threads-send-back"
            disabled={branch.sentBack === true}
            onPress={() => sendBackToChat(chatId, branchId)}
            style={{
              borderWidth: 1,
              borderColor: colors.divider,
              borderRadius: radii.md,
              paddingHorizontal: space.md,
              justifyContent: 'center',
              opacity: branch.sentBack ? 0.5 : 1,
            }}
          >
            <Text style={{ color: colors.leafSoft }}>
              {branch.sentBack ? 'Sent back' : 'Send back to chat'}
            </Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', padding: space.md, paddingTop: 0, gap: space.sm }}>
          <TextInput
            testID={`side-threads-composer-${branchId}`}
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={colors.inkFaint}
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: colors.divider,
              borderRadius: radii.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              color: colors.ink,
              backgroundColor: colors.paperRaised,
            }}
          />
          <Pressable
            testID={`side-threads-send-${branchId}`}
            onPress={send}
            style={{
              backgroundColor: colors.leaf,
              borderRadius: radii.md,
              paddingHorizontal: space.lg,
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyBold }}>Send</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// A selector returning `x ?? []` hands zustand's `useSyncExternalStore` a
// FRESH array identity every render even when nothing changed, which never
// settles and re-renders forever — share one empty array instead.
const EMPTY_PERMISSIONS: PendingPermission[] = [];
