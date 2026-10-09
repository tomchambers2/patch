// In-chat call bar (spec/15 § Voice states — Voice call). A sustained call is
// not a full-screen layer: it lives INSIDE the chat it is on. The chat's own
// message stream is the transcript (spoken turns and replies land there as
// ordinary messages), and this bar docks above the composer carrying what the
// stream cannot say:
//
//   ● Listening                                            1:23
//   You: turn the kitchen lights…         (live words, while you speak)
//   Start with “patch” — or reply within 30s of it speaking   (hands-free)
//   [Mute]  [ Call | Hands-free ]                          [End]
//
// `CallDock` is what a chat screen mounts: the full bar when the call is on
// THIS chat, the small on-call pill when it is on another one, nothing when
// there is no call. Keeping it one component keeps the chat screen's own
// change to a single line.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Mic, MicOff, PhoneOff } from 'lucide-react-native';
import type { AudioSessionMode } from '@patch/wire/audio';
import { useVoiceStore } from '../stores/voiceStore';
import { endVoiceCall, retryVoiceCall, setCallMode, setCallMuted } from '../lib/voiceCall';
import { callModeLabel, callPhaseLabel, formatElapsed, handsFreeHint } from '../lib/callStatus';
import { fonts, radii, space, textMin, type ThemeColors, useTheme } from '../lib/theme';
import { CallPill } from './CallPill';
import { ConnectingLabel, StatusDot, callDotColor, useNow } from './CallParts';

function ModeSegment({
  mode,
  current,
  colors,
}: {
  mode: AudioSessionMode;
  current: AudioSessionMode;
  colors: ThemeColors;
}): React.ReactElement {
  const selected = mode === current;
  return (
    <Pressable
      onPress={() => setCallMode(mode)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={
        selected ? `${callModeLabel(mode)} (on)` : `Switch to ${callModeLabel(mode)}`
      }
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.xs + 2,
        borderRadius: radii.md,
        backgroundColor: selected ? colors.leaf : 'transparent',
      }}
    >
      <Text
        style={{
          color: selected ? colors.onAccent : colors.ink2,
          fontFamily: fonts.bodyMedium,
          fontSize: 14,
        }}
      >
        {callModeLabel(mode)}
      </Text>
    </Pressable>
  );
}

