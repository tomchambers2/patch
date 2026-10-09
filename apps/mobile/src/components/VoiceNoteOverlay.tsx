// Voice-note overlay (single-turn). Dark capsule pinned at the bottom, in
// three plainly-named states (spec/15 § Voice states):
//
//   recording — pulsing mic, `Recording… 0:05`, cancel + Send
//   sending   — `Transcribing…` while the clip uploads and is transcribed
//   done      — the full transcript of what was heard, scrollable (never
//               clipped to a line or two), with a close control; it clears
//               itself after a pause long enough to read it, unless the user
//               scrolls it, which hands it over to them to close
//
// A note is uploaded whole rather than streamed, so there are no words while
// the user talks — the timer and the pulse are what say the mic is alive.
//
// Mounted at the root layout so it persists across tab switches. The store
// decides whether it's visible.

import React from 'react';
import { Animated, Easing, Pressable, ScrollView, Text, View } from 'react-native';
import { Mic } from 'lucide-react-native';
import { useVoiceStore } from '../stores/voiceStore';
import { endVoiceNote } from '../lib/voiceNote';
import { formatElapsed } from '../lib/callStatus';
import { fixed, fonts, radii, space, useTheme } from '../lib/theme';
import { useNow } from './CallParts';

/**
 * How long a finished transcript stays up: long enough to read it (about
 * three words a second, plus a beat to look down), clamped so a one-word note
 * does not vanish mid-glance and a long one does not sit there for a minute.
 */
export function noteReadingMs(transcript: string): number {
  const words = transcript.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(15_000, Math.max(4_000, 2_000 + words * 350));
}

export function VoiceNoteOverlay(): React.ReactElement | null {
  const colors = useTheme();
  const chatId = useVoiceStore((s) => s.voiceNoteChatId);
  const transcript = useVoiceStore((s) => s.voiceNoteTranscript);
  const state = useVoiceStore((s) => s.voiceNoteState);
  const startedAt = useVoiceStore((s) => s.voiceNoteStartedAt);
  const recording = chatId !== null && state === 'recording';
  const now = useNow(recording);
  const ripple = React.useRef(new Animated.Value(0)).current;
  // Scrolling the finished transcript means the user is reading it: stop the
  // auto-close and leave it to the close control.
  const [held, setHeld] = React.useState(false);

  React.useEffect(() => {
    if (!recording) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ripple, {
          toValue: 1,
          duration: 800,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(ripple, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [recording, ripple]);

  React.useEffect(() => {
    if (state !== 'done') {
      setHeld(false);
      return;
    }
    if (held) return;
    const t = setTimeout(() => useVoiceStore.getState().endVoiceNote(), noteReadingMs(transcript));
    return () => clearTimeout(t);
  }, [state, held, transcript]);

  if (chatId === null) return null;

  const scale = ripple.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const opacity = ripple.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] });
  const done = state === 'done';
  const title =
    state === 'sending'
      ? 'Transcribing…'
      : done
        ? 'Sent'
        : `Recording… ${formatElapsed(startedAt === null ? 0 : now - startedAt)}`;

  return (
    <View
      testID="voice-note-overlay"
      style={{
        position: 'absolute',
        left: space.lg,
        right: space.lg,
        bottom: space.xl,
        backgroundColor: colors.shade,
        borderRadius: radii.lg,
        padding: space.lg,
        flexDirection: 'row',
        alignItems: done ? 'flex-start' : 'center',
      }}
      pointerEvents="box-none"
    >
      <View style={{ width: 48, height: 48, justifyContent: 'center', alignItems: 'center' }}>
        {recording ? (
          <Animated.View
            style={{
              position: 'absolute',
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: colors.red,
              opacity,
              transform: [{ scale }],
            }}
          />
        ) : null}
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: recording ? colors.red : colors.leaf,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Mic size={18} color={colors.onAccent} />
        </View>
      </View>
      <View style={{ flex: 1, marginLeft: space.md }}>
        <Text
          testID="voice-note-title"
          style={{
            color: fixed.onShade,
            fontFamily: fonts.bodyMedium,
            fontSize: 16,
            fontVariant: ['tabular-nums'],
          }}
        >
          {title}
        </Text>
        {/* The whole transcript, not a two-line teaser: it is the user's own
            words, and a clipped copy is exactly what they cannot check. */}
        {done ? (
          <ScrollView
            testID="voice-note-transcript"
            style={{ maxHeight: 180, marginTop: space.xs }}
            onScrollBeginDrag={() => setHeld(true)}
          >
            <Text style={{ color: fixed.onShade, fontSize: 16, lineHeight: 22 }}>{transcript}</Text>
          </ScrollView>
        ) : null}
      </View>
      {done ? (
        <Pressable
          onPress={() => useVoiceStore.getState().endVoiceNote()}
          accessibilityLabel="Close transcript"
          style={{ padding: space.sm }}
        >
          <Text style={{ color: fixed.onShade, fontSize: 18 }}>×</Text>
        </Pressable>
      ) : (
        <>
          <Pressable
            onPress={() => {
              void endVoiceNote(false);
            }}
            disabled={state === 'sending'}
            accessibilityLabel="Cancel voice note"
            style={{ padding: space.sm, opacity: state === 'sending' ? 0.4 : 1 }}
          >
            <Text style={{ color: fixed.onShade, fontSize: 18 }}>×</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              // endVoiceNote(true) stops the recording AND uploads the clip via
              // POST /api/voice/note, then shows the transcript / any error
              // (see lib/voiceNote endVoiceNote).
              void endVoiceNote(true);
            }}
            disabled={state === 'sending'}
            accessibilityLabel="Send voice note"
            style={{
              backgroundColor: colors.leaf,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radii.md,
              marginLeft: space.sm,
              opacity: state === 'sending' ? 0.4 : 1,
            }}
          >
            <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>Send</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
