// Status badge — same seven-state vocabulary as the web sidebar (spec/14
// § Status badges) but slightly larger (12px target, 18px ring) for touch.

import React from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { Clock, Terminal, TriangleAlert } from 'lucide-react-native';
import type { DisplayBadge } from '../stores/types';
import { badgeColor } from '../lib/badge';
import { fonts, useTheme } from '../lib/theme';

interface Props {
  badge: DisplayBadge;
  size?: number;
}

function WorkingPulse({
  size,
  ringSize,
  color,
}: {
  size: number;
  ringSize: number;
  color: string;
}): React.ReactElement {
  // Looped pulse: 1.0 → 0.5 → 1.0 opacity. Uses Animated (built-in) since
  // react-native-reanimated isn't a dep yet.
  const opacity = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.5,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <View
      style={{
        width: ringSize,
        height: ringSize,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity,
        }}
      />
    </View>
  );
}

export function StatusBadge({ badge, size = 12 }: Props): React.ReactElement {
  const colors = useTheme();
  if (badge === 'read') {
    // small grey check glyph
    return (
      <View
        style={{
          width: size + 4,
          height: size + 4,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: fonts.body, color: colors.inkFaint, fontSize: size }}>✓</Text>
      </View>
    );
  }
  const color = badgeColor(badge, colors);
  const ringSize = size + 8;
  if (badge === 'working') {
    return <WorkingPulse size={size} ringSize={ringSize} color={color} />;
  }
  // A FAILED chat (spec/14 § Status badges) — a drawn glyph, not a tinted
  // dot, same as web: the states below already differ only by colour, which
  // is no use to a colour-blind reader for the one state that means the
  // work didn't happen.
  if (badge === 'errored') {
    return (
      <View
        style={{
          width: ringSize,
          height: ringSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TriangleAlert size={size + 3} color={color} strokeWidth={2.5} />
      </View>
    );
  }
  // An idle chat with a background command or sub-agent still running. A
  // static (not spinning) glyph, same grey as `read` — a spin is `working`'s
  // signal alone.
  if (badge === 'background') {
    return (
      <View
        style={{
          width: ringSize,
          height: ringSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Terminal size={size + 1} color={color} strokeWidth={2.5} />
      </View>
    );
  }
  // A self-wake armed (`patch_wake_me`): nothing running right now, the agent
  // will check back on its own. A plain Clock — distinct from WakeBar's
  // AlarmClock, which is the active countdown, not this at-rest signal.
  if (badge === 'monitoring') {
    return (
      <View
        style={{
          width: ringSize,
          height: ringSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Clock size={size + 2} color={color} strokeWidth={2.5} />
      </View>
    );
  }
  // done OR permission: dot with ring
  return (
    <View
      style={{
        width: ringSize,
        height: ringSize,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2.5,
        borderColor: color,
        borderRadius: ringSize / 2,
      }}
    >
      <View
        style={{
          width: size - 4,
          height: size - 4,
          borderRadius: (size - 4) / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
