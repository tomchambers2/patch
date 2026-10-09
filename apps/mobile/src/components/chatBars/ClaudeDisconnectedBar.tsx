// ClaudeDisconnectedBar — shown when THIS chat's host has no credential for the
// chat's backend. Mobile port of web's ClaudeDisconnectedBanner
// (packages/web/src/components/ClaudeDisconnectedBanner.tsx), same rule:
// credentials are per host per backend (spec/10 § Surface in Settings), so it
// speaks only for the machine this chat runs on, and only on a definite
// `connected: false` from that host — never a guess during startup. The state
// is otherwise invisible (a send just fails), so this is the case where text IS
// the feature: what's wrong, and where to fix it.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CLAUDE_BACKEND_ID, accountConnectedForModel } from '@patch/wire';
import { hostAccount, usePresenceStore } from '../../stores/presenceStore';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

export function ClaudeDisconnectedBar({
  daemonId,
  model,
}: {
  daemonId: string;
  model: string | null;
}): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const openai = model?.startsWith('openai/') ?? false;
  // '' is "host not known yet" (a row not yet spawned) — nothing to speak for.
  const host = daemonId === '' ? null : daemonId;
  const account = usePresenceStore((s) =>
    hostAccount(s.hosts, host, openai ? 'codex' : CLAUDE_BACKEND_ID),
  );
  const machine = usePresenceStore((s) => (host ? (s.hosts[host]?.host?.hostName ?? host) : null));
  if (account === null || accountConnectedForModel(account, model ?? undefined)) return null;

  return (
    <BarShell testID="claude-disconnected-bar" tone="alert" role="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={{ flex: 1, color: colors.ink, fontSize: textMin }}>
          {machine ?? 'This machine'} isn’t signed in to {openai ? 'OpenAI' : 'Claude'}. Chats can’t
          run.
        </Text>
        <Pressable
          testID="claude-disconnected-signin"
          accessibilityRole="link"
          accessibilityLabel="Sign in"
          onPress={() => router.push('/(tabs)/settings')}
          hitSlop={8}
        >
          <Text style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyMedium }}>
            Sign in
          </Text>
        </Pressable>
      </View>
    </BarShell>
  );
}