export function CallBar(): React.ReactElement | null {
  const colors = useTheme();
  const session = useVoiceStore((s) => s.activeSession);
  const muted = useVoiceStore((s) => s.callMuted);
  const partial = useVoiceStore((s) => s.callTranscriptPartial);
  const phase = useVoiceStore((s) => s.callPhase);
  const mode = useVoiceStore((s) => s.callMode);
  const unaddressed = useVoiceStore((s) => s.callUnaddressed);
  const error = useVoiceStore((s) => s.callError);
  const connectedAt = useVoiceStore((s) => s.callConnectedAt);
  const addressWord = useVoiceStore((s) => s.callAddressWord);
  const engine = useVoiceStore((s) => s.callEngine);
  const now = useNow(session !== null && connectedAt !== null);

  if (!session) return null;

  const connecting = phase === 'connecting';
  const failed = error !== null;
  const hint = handsFreeHint(mode, addressWord);
  const live = !connecting && !failed && !muted;
  const dot = callDotColor(colors, { connecting, error: failed, muted, phase });

  return (
    <View
      testID="call-bar"
      style={{
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: space.sm,
        gap: space.xs,
        backgroundColor: colors.accentTint,
        borderTopWidth: 1,
        borderColor: colors.divider,
      }}
    >
      {/* Status row: dot · what the line is doing · elapsed time. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <StatusDot
          color={dot}
          pulsing={live && (phase === 'listening' || phase === 'transcribing')}
        />
        <View style={{ flex: 1 }}>
          {failed ? (
            <Text
              testID="call-phase"
              style={{ color: colors.red, fontFamily: fonts.bodyMedium, fontSize: 15 }}
            >
              {connecting ? 'Could not connect' : 'Call problem'}
            </Text>
          ) : connecting ? (
            <ConnectingLabel color={colors.ink3} />
          ) : (
            <Text
              testID="call-phase"
              style={{ color: colors.ink, fontFamily: fonts.bodyMedium, fontSize: 15 }}
            >
              {muted ? 'Muted' : callPhaseLabel(phase)}
            </Text>
          )}
        </View>
        {engine !== null ? (
          <Text testID="call-engine" style={{ color: colors.ink3, fontSize: textMin }}>
            {engine}
          </Text>
        ) : null}
        {connectedAt !== null ? (
          <Text
            testID="call-timer"
            style={{ color: colors.ink2, fontSize: 14, fontVariant: ['tabular-nums'] }}
          >
            {formatElapsed(now - connectedAt)}
          </Text>
        ) : null}
      </View>

      {/* The words in flight — full ink, not a greyed guess: this is the only
          place they show until the turn lands in the stream above. */}
      {!failed && partial.length > 0 ? (
        <Text testID="call-partial" style={{ color: colors.ink, fontSize: 15 }}>
          <Text style={{ color: colors.leaf, fontFamily: fonts.bodyMedium }}>You: </Text>
          {partial}
        </Text>
      ) : null}
      {/* Heard but not sent (spec/07 § Session modes) — hands-free picked this
          up and it was not addressed, so it never became a turn. */}
      {!failed && partial.length === 0 && unaddressed !== null ? (
        <Text testID="call-unaddressed" style={{ color: colors.ink3, fontSize: 14 }}>
          Heard “{unaddressed}” — not addressed, so not sent
        </Text>
      ) : null}
      {!failed && hint !== null ? (
        <Text testID="call-hint" style={{ color: colors.ink2, fontSize: textMin }}>
          {hint}
        </Text>
      ) : null}

      {failed ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text testID="call-error" style={{ flex: 1, color: colors.red, fontSize: 14 }}>
            {error}
          </Text>
          <Pressable
            onPress={() => {
              void retryVoiceCall();
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry call"
            style={({ pressed }) => ({
              paddingHorizontal: space.md,
              paddingVertical: space.xs + 2,
              borderRadius: radii.md,
              backgroundColor: pressed ? colors.leafSoft : colors.leaf,
            })}
          >
            <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium, fontSize: 14 }}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Controls: mute, the mode switch named plainly, end. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          onPress={() => setCallMuted(!muted)}
          disabled={failed}
          accessibilityRole="button"
          accessibilityLabel={muted ? 'Unmute' : 'Mute'}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs + 2,
            borderRadius: radii.md,
            backgroundColor: muted ? colors.ink2 : pressed ? colors.divider : colors.paper,
          })}
        >
          {muted ? (
            <MicOff size={16} color={colors.paper} />
          ) : (
            <Mic size={16} color={failed ? colors.inkFaint : colors.ink2} />
          )}
          <Text
            style={{
              color: muted ? colors.paper : failed ? colors.inkFaint : colors.ink2,
              fontFamily: fonts.bodyMedium,
              fontSize: 14,
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </Text>
        </Pressable>
        <View
          testID="call-mode-switch"
          style={{
            flexDirection: 'row',
            backgroundColor: colors.paper,
            borderRadius: radii.md,
            padding: 2,
          }}
        >
          <ModeSegment mode="call" current={mode} colors={colors} />
          <ModeSegment mode="hands-free" current={mode} colors={colors} />
        </View>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => {
            void endVoiceCall();
          }}
          accessibilityRole="button"
          accessibilityLabel="End call"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            paddingHorizontal: space.md,
            paddingVertical: space.xs + 2,
            borderRadius: radii.md,
            backgroundColor: colors.red,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <PhoneOff size={16} color={colors.onAccent} />
          <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium, fontSize: 14 }}>
            End
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * What a chat screen mounts above its composer: the bar for a call on this
 * chat, the pill for a call on another, nothing otherwise.
 */
export function CallDock({ chatId }: { chatId: string }): React.ReactElement | null {
  const callChatId = useVoiceStore((s) => s.activeSession?.chatId ?? null);
  if (callChatId === null) return null;
  if (callChatId === chatId) return <CallBar />;
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}>
      <CallPill />
    </View>
  );
}
