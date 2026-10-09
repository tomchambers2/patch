// newWindow — open a chat or the sidebar in a separate window (Todoist:
// "open in new window"), per spec/14 § New windows.
//
// On the desktop shell this asks main to spawn a REAL Electron window
// (`patch:window:open` IPC, desktopBridge.ts) so it has its own OS-level
// presence, independent of the window that opened it. In a plain browser tab
// there is no such shell, so it falls back to an ordinary `window.open` —
// the SPA is served under `/app` (`05-surfaces.md` § Web app), so the path
// needs that prefix to resolve outside the app's own `BrowserRouter`.
//
// Every window opened this way starts with its OWN sidebar hidden
// (`?sidebar=hidden`, read once at boot by `uiStore`'s initial state) — a
// focused, sidebar-less view, per spec/14 § New windows.

import { getDesktopBridge } from './desktopBridge.js';
import { newChatPath } from './newChat.js';
import type { TabDescriptor } from '../stores/layoutStore.js';

/** Opening size for a window that asks for one, in CSS pixels. */
export type WindowSize = { width: number; height: number };

/**
 * A detached sidebar opens at a sidebar's width rather than a document's —
 * given the opener's width its chat list is stretched across the whole window,
 * each row's name an arm's length from its time. Inside the 200–600px the
 * docked sidebar itself drags to (spec/14 § Layout — desktop).
 */
export const SIDEBAR_WINDOW_SIZE: WindowSize = { width: 360, height: 800 };

function openWindow(path: string, size?: WindowSize): void {
  const bridge = getDesktopBridge();
  if (bridge?.openWindow) {
    bridge.openWindow(path, size);
    return;
  }
  const features = size ? `noopener,width=${size.width},height=${size.height}` : 'noopener';
  window.open(`/app${path}`, '_blank', features);
}

/**
 * Open the given chat, focused, in its own window (§ Chat panel header).
 *
 * `search` is the CURRENT window's `location.search` (e.g. `?seq=42` for a
 * chat opened from a sidebar search result) — carried over so the popout
 * lands on the same message rather than the chat's latest. `sidebar` is
 * forced to `hidden` regardless of what the opener's URL had.
 */
export function openChatInNewWindow(chatId: string, search = ''): void {
  const params = new URLSearchParams(search);
  params.set('sidebar', 'hidden');
  openWindow(`/chats/${chatId}?${params.toString()}`);
}

/**
 * Mint a fresh draft — the same minting `+ New chat` always does — and open
 * it in a new window, leaving the CURRENT window on whatever it was already
 * showing (§ Sidebar §8 → New chat in new window).
 */
export function openNewChatInNewWindow(): void {
  const path = newChatPath();
  openWindow(`${path}&sidebar=hidden`);
}

/** Open just the sidebar, detached into its own window (§ Sidebar §1). */
export function openSidebarInNewWindow(): void {
  openWindow('/sidebar-window', SIDEBAR_WINDOW_SIZE);
}

/**
 * Detach a single tab into its own window (spec/14 § Panes and tabs —
 * "detach into its own window"). `/tab-window` is a bare route (AppShell's
 * `isBareRoute`) rendering a single pane holding just this one tab, forced
 * open, via `routes/TabWindowRoute.tsx`. `?tabWindow=1` opts the new window's
 * OWN `layoutStore` out of `localStorage` persistence entirely — see
 * `layoutStore.ts`'s `isTabWindow` — so it neither inherits the opener's
 * whole layout nor overwrites it.
 */
export function openTabInNewWindow(descriptor: TabDescriptor): void {
  openWindow(`/tab-window?tabWindow=1&tab=${encodeURIComponent(JSON.stringify(descriptor))}`);
}
