// Shared pieces of the call UI (spec/15 § Voice states): the ticking clock,
// the status dot and the neutral "Connecting…" label. Used by both the
// in-chat call bar and the on-call pill so the two always read alike.

import React from 'react';
import { Animated, Easing, Text } from 'react-native';
import type { ThemeColors } from '../lib/theme';
import { fonts } from '../lib/theme';

/** Re-renders every `intervalMs` while `active`, returning the current time. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

/**
 * `Connecting` with dots that count up — motion that says "working on it",
 * in the neutral ink, so it can never be mistaken for the live states.
 */
export function ConnectingLabel({ color }: { color: string }): React.ReactElement {
  const [dots, setDots] = React.useState(1);
  React.useEffect(() => {
    const t = setInterval(() => setDots((d) => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <Text testID="call-connecting" style={{ color, fontFamily: fonts.bodyMedium, fontSize: 15 }}>
      Connecting{'.'.repeat(dots)}
    </Text>
  );
}

/** What colour the status dot takes — the state at a glance. */
export function callDotColor(
  colors: ThemeColors,
  s: { connecting: boolean; error: boolean; muted: boolean; phase: string },
): string {
  if (s.error) return colors.red;
  if (s.connecting || s.muted) return colors.ink3;
  if (s.phase === 'thinking') return colors.amber;
  return colors.leaf;
}

/** A dot that pulses while the mic is live, and holds still otherwise. */
export function StatusDot({
  color,
  pulsing,
}: {
  color: string;
  pulsing: boolean;
}): React.ReactElement {
  const pulse = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    if (!pulsing) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulsing, pulse]);
  return (
    <Animated.View
      testID="call-status-dot"
      accessibilityElementsHidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: color,
        opacity: pulse,
      }}
    />
  );
}
