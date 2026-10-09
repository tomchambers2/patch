// On-brand empty-chat graphic (spec/15 § Empty states — empty chat). A friendly
// illustration instead of a bare lucide icon: the patch chat-bubble mark (three
// activity dots) with a small leaf sprout, in the leaf-green accent. Mirrors the
// web EmptyChat art. Rendered with react-native-svg (already a dep).

import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '../lib/theme';

export function EmptyChatArt({ size = 168 }: { size?: number }): React.ReactElement {
  const colors = useTheme();
  // Preserve the 240×180 aspect ratio of the web art.
  const h = (size * 180) / 240;
  return (
    <Svg width={size} height={h} viewBox="0 0 240 180" fill="none">
      {/* speech bubble + tail as ONE continuous shape, as on web: the body's
          bottom edge dips into the bottom-left tail, so the outline is a single
          unbroken stroke where bubble meets tail. */}
      <Path
        d="M60 40 H180 A26 26 0 0 1 206 66 V110 A26 26 0 0 1 180 136 H104 L74 162 L74 136 H60 A26 26 0 0 1 34 110 V66 A26 26 0 0 1 60 40 Z"
        fill={colors.accentTint}
        stroke={colors.leaf}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      {/* three activity dots (the patch mark) */}
      <Circle cx={94} cy={88} r={8} fill={colors.leaf} />
      <Circle cx={120} cy={88} r={8} fill={colors.leaf} />
      <Circle cx={146} cy={88} r={8} fill={colors.leaf} />
      {/* leaf sprout growing out of the top */}
      <Path d="M158 18 c1 -9 7 -15 15 -16 c-2 9 -8 15 -15 16 z" fill={colors.leaf} />
      <Path
        d="M150 40 c1 -9 4 -16 8 -22"
        stroke={colors.leaf}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
      />
    </Svg>
  );
}
