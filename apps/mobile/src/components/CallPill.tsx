// On-call pill (spec/15 § Voice states — Voice call). While a call is open and
// the user is somewhere other than its chat, this small persistent pill says
// so: `On call · Manager · 1:23`. Tapping it returns to the call's chat, where
// the full call bar is; its end button hangs up without going back.
//
// Placement is the caller's: the tab layout floats it above the tab bar, and a
// chat screen docks it above its composer (CallDock) when the call is on a
// different chat.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { PhoneOff } from 'lucide-react-native';
import { useVoiceStore } from '../stores/voiceStore';
import { useChatStore } from '../stores/chatStore';
import { endVoiceCall } from '../lib/voiceCall';
import { callChatName, formatElapsed } from '../lib/callStatus';
import { fixed, fonts, space, useTheme } from '../lib/theme';
import { StatusDot, callDotColor, useNow } from './CallParts';

export function CallPill(): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const session = useVoiceStore((s) => s.activeSession);
  const mode = useVoiceStore((s) => s.callMode);
  const phase = useVoiceStore((s) => s.callPhase);
  const muted = useVoiceStore((s) => s.callMuted);
  const error = useVoiceStore((s) => s.callError);
  const connectedAt = useVoiceStore((s) => s.callConnectedAt);
  const row = useChatStore((s) => (session ? s.chats[session.chatId] : undefined));
  const now = useNow(session !== null && connectedAt !== null);

  if (!session) return null;

  const connecting = phase === 'connecting';
  const failed = error !== null;
  const name = callChatName(session.chatId, row);
  const state = failed
    ? 'Call failed'
    : connecting
      ? 'Connecting…'
      : mode === 'hands-free'
        ? 'Hands-free'
        : 'On call';
  const label =
    connectedAt !== null && !failed
      ? `${state} · ${name} · ${formatElapsed(now - connectedAt)}`
      : `${state} · ${name}`;

  return (
    <View
      testID="call-pill"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        borderRadius: 999,
        backgroundColor: colors.paperRaised,
        borderWidth: 1,
        borderColor: failed ? colors.red : colors.leaf,
        elevation: 4,
        shadowColor: fixed.shadow,
        shadowOpacity: 0.15,
        shadowRadius: 4,
      }}
    >
      <Pressable
        onPress={() => router.navigate(`/chats/${session.chatId}`)}
        accessibilityRole="button"
        accessibilityLabel={`${label} — return to the call`}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingLeft: space.md,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          flexShrink: 1,
        }}
      >
        <StatusDot
          color={callDotColor(colors, { connecting, error: failed, muted, phase })}
          pulsing={!connecting && !failed && !muted && phase === 'listening'}
        />
        <Text
          testID="call-pill-label"
          numberOfLines={1}
          style={{
            color: failed ? colors.red : colors.ink,
            fontFamily: fonts.bodyMedium,
            fontSize: 14,
            fontVariant: ['tabular-nums'],
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => {
          void endVoiceCall();
        }}
        accessibilityRole="button"
        accessibilityLabel="End call"
        hitSlop={8}
        style={({ pressed }) => ({
          width: 32,
          height: 32,
          marginRight: space.xs,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.red,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <PhoneOff size={16} color={colors.onAccent} />
      </Pressable>
    </View>
  );
}
