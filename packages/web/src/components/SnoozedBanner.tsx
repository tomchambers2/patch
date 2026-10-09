// SnoozedBanner — shown in the chat panel when the open chat is snoozed
// (spec/04 § Snooze, spec/14 § Chat lifecycle → Snooze).
//
// Snoozing only changes where a chat is listed: it still opens, still runs and
// still notifies. So the panel names the wake time rather than hiding anything,
// and carries the same Unsnooze the Snoozed section offers. Optimistic clear,
// reverting + toasting on failure (NO FALLBACK).

import type { JSX } from 'react';
import { Clock } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { isSnoozed } from '../stores/types.js';
import type { ChatRow } from '../stores/types.js';
import { formatWakeTime } from './SnoozeMenu.js';
import { failed } from '../lib/errorCopy.js';

export function SnoozedBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const setSnoozed = useChatStore((s) => s.setSnoozed);
  const pushError = useUiStore((s) => s.pushError);

  if (!isSnoozed(row)) return null;

  async function unsnooze(): Promise<void> {
    const was = row.snoozedUntil;
    setSnoozed(row.chatId, null);
    try {
      await api.snoozeChat(row.chatId, null);
    } catch (err) {
      setSnoozed(row.chatId, was);
      pushError(failed('unsnooze'), undefined, (err as Error).message);
    }
  }

  return (
    <div className="archived-banner" data-testid="snoozed-banner" role="status">
      <span className="archived-banner-label">
        <Clock size={14} aria-hidden />
        Snoozed until {formatWakeTime(row.snoozedUntil!)}
      </span>
      <button
        type="button"
        className="archived-unarchive-btn"
        data-testid="unsnooze-banner-btn"
        onClick={() => void unsnooze()}
      >
        Unsnooze
      </button>
    </div>
  );
}
