// documentTitle — keep the OS-level window/tab title in sync with the active
// chat's workspace (App Updates: "should show which workspace I am in
// somewhere"). Tom regularly has several Patch windows/tabs open at once, each
// on a different chat in a different folder, and switches between them via
// Cmd+` / Mission Control / the Dock / browser tabs — none of which show the
// small mono folder crumb ChatHeader draws inside the page. `document.title`
// is the one label that surfaces at that level, and Electron's BrowserWindow
// mirrors it into the window title / Dock menu / Cmd+` switcher on its own
// (no `page-title-updated` handler in packages/desktop/src/main.ts), so a
// renderer-only fix reaches every surface for free.
//
// Same derivation ChatHeader uses for the folder crumb — `folderLabel`,
// shared rather than re-implemented — so the title and the crumb can never
// disagree about what a folder is called.
import { useEffect } from 'react';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { folderLabel } from './folderLabel.js';

const SPECIAL_THREAD_ID_SET: ReadonlySet<string> = new Set(Object.values(SPECIAL_THREAD_IDS));

const BASE_TITLE = 'patch';

/**
 * The title for the active chat's workspace, or the plain base title where
 * there is no workspace to show: no active chat (empty state, Settings, Jobs,
 * …), a special thread (Manager/Speakers, which have no folder by
 * definition), or a chat whose folder resolves to nothing real. This is a
 * legitimate default state, not a masked failure — `folderLabel` itself is
 * NO-FALLBACK about an unknown folder on a chat that should have one; a
 * special/absent chat never has one to begin with.
 */
export function documentTitleFor(chatId: string | null, folder: string | undefined): string {
  if (chatId === null) return BASE_TITLE;
  if (SPECIAL_THREAD_ID_SET.has(chatId)) return BASE_TITLE;
  const label = folder === undefined ? null : folderLabel(folder);
  return label === null ? BASE_TITLE : `${label} — ${BASE_TITLE}`;
}

/**
 * Keeps `document.title` following the active chat's folder across
 * client-side route navigation (React Router never reloads the document, so
 * nothing else touches the title).
 */
export function useDocumentTitleSync(): void {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const activeFolder = useChatStore((s) =>
    s.activeChatId === null ? undefined : s.chats[s.activeChatId]?.folder,
  );

  useEffect(() => {
    document.title = documentTitleFor(activeChatId, activeFolder);
  }, [activeChatId, activeFolder]);
}
