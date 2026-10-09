// ReminderBanner — shows the chat's reminder at the top of the chat panel
// (patch/todo.md § Features to add — "Reminders — configurable reminder to do /
// not do something. Also at the top as a banner so it's easy for the user to
// see"). The reminder is set from the composer via `/remind <text>` and cleared
// with a bare `/remind`; this banner is the always-visible readout. A small
// clear (×) control removes the reminder (optimistic, reverting + surfacing a
// toast on failure — NO FALLBACK), mirroring the GoalBanner's per-chat pattern.

import type { JSX } from 'react';
import { Bell } from 'lucide-react';
import { CloseIcon } from './icons.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';

export function ReminderBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const setReminder = useChatStore((s) => s.setReminder);
  const pushError = useUiStore((s) => s.pushError);

  const reminder = row.reminder;
  if (reminder === null || reminder.trim() === '') return null;

  async function clearReminder(): Promise<void> {
    const prev = reminder;
    setReminder(row.chatId, null);
    try {
      await api.setReminder(row.chatId, null);
    } catch (err) {
      setReminder(row.chatId, prev);
      pushError(failed('clearing reminder'), undefined, (err as Error).message);
    }
  }

  return (
    <div className="reminder-banner" data-testid="reminder-banner" role="status">
      <span className="reminder-banner-label">
        <Bell size={14} aria-hidden />
        <span className="reminder-banner-text" data-testid="reminder-banner-text">
          {reminder}
        </span>
      </span>
      <button
        type="button"
        className="reminder-clear-btn"
        data-testid="reminder-clear-btn"
        aria-label="Clear reminder"
        title="Clear reminder"
        onClick={() => void clearReminder()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
