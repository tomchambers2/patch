// One Chats-tab search result (spec/03 § Chat search): the chat's title with
// the matched ranges marked, the matched message's snippet (also marked), and
// a meta line saying where the chat lives — host · section · Automation · age.
// Drawn on the same card as ChatRowItem so results sit in the list's language.
// Tap opens the chat, scrolled to the matched message when its seq is known,
// and clears the search (via the caller's `onPress`) so coming back shows the
// normal list rather than a stale query and results band.

import React from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import type { ChatSearchHit } from '@patch/wire';
import { highlightSegments, hitMetaLine, searchHitRoute } from '../lib/chatSearch';
import { isGeneratedId } from '../lib/labels';
import { fonts, radii, space, typography, useTheme } from '../lib/theme';

function Marked({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}): React.ReactElement {
  const colors = useTheme();
  return (
    <>
      {highlightSegments(text, ranges).map((seg, i) =>
        seg.marked ? (
          <Text
            key={i}
            testID="chat-search-mark"
            style={{
              fontFamily: fonts.bodyBold,
              color: colors.leafSoft,
              backgroundColor: colors.accentTint,
            }}
          >
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </>
  );
}

export function ChatSearchHitRow({
  hit,
  hostName,
  testID,
  onPress,
}: {
  hit: ChatSearchHit;
  hostName: string;
  testID: string;
  /** Called before navigating — e.g. to clear the search so coming back shows the normal list. */
  onPress?: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  // A raw generated id is never a title (spec/04 § Name) — as deriveChatTitle.
  const name = hit.name !== null && !isGeneratedId(hit.name) ? hit.name : null;
  const title = name ?? hit.preview ?? 'New chat';
  return (
    <Pressable
      testID={testID}
      onPress={() => {
        onPress?.();
        router.push(searchHitRoute(hit));
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open chat ${title}`}
      style={{
        marginHorizontal: space.lg,
        marginBottom: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        backgroundColor: colors.paperRaised,
        borderColor: colors.lineSoft,
        borderWidth: 1,
        borderRadius: radii.md,
      }}
    >
      <Text numberOfLines={1} style={{ ...typography.rowTitle, color: colors.ink }}>
        {name !== null ? <Marked text={name} ranges={hit.nameHighlights} /> : title}
      </Text>
      {hit.snippet !== null ? (
        <Text
          testID="chat-search-snippet"
          numberOfLines={2}
          style={{ ...typography.secondary, color: colors.ink2, marginTop: 2 }}
        >
          {hit.snippet.role === 'user' ? <Text style={{ color: colors.ink3 }}>You: </Text> : null}
          <Marked text={hit.snippet.text} ranges={hit.snippet.highlights} />
        </Text>
      ) : null}
      <Text numberOfLines={1} style={{ ...typography.meta, color: colors.ink3, marginTop: 2 }}>
        {hitMetaLine(hit, hostName)}
        {hit.messageMatches > 1 ? ` · +${hit.messageMatches - 1} more` : ''}
      </Text>
    </Pressable>
  );
}
