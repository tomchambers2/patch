// Which artifact the desktop web panel is showing, per chat
// (spec/14 § Artifacts). An opened artifact belongs to the chat it was opened
// in: leave that chat and the panel goes with it, come back and it is there
// again, and another chat's artifact is never sitting beside your transcript.
//
// In-memory only — an artifact is a thing you were just looking at, not a
// document, so it does not need to survive a reload.
//
// Browser surface: `openPanel`/`closePanel` do not exist there (artifacts open
// in a new tab), so every entry point here no-ops.

import { getDesktopBridge } from './desktopBridge.js';

/** chatId -> the artifact URL currently shown for that chat. */
const byChat = new Map<string, string>();

/** What WE last asked the panel to show; null when we believe it is closed. */
let shownUrl: string | null = null;

/**
 * Inset frames our own open/close calls are about to produce. Main echoes
 * exactly one `patch:panel-inset` per open (the panel width) and per close (0),
 * and a close WE drove on a chat switch must not be read as the user closing
 * the panel — that would forget the artifact of the chat we just switched TO.
 */
let selfOps = 0;

function bridge(): { openPanel(url: string): void; closePanel(): void } | undefined {
  const b = getDesktopBridge();
  if (!b?.openPanel || !b?.closePanel) return undefined;
  return { openPanel: b.openPanel.bind(b), closePanel: b.closePanel.bind(b) };
}

/** The artifact `chatId` currently has open, if any. */
export function artifactFor(chatId: string): string | undefined {
  return byChat.get(chatId);
}

/** The user opened `url` from `chatId`'s transcript — it is now that chat's. */
export function rememberArtifact(chatId: string, url: string): void {
  byChat.set(chatId, url);
  selfOps++;
  shownUrl = url;
}

/** Show `chatId`'s artifact, or close the panel if it has none. */
export function showArtifactFor(chatId: string): void {
  const b = bridge();
  if (!b) return;
  const url = byChat.get(chatId);
  if (url === undefined) {
    closeArtifactPanel();
    return;
  }
  if (shownUrl === url) return;
  selfOps++;
  shownUrl = url;
  b.openPanel(url);
}

/**
 * Close the panel because Patch decided to (a chat with no artifact is now
 * open, or the chat route was left entirely). Skipped when we already believe
 * it is closed, so we never fire a close main will not echo.
 */
export function closeArtifactPanel(): void {
  const b = bridge();
  if (!b) return;
  if (shownUrl === null) return;
  selfOps++;
  shownUrl = null;
  b.closePanel();
}

/**
 * A `patch:panel-inset` arrived while `chatId` was open. Width 0 that we did
 * not drive means the user closed the panel from its own toolbar (the × or the
 * pop-out-to-browser button), so that chat forgets its artifact rather than
 * resurrecting it on the next visit.
 */
export function notePanelInset(chatId: string, width: number): void {
  if (selfOps > 0) {
    selfOps--;
    return;
  }
  if (width > 0) return;
  shownUrl = null;
  byChat.delete(chatId);
}

/** Test seam — module-level state outlives a component tree. */
export function _resetArtifactPanel(): void {
  byChat.clear();
  shownUrl = null;
  selfOps = 0;
}
