// Batch view (spec/15 § Batch view; spec/14-design-web.md § Batch mode) — the
// view dropdown's `Batch` option body. The batch is server-owned (same
// account-wide batch web's sidebar shows); this renders whatever
// `batchStore` last polled. Before check-in, members are marked only
// "waiting" — no status badge. From check-in on, real status badges show,
// done first.

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Layers, X } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useChatStore } from '../stores/chatStore';
import { useBatchStore } from '../stores/batchStore';
import type { BatchCheckInChoice } from '../api/rest';
import { StatusBadge } from './StatusBadge';
import { deriveBadge } from '../stores/types';
import { EmptyState } from './EmptyState';
import { EMPTY_STATES } from '../lib/emptyStates';
import { deriveChatTitle } from '../lib/labels';
import { space, typography, useTheme } from '../lib/theme';

const CHECK_IN_CHOICES: { label: string; choice: BatchCheckInChoice }[] = [
  { label: '15 min', choice: { type: 'time', minutes: 15 } },
  { label: '20 min', choice: { type: 'time', minutes: 20 } },
  { label: '30 min', choice: { type: 'time', minutes: 30 } },
  { label: 'When all done', choice: { type: 'all-done' } },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function BatchView(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const chats = useChatStore((s) => s.chats);
  const batch = useBatchStore((s) => s.batch);
  const removeMember = useBatchStore((s) => s.removeMember);
  const checkInNow = useBatchStore((s) => s.checkInNow);
  const start = useBatchStore((s) => s.start);

  const rows = React.useMemo(() => {
    if (!batch) return [];
    const withRow = batch.members.map((chatId) => ({ chatId, row: chats[chatId] }));
    if (!batch.checkedIn) return withRow;
    return [...withRow].sort((a, b) => {
      const aWorking = a.row ? deriveBadge(a.row) === 'working' : false;
      const bWorking = b.row ? deriveBadge(b.row) === 'working' : false;
      return aWorking === bWorking ? 0 : aWorking ? 1 : -1;
    });
  }, [batch, chats]);

  if (!batch) {
    return (
      <ScrollView testID="batch-view" style={{ flex: 1 }}>
        <EmptyState icon={Layers} title={EMPTY_STATES.batch.title} body={EMPTY_STATES.batch.body} />
        <View
          testID="batch-start"
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg }}
        >
          {CHECK_IN_CHOICES.map(({ label, choice }) => (
            <Pressable
              key={label}
              testID={`batch-start-${choice.type === 'time' ? choice.minutes : 'all-done'}`}
              accessibilityRole="button"
              onPress={() => void start(choice)}
              style={{
                paddingVertical: space.sm,
                paddingHorizontal: space.md,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: colors.divider,
                backgroundColor: colors.bgElevated,
              }}
            >
              <Text style={{ ...typography.label, color: colors.ink }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  const checkInLabel =
    batch.checkIn.type === 'all-done'
      ? `Check in when all done (by ${formatTime(batch.checkInAt)})`
      : `Check in at ${formatTime(batch.checkInAt)}`;

  return (
    <ScrollView testID="batch-view" style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
        }}
      >
        <Text testID="batch-checkin-time" style={{ ...typography.meta, color: colors.ink3 }}>
          {batch.checkedIn ? `Checked in — ${checkInLabel}` : checkInLabel}
        </Text>
        {!batch.checkedIn ? (
          <Pressable
            testID="batch-checkin-now"
            accessibilityRole="button"
            onPress={() => void checkInNow()}
            hitSlop={10}
          >
            <Text style={{ ...typography.label, color: colors.leaf }}>Check in now</Text>
          </Pressable>
        ) : null}
      </View>
      {rows.map(({ chatId, row }) => (
        <Pressable
          key={chatId}
          testID={`batch-row-${chatId}`}
          accessibilityRole="button"
          onPress={() => router.push(`/chats/${chatId}`)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
            gap: space.sm,
          }}
        >
          {batch.checkedIn && row ? <StatusBadge badge={deriveBadge(row)} /> : null}
          <Text style={{ ...typography.body, color: colors.ink, flex: 1 }}>
            {deriveChatTitle({ name: row?.name ?? null, chatId, folder: row?.folder ?? '' })}
          </Text>
          {!batch.checkedIn ? (
            <Text style={{ ...typography.meta, color: colors.ink3 }}>waiting</Text>
          ) : null}
          <Pressable
            testID={`batch-remove-${chatId}`}
            accessibilityRole="button"
            accessibilityLabel="remove from batch"
            onPress={() => void removeMember(chatId)}
            hitSlop={10}
          >
            <X size={16} color={colors.ink3} />
          </Pressable>
        </Pressable>
      ))}
    </ScrollView>
  );
}
