// Running delegates strip (spec/15 § Chat detail — Running delegates strip):
// one line per `patch_delegate` subagent still going — label + running time —
// above the composer, so it stays on screen after the tool-call row has
// scrolled away. Tapping a line expands the read-only transcript.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useChatStore, type DelegateUpdateInfo } from '../stores/chatStore';
import { formatElapsed } from '../lib/callStatus';
import { DelegateTranscript } from './DelegateTranscript';
import { space, typography, useTheme } from '../lib/theme';

const NO_DELEGATES: Record<string, DelegateUpdateInfo> = {};

export function DelegateStrip({ chatId }: { chatId: string }): React.ReactElement | null {
  const colors = useTheme();
  const updates = useChatStore((s) => s.delegateUpdates[chatId] ?? NO_DELEGATES);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const running = Object.entries(updates).filter(
    ([, d]) => d.status === 'running' || d.status === 'awaiting-permission',
  );
  const any = running.length > 0;
  React.useEffect(() => {
    if (!any) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [any]);
  if (!any) return null;
  return (
    <View
      testID="delegate-strip"
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderTopWidth: 1,
        borderColor: colors.lineSoft,
      }}
    >
      {running.map(([id, d]) => (
        <View key={id} testID="delegate-strip-item">
          <Pressable
            testID="delegate-strip-open"
            onPress={() => setOpenId(openId === id ? null : id)}
            accessibilityLabel={`Subagent ${d.label} — tap to ${openId === id ? 'collapse' : 'expand'}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
          >
            <Text style={{ ...typography.meta, color: colors.ink2, flex: 1 }} numberOfLines={1}>
              {d.label}
            </Text>
            <Text testID="delegate-strip-time" style={{ ...typography.meta, color: colors.ink3 }}>
              {formatElapsed(now - d.since)}
            </Text>
          </Pressable>
          {openId === id ? <DelegateTranscript chatId={chatId} delegateId={id} /> : null}
        </View>
      ))}
    </View>
  );
}
