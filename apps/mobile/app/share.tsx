// Share-sheet destination picker (spec/15 § Share into Patch). Reached only
// via app/_layout.tsx routing on a shareStore update (src/lib/nativeShare.ts);
// there is no other way in, so a null `pending` here means the payload was
// already handed off (a destination was picked) or the screen was somehow
// opened stale — either way there is nothing to show, and we render nothing
// rather than guess.
//
// A share is text, one or more images/files, or both. Nothing is ever
// auto-sent: the text lands in the destination's composer as an editable
// draft (added to anything already typed there) and each file as an ordinary
// attachment chip — the same chip the composer's own pickers make, uploaded
// by the composer's own path when the user presses Send. The destination is
// a new chat (the new-chat screen's composer) or an existing chat, found by
// scrolling or by the search field over the list.

import React from 'react';
import { FlatList, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft, FileText, MessageCirclePlus, Search } from 'lucide-react-native';
import { useChatStore } from '../src/stores/chatStore';
import { useShareStore } from '../src/stores/shareStore';
import { handShareToComposer, shareableChats } from '../src/lib/sharePicker';
import { filterChats } from '../src/lib/chatFilter';
import { NEW_CHAT_DRAFT_KEY } from '../src/lib/newChat';
import { deriveChatTitle } from '../src/lib/labels';
import { fonts, radii, space, textMin, typography, useTheme } from '../src/lib/theme';
import type { ChatRow } from '../src/stores/types';

export default function Share(): React.ReactElement | null {
  const router = useRouter();
  const colors = useTheme();
  const pending = useShareStore((s) => s.pending);
  const chats = useChatStore((s) => s.chats);
  const [query, setQuery] = React.useState('');
  const destinations = React.useMemo(
    () => filterChats(shareableChats(chats), query),
    [chats, query],
  );

  if (pending === null) return null;

  const cancel = (): void => {
    useShareStore.getState().clear();
    router.replace('/(tabs)/chats');
  };

  const sendToNewChat = (): void => {
    handShareToComposer(NEW_CHAT_DRAFT_KEY, pending);
    useShareStore.getState().clear();
    router.replace('/new-chat');
  };

  const sendToChat = (chatId: string): void => {
    handShareToComposer(chatId, pending);
    useShareStore.getState().clear();
    router.replace(`/chats/${chatId}`);
  };

  const renderRow = ({ item }: { item: ChatRow }): React.ReactElement => (
    <Pressable
      onPress={() => sendToChat(item.chatId)}
      testID={`share-chat-option-${item.chatId}`}
      style={({ pressed }) => ({
        paddingVertical: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: pressed ? colors.accentTint : 'transparent',
      })}
    >
      <Text style={{ color: colors.ink }} numberOfLines={1}>
        {deriveChatTitle(item)}
      </Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, paddingTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md }}>
        <Pressable onPress={cancel} style={{ padding: space.sm }} accessibilityLabel="Cancel">
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text numberOfLines={1} style={{ ...typography.title, color: colors.ink, flex: 1 }}>
          Share to Patch
        </Text>
      </View>

      {/* What is being shared, so the user knows before picking where it goes. */}
      {pending.text !== null ? (
        <View style={{ paddingHorizontal: space.lg, marginTop: space.sm }}>
          <ScrollView
            style={{ maxHeight: 96, borderRadius: radii.md, backgroundColor: colors.accentTint }}
          >
            <Text testID="share-text" style={{ color: colors.ink2, padding: space.md }}>
              {pending.text}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      {pending.files.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: space.sm, flexGrow: 0 }}
          contentContainerStyle={{ gap: space.xs, paddingHorizontal: space.lg }}
        >
          {pending.files.map((f) => (
            <View
              key={f.uri}
              testID={`share-file-${f.name}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.xs,
                paddingHorizontal: space.xs,
                paddingVertical: 4,
                borderRadius: radii.sm,
                borderWidth: 1,
                borderColor: colors.divider,
                backgroundColor: colors.paperRaised,
                maxWidth: 200,
              }}
            >
              {f.kind === 'image' ? (
                <Image source={{ uri: f.uri }} style={{ width: 36, height: 36, borderRadius: 4 }} />
              ) : (
                <FileText size={18} color={colors.ink2} />
              )}
              <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, flexShrink: 1 }}>
                {f.name}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <Pressable
        onPress={sendToNewChat}
        testID="share-new-chat"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          marginTop: space.md,
          marginHorizontal: space.lg,
          paddingVertical: space.sm,
          paddingHorizontal: space.md,
          borderRadius: radii.md,
          backgroundColor: pressed ? colors.accentSoft : colors.accentTint,
        })}
      >
        <MessageCirclePlus size={16} color={colors.leaf} />
        <Text style={{ color: colors.leaf, marginLeft: space.sm, fontFamily: fonts.bodyBold }}>
          Start a new chat
        </Text>
      </Pressable>

      <View style={{ paddingHorizontal: space.lg, marginTop: space.lg, marginBottom: space.xs }}>
        <Text style={{ color: colors.ink3, fontSize: textMin }}>Or send to an existing chat</Text>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.xs,
          marginHorizontal: space.lg,
          marginBottom: space.xs,
          paddingHorizontal: space.sm,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.divider,
          backgroundColor: colors.paperRaised,
        }}
      >
        <Search size={16} color={colors.ink3} />
        <TextInput
          testID="share-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="Search chats"
          returnKeyType="search"
          style={{ flex: 1, color: colors.ink, fontSize: 15, paddingVertical: space.sm }}
        />
      </View>

      {destinations.length === 0 ? (
        <Text
          testID="share-no-chats"
          style={{ color: colors.ink3, paddingHorizontal: space.lg, fontSize: 13 }}
        >
          {query.trim() === '' ? 'No chats yet.' : 'No chats match.'}
        </Text>
      ) : (
        <FlatList
          data={destinations}
          keyExtractor={(row) => row.chatId}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.xl }}
        />
      )}
    </View>
  );
}
