// Single chat row in the Chats tab.
//   - Tap        → open chat detail.
//   - ⋯ menu     → row actions sheet (Pin / Snooze / Archive / Send voice
//                  note / Delete), per spec/15 § Row tools. Long-press opens
//                  the same sheet as a secondary affordance.
//   - Swipe      → reveals the same Pin / Snooze / Archive actions as a
//                  three-button tray, either edge (Show in Pin's place on a
//                  hidden chat, spec/04 § Hidden). Re-added alongside the
//                  ⋯/long-press sheet (not instead of it — Delete and "Send
//                  voice note" stay sheet-only) via `toggleArchive`/
//                  `togglePin`/`applySnooze`, the exact functions the sheet's
//                  own Items call, so a swipe and a sheet tap do the same
//                  thing rather than being two competing implementations.
//
// No react-native-gesture-handler dependency: this codebase already solves
// its one other real gesture (ZoomableImageViewer's pinch/pan) with plain
// PanResponder + Animated, so the swipe tray follows the same convention
// rather than introducing a new native module.

import React from 'react';
import { Animated, PanResponder, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  Eye,
  PackageOpen,
  MoreHorizontal,
  Pin,
} from 'lucide-react-native';
import type { ChatRow as ChatRowT } from '../stores/types';
import { deriveBadge, isHidden, isSnoozed } from '../stores/types';
import { StatusBadge } from './StatusBadge';
import { previewLine } from '../lib/badge';
import { deriveChatTitle } from '../lib/labels';
import { formatWakeTime, formatWakeTimeCompact } from '../lib/snooze';
import { radii, space, typography, useTheme } from '../lib/theme';
import { useChatStore } from '../stores/chatStore';
import {
  applySnooze,
  showChatLongPressSheet,
  showChatSnoozeSheet,
  showHiddenChat,
  toggleArchive,
  togglePin,
} from './ChatLongPressSheet';

interface Props {
  row: ChatRowT;
}

// How long a row's preview must be QUIET before we show its new value.
const PREVIEW_SETTLE_MS = 250;

// Settle the row preview. On load / reconnect the host replays a burst of
// events per chat (chat.replay), and every chat.message rewrites the row
// preview — so a row would otherwise "flick" through every intermediate
// message as it catches up. We hold the displayed preview steady until updates
// for this row have been quiet for PREVIEW_SETTLE_MS, so the row lands on its
// SETTLED latest preview instead of animating through history. A single live
// message just costs one settle delay, which is imperceptible.
export function useSettledPreview(row: ChatRowT): string {
  const target = previewLine(row);
  const [shown, setShown] = React.useState(target);
  React.useEffect(() => {
    if (target === shown) return;
    const t = setTimeout(() => setShown(target), PREVIEW_SETTLE_MS);
    return () => clearTimeout(t);
  }, [target, shown]);
  return shown;
}

// Width of ONE tray button. Three buttons (Pin, Snooze, Archive) means a full
// reveal is 3 * TRAY_BUTTON_WIDTH either side.
const TRAY_BUTTON_WIDTH = 56;
const TRAY_WIDTH = TRAY_BUTTON_WIDTH * 3;
// Fraction of TRAY_WIDTH a release must have crossed to snap open rather than
// spring back closed.
const OPEN_THRESHOLD = TRAY_WIDTH * 0.4;

function TrayButton({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: TRAY_BUTTON_WIDTH,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.paperRaised,
      }}
    >
      {icon}
    </Pressable>
  );
}

