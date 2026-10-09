// ArchivedBanner — shown in the chat panel when the open chat is archived
// (patch/todo.md: "Archived state does not show in chat. Need a way to show it
// and unarchive it (archive should still allow sending messages)").
//
// An archived chat still opens with its full transcript AND composer — you can
// keep talking to it while it stays archived (archive is sticky; sending does
// NOT un-archive — spec/04 § Lifecycle). This banner makes the otherwise-
// invisible archived state visible and offers the ONLY un-archive path: a
// direct Unarchive control. Optimistic flip, reverting + surfacing a toast on
// failure (NO FALLBACK) — mirrors the sidebar's per-row archive.

import type { JSX } from 'react';
import { Archive, PackageOpen } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';

export function ArchivedBanner({ row }: { row: ChatRow }): JSX.Element | null {
  const setArchived = useChatStore((s) => s.setArchived);
  const pushError = useUiStore((s) => s.pushError);

  if (row.status !== 'archived') return null;

  async function unarchive(): Promise<void> {
    setArchived(row.chatId, false);
    try {
      await api.archiveChat(row.chatId, false);
    } catch (err) {
      setArchived(row.chatId, true);
      pushError(failed('unarchive'), undefined, (err as Error).message);
    }
  }

  return (
    <div className="archived-banner" data-testid="archived-banner" role="status">
      <span className="archived-banner-label">
        <Archive size={14} aria-hidden />
        Archived
      </span>
      <button
        type="button"
        className="archived-unarchive-btn"
        data-testid="unarchive-btn"
        onClick={() => void unarchive()}
      >
        <PackageOpen size={14} aria-hidden />
        Unarchive
      </button>
    </div>
  );
}
