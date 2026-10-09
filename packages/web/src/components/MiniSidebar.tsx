// MiniSidebar — the sidebar as a narrow rail of status dots (spec/14 § Mini
// sidebar). It takes over from the full sidebar when that is dragged narrower
// than its minimum, so the user can move up and down the chats while the rest
// of the screen is given to something else. A row is just its badge, named by
// its tooltip; the expand control at the top restores the full sidebar.

import { useMemo, type JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Compass } from 'lucide-react';
import { deriveBadge, useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { groupChats } from '../lib/chatGroups.js';
import type { ChatRow } from '../stores/types.js';
import { StatusBadge } from './StatusBadge.js';

export function MiniSidebar(): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const folderRoster = useChatStore((s) => s.folderRoster);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const setSidebarMini = useUiStore((s) => s.setSidebarMini);
  const location = useLocation();
  const highlighted = location.pathname.startsWith('/chats/') ? activeChatId : null;

  const chatSort = useUiStore((s) => s.chatSort);
  const groupSort = useUiStore((s) => s.groupSort);
  const grouped = useMemo(
    () => groupChats(Object.values(chats), folderRoster, { chatSort, groupSort }),
    [chats, folderRoster, chatSort, groupSort],
  );
  // Same order as the full sidebar: Manager, pinned, then each project's rows,
  // with a hairline between projects.
  const groups: ChatRow[][] = [
    ...(grouped.manager ? [[grouped.manager]] : []),
    ...(grouped.pinned.length > 0 ? [grouped.pinned] : []),
    ...grouped.folders.map((f) => f.rows),
  ];

  return (
    <aside className="sb-mini" data-testid="mini-sidebar">
      <button
        type="button"
        className="mini-expand"
        data-testid="mini-expand"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={() => setSidebarMini(false)}
      >
        <ChevronRight size={16} aria-hidden />
      </button>
      <div className="mini-list">
        {groups.map((rows, i) => (
          <div className="mini-group" key={i}>
            {rows.map((row) => (
              <Link
                key={row.chatId}
                to={`/chats/${row.chatId}`}
                className={`mini-row ${highlighted === row.chatId ? 'active' : ''}`}
                data-testid={`mini-row-${row.chatId}`}
                title={row.name ?? 'New chat'}
                onClick={() =>
                  useLayoutStore.getState().openTab({ kind: 'chat', chatId: row.chatId })
                }
              >
                {row === grouped.manager ? (
                  <Compass size={16} aria-hidden />
                ) : (
                  <StatusBadge badge={deriveBadge(row)} pendingWake={row.pendingWake} />
                )}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
