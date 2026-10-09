// ContextDisclosure — one quiet, collapsible row of context the agent received
// beyond what anyone typed: a captured `<system-reminder>` block under the turn
// it rode (spec/02 § System-reminder disclosure), or one category of Claude
// Code's own provider-level context (spec/02 § Provider-level context). Muted
// one-line label with a chevron at rest; a tap opens the raw text beneath it,
// selectable, and a second tap closes it. Web draws both as the same
// transcript-furniture disclosure (spec/14 § Main chat panel).

import React, { useState, type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { space, typography, useTheme } from '../lib/theme';

export function ContextDisclosure({
  testID,
  summary,
  text,
  defaultOpen = false,
}: {
  /** `<testID>` on the row, `-summary` on its tap target, `-detail` on the text. */
  testID: string;
  summary: string;
  text: string;
  defaultOpen?: boolean;
}): ReactElement {
  const colors = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View testID={testID}>
      <Pressable
        testID={`${testID}-summary`}
        accessibilityRole="button"
        accessibilityLabel={`${summary} — tap to ${open ? 'collapse' : 'expand'}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2 }}
      >
        {open ? (
          <ChevronDown size={12} color={colors.ink3} />
        ) : (
          <ChevronRight size={12} color={colors.ink3} />
        )}
        <Text
          numberOfLines={1}
          style={{ ...typography.meta, color: colors.ink3, marginLeft: space.xs, flexShrink: 1 }}
        >
          {summary}
        </Text>
      </Pressable>
      {open ? (
        <Text
          testID={`${testID}-detail`}
          selectable
          style={{ ...typography.meta, color: colors.ink2, marginTop: 2, marginBottom: space.xs }}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}
