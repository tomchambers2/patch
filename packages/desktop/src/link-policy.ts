// Link policy for the main window — spec/14 § "Links and the web panel".
//
// One rule, one place, both navigation paths. The paths differ BY DESIGN: which
// one Chromium uses is exactly the user's choice of where the page should open.
//
//   will-navigate (a plain <a href> click, in place):
//     - same-origin  → an ordinary in-app SPA navigation, left alone
//     - other http(s) → Patch's own web panel (in-app-browser.ts)
//     - anything else → blocked
//
//   setWindowOpenHandler (window.open, target=_blank, and a ⌘/Ctrl/Shift-click,
//   which Chromium turns into a new-window request rather than a navigation):
//     - any http(s)  → the USER's real browser (shell.openExternal)
//     - anything else → blocked
//
// So a plain click keeps the page inside Patch beside the chat it came from,
// and the browser's own "open this somewhere else" gesture means the real
// browser. Neither route is a dead end: the panel's toolbar pops its page out
// to the real browser, and the right-click menu names both destinations
// outright (context-menu.ts).
//
// Kept electron-free so it is unit-testable under plain node.

export type LinkAction =
  /** Same-origin: let the SPA route it. */
  | { kind: 'spa' }
  /** External http(s), clicked in place: show it in Patch's own web panel. */
  | { kind: 'panel'; url: string }
  /** http(s) the user asked for OUTSIDE this window: hand to the OS browser. */
  | { kind: 'external'; url: string }
  /** Anything else (file:, javascript:, unparseable): refuse. */
  | { kind: 'block' };

/**
 * Decide what to do with an IN-PLACE navigation to `url` from the Patch window
 * (a plain click on an `<a href>`), where `appOrigin` is the origin the SPA
 * itself is served from (SERVER_URL). An external page opens in Patch's web
 * panel; the SPA stays put either way.
 *
 * NO FALLBACK: an unparseable URL is blocked outright rather than guessed at.
 */
export function routeLink(url: string, appOrigin: string): LinkAction {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: 'block' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { kind: 'block' };
  if (target.origin === new URL(appOrigin).origin) return { kind: 'spa' };
  return { kind: 'panel', url };
}

/**
 * Policy for a NEW-WINDOW request (`window.open`, `<a target="_blank">`, or a
 * ⌘/Ctrl/Shift-click, which Chromium routes here rather than through
 * will-navigate). The difference from {@link routeLink}: the user has asked for
 * this page OUTSIDE the window they are in, so it goes to their REAL browser
 * rather than to Patch's panel — including a same-origin `target="_blank"` (a
 * served attachment, a file link). Patch never spawns a second Electron window
 * for a link.
 *
 * Also the guard for a page Patch itself asks to show in the panel
 * (`patch:panel:open`) and for the right-click "Open Link in Patch" action: both
 * want the same "is this a real web page at all" test, with no same-origin
 * special case.
 */
export function routeWindowOpen(url: string): LinkAction {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: 'block' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { kind: 'block' };
  return { kind: 'external', url };
}
