// Foreground-only incoming-call surface used during dev or when CallKeep
// is unavailable on the JS side (e.g. before initCallKeep resolves). The
// production path is the native ConnectionService UI driven by CallKeep.
// This sheet is mounted at the root layout and only renders when the
// voice store has an `incomingCall` AND no active session.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { PhoneIncoming, PhoneOff } from 'lucide-react-native';
import { useVoiceStore } from '../stores/voiceStore';
import { useUiStore } from '../stores/uiStore';
import { getWs } from '../api/ws';
import { startVoiceCall } from '../lib/voiceCall';
import { fixed, fonts, radii, space, useTheme } from '../lib/theme';

export function IncomingCallSheet(): React.ReactElement | null {
  const colors = useTheme();
  const incoming = useVoiceStore((s) => s.incomingCall);
  const active = useVoiceStore((s) => s.activeSession);
  if (!incoming || active) return null;

  const accept = (): void => {
    try {
      getWs().send({
        type: 'chat.call_response',
        callId: incoming.callId,
        response: 'accept',
      });
    } catch (e) {
      useUiStore
        .getState()
        .pushError(`failed to send call response — retry: ${(e as Error).message}`);
    }
    startVoiceCall(incoming.chatId);
    useVoiceStore.getState().setIncoming(null);
  };
  const decline = (): void => {
    try {
      getWs().send({
        type: 'chat.call_response',
        callId: incoming.callId,
        response: 'decline',
      });
    } catch (e) {
      useUiStore
        .getState()
        .pushError(`failed to send call response — retry: ${(e as Error).message}`);
    }
    useVoiceStore.getState().setIncoming(null);
  };

  return (
    <View
      style={{
        position: 'absolute',
        top: 32,
        left: space.lg,
        right: space.lg,
        backgroundColor: colors.shade,
        borderRadius: radii.lg,
        padding: space.lg,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <PhoneIncoming size={28} color={fixed.onShade} />
      <View style={{ flex: 1, marginLeft: space.md }}>
        <Text style={{ color: fixed.onShade, fontFamily: fonts.bodyBold }}>Manager is calling</Text>
        {incoming.message ? (
          <Text style={{ color: fixed.onShade2, marginTop: 2 }} numberOfLines={2}>
            {incoming.message}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={accept}
        style={{
          backgroundColor: colors.leaf,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radii.md,
          marginRight: space.sm,
        }}
        accessibilityLabel="Accept call"
      >
        <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>Accept</Text>
      </Pressable>
      <Pressable
        onPress={decline}
        style={{
          backgroundColor: colors.red,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radii.md,
        }}
        accessibilityLabel="Decline call"
      >
        <PhoneOff size={16} color={colors.onAccent} />
      </Pressable>
    </View>
  );
}
