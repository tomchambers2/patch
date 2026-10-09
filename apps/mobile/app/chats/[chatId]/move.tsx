// Move page — move a chat to another machine (spec/04 § Moving a chat to
// another host, spec/15 § Chat detail → Move to…), reached from the chat's ⋯
// menu. Pick the machine, then the folder the chat will run in there: that
// machine's own folders are listed, the one with the same name as the chat's
// current folder chosen first, and any path can be typed. The chat stays where
// it is until the server says it has arrived; a refusal stays on this page
// with the reason.

import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { defaultMoveFolder } from '@patch/wire';
import { api, ApiError } from '../../../src/api/rest';
import { useChatStore } from '../../../src/stores/chatStore';
import { useFolderStore } from '../../../src/stores/folderStore';
import { usePresenceStore, type HostPresence } from '../../../src/stores/presenceStore';
import { useGoBack } from '../../../src/lib/goBack';
import { space, typography, useTheme } from '../../../src/lib/theme';

function hostName(h: HostPresence): string {
  return h.host?.hostName ?? h.daemonId;
}

export default function ChatMoveScreen(): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ chatId: string }>();
  const chatId = typeof params.chatId === 'string' ? params.chatId : '';
  const goBack = useGoBack(`/chats/${chatId}`);
  const row = useChatStore((s) => s.chats[chatId]);
  const hosts = usePresenceStore((s) => s.hosts);
  const byHost = useFolderStore((s) => s.byHost);

  const targets = useMemo(
    () =>
      Object.values(hosts)
        .filter((h) => h.daemonId !== row?.daemonId)
        .sort((a, b) => hostName(a).localeCompare(hostName(b))),
    [hosts, row?.daemonId],
  );
  const [daemonId, setDaemonId] = useState<string | null>(
    () => targets.find((h) => h.online)?.daemonId ?? null,
  );
  const folders = useMemo(() => {
    const f = daemonId ? byHost[daemonId] : undefined;
    return [...new Set([...(f?.roots ?? []), ...(f?.recent ?? [])])];
  }, [byHost, daemonId]);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  // A new machine offers its own folder — never the path typed for another one.
  useEffect(() => {
    setFolder(row ? (defaultMoveFolder(row.folder, folders) ?? '') : '');
    setError(null);
  }, [daemonId, folders, row?.folder]);

  const canMove = daemonId !== null && folder.trim().length > 0 && !moving && row !== undefined;

  async function move(): Promise<void> {
    if (!canMove || daemonId === null) return;
    setMoving(true);
    setError(null);
    try {
      await api.moveChat(chatId, daemonId, folder.trim());
      goBack();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { message?: unknown } | null) : null;
      setError(typeof body?.message === 'string' ? body.message : (e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  if (chatId === '') throw new Error('Move page opened without a chatId');
  const current = row ? hosts[row.daemonId] : undefined;
  return (
    <View testID="move-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
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
        <Text style={{ ...typography.title, color: colors.ink, paddingHorizontal: space.sm }}>
          Move chat
        </Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: space.md,
          gap: space.md,
          // Nothing under the system navigation bar (CLAUDE.md § Android nav bar).
          paddingBottom: space.md + insets.bottom,
        }}
      >
        <Text testID="move-from" style={{ ...typography.meta, color: colors.inkFaint }}>
          {current ? hostName(current) : (row?.daemonId ?? '')} · {row?.folder ?? ''}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {targets.map((h) => {
            const selected = daemonId === h.daemonId;
            return (
              <Pressable
                key={h.daemonId}
                testID={`move-host-${h.daemonId}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !h.online || moving }}
                disabled={!h.online || moving}
                onPress={() => setDaemonId(h.daemonId)}
                style={{
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: selected ? colors.leaf : colors.divider,
                  backgroundColor: selected ? colors.accentTint : 'transparent',
                }}
              >
                <Text
                  style={{ ...typography.label, color: h.online ? colors.ink : colors.inkFaint }}
                >
                  {hostName(h)}
                  {h.online ? '' : ' · offline'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {targets.length === 0 ? (
          <Text testID="move-no-hosts" style={{ ...typography.body, color: colors.ink2 }}>
            No other machine
          </Text>
        ) : null}
        <TextInput
          testID="move-folder"
          value={folder}
          onChangeText={setFolder}
          editable={daemonId !== null && !moving}
          placeholder="Folder on that machine"
          placeholderTextColor={colors.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Folder"
          style={{
            ...typography.secondary,
            color: colors.ink,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: 8,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            backgroundColor: colors.paperRaised,
          }}
        />
        {folders.length > 0 ? (
          <View style={{ gap: space.xs }}>
            {folders.map((f) => (
              <Pressable
                key={f}
                testID={`move-folder-option-${f}`}
                disabled={moving}
                onPress={() => setFolder(f)}
                style={{ paddingVertical: space.sm }}
              >
                <Text
                  style={{
                    ...typography.secondary,
                    color: f === folder.trim() ? colors.leaf : colors.ink2,
                  }}
                >
                  {f}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {error ? (
          <Text
            testID="move-error"
            accessibilityRole="alert"
            style={{ ...typography.secondary, color: colors.red }}
          >
            {error}
          </Text>
        ) : null}
        <Pressable
          testID="move-confirm"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canMove }}
          disabled={!canMove}
          onPress={() => void move()}
          style={{
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingVertical: space.sm,
            paddingHorizontal: space.lg,
            borderRadius: 8,
            backgroundColor: canMove ? colors.leaf : colors.divider,
          }}
        >
          {moving ? <ActivityIndicator size="small" color={colors.onAccent} /> : null}
          <Text style={{ ...typography.label, color: colors.onAccent }}>
            {moving ? 'Moving…' : 'Move'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
