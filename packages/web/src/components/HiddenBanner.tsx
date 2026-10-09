// HiddenBanner — shown in the chat panel when the open chat is hidden (spec/04
// § Hidden, spec/14 § Sidebar item 6).
//
// Hiding only changes where a chat is listed: it still opens, still runs and
// still notifies. So the panel names the state and carries the same Unhide
// the Hidden section offers, which moves the chat into the active list
// without sending anything. Optimistic flip, reverting + toasting on failure
// (NO FALLBACK).

import type { JSX } from 'react';
import { EyeOff } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { isHidden } from '../stores/types.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';

export function HiddenBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const setHidden = useChatStore((s) => s.setHidden);
  const pushError = useUiStore((s) => s.pushError);

  if (!isHidden(row)) return null;

  async function show(): Promise<void> {
    setHidden(row.chatId, false);
    try {
      await api.hideChat(row.chatId, false);
    } catch (err) {
      setHidden(row.chatId, true);
      pushError(failed('show'), undefined, (err as Error).message);
    }
  }

  return (
    <div className="archived-banner" data-testid="hidden-banner" role="status">
      <span className="archived-banner-label">
        <EyeOff size={14} aria-hidden />
        Hidden
      </span>
      <button
        type="button"
        className="archived-unarchive-btn"
        data-testid="show-banner-btn"
        onClick={() => void show()}
      >
        Unhide
      </button>
    </div>
  );
}
