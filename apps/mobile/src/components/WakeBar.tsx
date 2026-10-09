// WakeBar — shows the chat's pending self-wake above the transcript
// (spec/02 § Self-wake; spec/15 § Chat detail). Mirrors the web WakeBar
// (packages/web/src/components/WakeBar.tsx).
//
// A pending wake is a scheduled FUTURE TURN in this chat, so it must never be
// invisible — this bar is the readout: a live countdown to `fireAt` plus the
// message the wake will deliver. On the phone this matters more than on
// desktop: the chat isn't left open on screen the way a browser tab can be,
// so the bar is what gives confidence a scheduled wake wasn't forgotten
// between opens.
//
// Tapping the bar opens the whole message in a modal. A one-shot wake stays
// read-only there — the agent owns its own timer and no surface can arm a
// one-shot. A LOOP (`every` set) is user-armed through `/loop`, so its message
// is editable and saves by re-arming the loop at the same interval.

import React, { useEffect, useState, type ReactElement } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import { AlarmClock } from 'lucide-react-native';
import type { ChatRow } from '../stores/types';
import { writeLoopMessage } from '../lib/chatMeta';
import { BarDetailSheet } from './chatBars/BarDetailSheet';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';

/**
 * Humanise the wait until `fireAt`. Coarse-to-fine so the bar reads naturally
 * at any horizon: `3h 4m`, `9m`, `2m 5s`, `45s`. Seconds are shown only under
 * an hour, and a wake whose time has passed but whose turn hasn't landed yet
 * reads `now` rather than a negative or a stale number.
 */
export function formatWakeCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  const totalSec = Math.ceil(msRemaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0 && s > 0) return `in ${m}m ${s}s`;
  if (m > 0) return `in ${m}m`;
  return `in ${s}s`;
}

export function WakeBar({ row }: { row: ChatRow | undefined }): ReactElement | null {
  const colors = useTheme();
  const wake = row?.pendingWake ?? null;
  const fireAt = wake?.fireAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // Tick every second so the countdown is live. Only while a wake is armed —
  // no timer runs for the (overwhelmingly common) chat with nothing pending.
  useEffect(() => {
    if (fireAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fireAt]);

  if (!wake) return null;

  const countdown = formatWakeCountdown(wake.fireAt - now);

  const every = wake.every;
  const unchanged = draft.trim() === '' || draft.trim() === wake.message;

  async function save(): Promise<void> {
    if (!row || every === undefined) return;
    if (await writeLoopMessage(row.chatId, draft.trim(), every)) setOpen(false);
  }

  return (
    <>
      <Pressable
        testID="wake-bar"
        accessibilityRole="button"
        accessibilityLabel="Show wake"
        onPress={() => {
          setDraft(wake.message);
          setOpen(true);
        }}
        style={{
          backgroundColor: colors.paperRaised,
          borderColor: colors.divider,
          borderWidth: 1,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radii.sm,
          margin: space.sm,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.xs,
        }}
      >
        <AlarmClock size={14} color={colors.ink2} />
        <Text
          testID="wake-bar-countdown"
          style={{ color: colors.ink2, fontFamily: fonts.bodyMedium, fontSize: textMin }}
        >
          Wakes {countdown}
        </Text>
        <Text
          testID="wake-bar-message"
          numberOfLines={1}
          style={{ color: colors.ink3, fontSize: textMin, flexShrink: 1 }}
        >
          · {wake.message}
        </Text>
      </Pressable>
      {open ? (
        <BarDetailSheet testID="wake-modal" title="Wake" onClose={() => setOpen(false)}>
          <Text style={{ color: colors.ink3, fontSize: textMin, marginBottom: space.sm }}>
            {countdown}
          </Text>
          {every === undefined ? (
            <Text testID="wake-modal-message" selectable style={{ color: colors.ink }}>
              {wake.message}
            </Text>
          ) : (
            <>
              <TextInput
                testID="wake-modal-input"
                accessibilityLabel="Edit wake"
                multiline
                value={draft}
                onChangeText={setDraft}
                style={{
                  color: colors.ink,
                  borderColor: colors.divider,
                  borderWidth: 1,
                  borderRadius: radii.sm,
                  padding: space.sm,
                  minHeight: 96,
                  textAlignVertical: 'top',
                }}
              />
              <Pressable
                testID="wake-modal-save"
                accessibilityRole="button"
                accessibilityLabel="Save wake"
                accessibilityState={{ disabled: unchanged }}
                disabled={unchanged}
                onPress={() => void save()}
                style={{ alignSelf: 'flex-end', marginTop: space.sm, opacity: unchanged ? 0.4 : 1 }}
              >
                <Text style={{ color: colors.ink, fontFamily: fonts.bodyMedium }}>Save</Text>
              </Pressable>
            </>
          )}
        </BarDetailSheet>
      ) : null}
    </>
  );
}