export function ChatRowItem({ row }: Props): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const badge = deriveBadge(row);

  const activeId = useChatStore((s) => s.activeChatId);
  const isActive = activeId === row.chatId;

  const preview = useSettledPreview(row);

  // Swipe-to-reveal (spec/15 § Row tools — re-added alongside the ⋯/long-press
  // sheet, not instead of it). `translateX` slides the row itself; the tray
  // behind it is always mounted at both edges but only reachable once the row
  // has slid clear, since the row sits on top and blocks touches at 0.
  const translateX = React.useRef(new Animated.Value(0)).current;
  const dragStartX = React.useRef(0);
  const closeTray = React.useCallback((): void => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
  }, [translateX]);
  const panResponder = React.useRef(
    PanResponder.create({
      // A vertical drag must reach the FlatList untouched — only claim the
      // gesture once the motion is clearly more horizontal than vertical, and
      // only past a small deadzone so an ordinary tap never gets misread as a
      // swipe attempt.
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => {
        dragStartX.current = 0;
        translateX.stopAnimation((value) => {
          dragStartX.current = value;
        });
      },
      onPanResponderMove: (_e, g) => {
        const next = dragStartX.current + g.dx;
        translateX.setValue(Math.max(-TRAY_WIDTH, Math.min(TRAY_WIDTH, next)));
      },
      onPanResponderRelease: (_e, g) => {
        const next = dragStartX.current + g.dx;
        if (next <= -OPEN_THRESHOLD) {
          Animated.spring(translateX, { toValue: -TRAY_WIDTH, useNativeDriver: true }).start();
        } else if (next >= OPEN_THRESHOLD) {
          Animated.spring(translateX, { toValue: TRAY_WIDTH, useNativeDriver: true }).start();
        } else {
          closeTray();
        }
      },
    }),
  ).current;

  const trayButtons = (
    <>
      {/* A hidden row's first slot is Show: it is what the Hidden section is
          for, and pinning a chat that stays hidden changes nothing visible. */}
      {isHidden(row) ? (
        <TrayButton
          icon={<Eye size={20} color={colors.ink2} />}
          label="Show chat"
          onPress={() => {
            closeTray();
            showHiddenChat(row.chatId);
          }}
        />
      ) : (
        <TrayButton
          icon={<Pin size={20} color={colors.ink2} />}
          label={row.pinned ? 'Unpin chat' : 'Pin chat'}
          onPress={() => {
            closeTray();
            togglePin(row);
          }}
        />
      )}
      <TrayButton
        icon={
          isSnoozed(row) ? (
            <AlarmClockOff size={20} color={colors.ink2} />
          ) : (
            <AlarmClock size={20} color={colors.ink2} />
          )
        }
        label={isSnoozed(row) ? 'Unsnooze chat' : 'Snooze chat'}
        onPress={() => {
          closeTray();
          if (isSnoozed(row)) applySnooze(row.chatId, null);
          else showChatSnoozeSheet(row);
        }}
      />
      <TrayButton
        icon={
          row.status === 'archived' ? (
            <PackageOpen size={20} color={colors.ink2} />
          ) : (
            <Archive size={20} color={colors.ink2} />
          )
        }
        label={row.status === 'archived' ? 'Unarchive chat' : 'Archive chat'}
        onPress={() => {
          closeTray();
          toggleArchive(row);
        }}
      />
    </>
  );

  return (
    <View style={{ marginHorizontal: space.lg, marginBottom: space.sm }}>
      {/* Trays sit UNDER the row (rendered first) at both edges; the row on
          top only lets them show once it has slid clear. */}
      <View
        testID="swipe-tray-left"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: TRAY_WIDTH,
          flexDirection: 'row',
          borderRadius: radii.md,
          overflow: 'hidden',
        }}
      >
        {trayButtons}
      </View>
      <View
        testID="swipe-tray-right"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: TRAY_WIDTH,
          flexDirection: 'row',
          borderRadius: radii.md,
          overflow: 'hidden',
        }}
      >
        {trayButtons}
      </View>
      <Animated.View
        testID="chat-row-surface"
        {...panResponder.panHandlers}
        style={{
          transform: [{ translateX }],
          paddingHorizontal: space.md,
          paddingVertical: space.md,
          flexDirection: 'row',
          alignItems: 'center',
          // Desktop's row: a soft card on the paper, a hairline rather than a
          // drawn box, and the accent tint (not a hard green outline) when active.
          backgroundColor: isActive ? colors.accentTint : colors.paperRaised,
          borderColor: isActive ? colors.accentSoft : colors.lineSoft,
          borderWidth: 1,
          borderRadius: radii.md,
        }}
      >
        <Pressable
          onPress={() => router.push(`/chats/${row.chatId}`)}
          onLongPress={() => showChatLongPressSheet(row)}
          delayLongPress={350}
          style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
          accessibilityRole="button"
          accessibilityLabel={`Open chat ${deriveChatTitle(row)}`}
        >
          <StatusBadge badge={badge} />
          <View style={{ flex: 1, marginLeft: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {row.pinned ? (
                <View style={{ marginRight: space.xs }}>
                  <Pin size={12} color={colors.ink3} />
                </View>
              ) : null}
              <Text
                numberOfLines={1}
                style={{
                  ...typography.rowTitle,
                  color: badge === 'read' ? colors.ink3 : colors.ink,
                  flexShrink: 1,
                }}
              >
                {deriveChatTitle(row)}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              style={{ ...typography.meta, color: colors.ink3, marginTop: 2 }}
            >
              {preview}
            </Text>
          </View>
        </Pressable>

        {/* Wake time, in the row's right-hand timestamp slot. A snoozed row is
            only ever drawn in the Snoozed section (spec/15 ## Chats tab §6), so
            this is that section's wake time — compact, with no extra line. */}
        {row.snoozedUntil !== null && isSnoozed(row) ? (
          <View
            testID={`wake-time-${row.chatId}`}
            accessibilityLabel={`Snoozed until ${formatWakeTime(row.snoozedUntil)}`}
            style={{ flexDirection: 'row', alignItems: 'center', marginLeft: space.sm }}
          >
            <AlarmClock size={12} color={colors.ink3} />
            <Text style={{ ...typography.meta, marginLeft: space.xs, color: colors.ink3 }}>
              {formatWakeTimeCompact(row.snoozedUntil)}
            </Text>
          </View>
        ) : null}

        {/* Row actions (⋯) — Pin / Snooze / Archive / Send voice note / Delete.
            Opens the same sheet as long-press, so every action is reachable
            without the swipe gesture too. */}
        <Pressable
          onPress={() => showChatLongPressSheet(row)}
          hitSlop={10}
          style={({ pressed }) => ({
            marginLeft: space.sm,
            paddingHorizontal: space.xs,
            paddingVertical: space.sm,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.5 : 1,
          })}
          accessibilityRole="button"
          accessibilityLabel={`Chat actions for ${deriveChatTitle(row)}`}
        >
          <MoreHorizontal size={20} color={colors.ink3} />
        </Pressable>
      </Animated.View>
    </View>
  );
}
