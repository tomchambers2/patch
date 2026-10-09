// ProviderContextBar — Claude Code's own provider-level context this chat has
// received (spec/02 § Provider-level context; spec/15 § Chat detail → Status
// bars). Mobile port of web's ProviderContextPanel: chat-scoped, one quiet row
// per category in the order each was first seen, a recurring one naming its
// count (`Tokens remaining ×203`). Its default expand state is the account's
// `providerContextVerbosity`; `off` draws nothing. No bar on a chat that has
// received none.

import React, { type ReactElement } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { providerContextVerbosity } from '../../lib/preferences';
import { ContextDisclosure } from '../ContextDisclosure';
import { BarShell } from './BarShell';

export function ProviderContextBar({ chatId }: { chatId: string }): ReactElement | null {
  const held = useChatStore((s) => s.providerContext[chatId]);
  // A Settings load or edit since boot is newer than the boot-time read.
  const fromSettings = useSettingsStore((s) => s.data?.preferences.providerContextVerbosity);
  const verbosity = fromSettings ?? providerContextVerbosity();
  if (!held || verbosity === 'off') return null;
  const entries = Object.entries(held).sort(([, a], [, b]) => a.firstSeq - b.firstSeq);
  return (
    <BarShell testID="provider-context-bar">
      {entries.map(([providerType, entry]) => (
        <ContextDisclosure
          key={providerType}
          testID="provider-context"
          summary={entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label}
          text={entry.text}
          defaultOpen={verbosity === 'full'}
        />
      ))}
    </BarShell>
  );
}
