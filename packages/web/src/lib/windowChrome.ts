// windowChrome — does THIS window have the desktop shell's overlay title bar?
//
// spec/05 § Desktop packaging (Electron) → Window chrome: the Electron shell
// draws its document windows (main + spec/14 § New windows children) with no
// native title bar, so the SPA reaches the window's top edge and the macOS
// traffic lights float over its top-left. Two consequences the renderer owns:
// keep that top-left strip clear, and provide a drag region, because there is
// no title bar left to move the window by.
//
// The answer needs two facts held on different sides of the bridge:
//   - the PLATFORM hid the bar — only the shell knows, so `preload.ts` hands it
//     over as `patch.overlayTitleBar` (a plain value, readable on first paint);
//   - this window is a document window, not one of the two frameless popovers.
//     The preload cannot tell which window it was injected into; the route can.
//
// NO FALLBACK: a plain browser has no bridge and gets no inset at all, rather
// than a guess based on user-agent sniffing.

import { getDesktopBridge } from './desktopBridge.js';

/** Set on <html> when this window's content runs under the traffic lights. */
export const OVERLAY_TITLE_BAR_CLASS = 'overlay-titlebar';

/**
 * Routes the shell only ever loads into a `frame: false` popover — the tray
 * popover (`/menubar`) and the voice overlay (`/voice-overlay`). Those windows
 * have NO traffic lights and no title bar to begin with, so reserving a strip
 * for lights that aren't there would just indent them. `/sidebar-window` is
 * deliberately absent: it is a real child window and does have them.
 */
const FRAMELESS_POPOVER_ROUTES = ['/menubar', '/voice-overlay'];

/**
 * `pathname` is the raw `window.location.pathname`, so it carries the SPA's
 * `/app` base path in production and none in the dev harness. Matched on the
 * tail so both forms resolve the same way.
 */
export function hasOverlayTitleBar(o: { overlayTitleBar: boolean; pathname: string }): boolean {
  if (!o.overlayTitleBar) return false;
  return !FRAMELESS_POPOVER_ROUTES.some((r) => o.pathname === r || o.pathname.endsWith(r));
}

/** Apply (or remove) the marker class the stylesheet keys its insets off. */
export function applyOverlayTitleBarClass(
  root: { classList: { toggle(token: string, force: boolean): void } },
  o: { overlayTitleBar: boolean; pathname: string },
): void {
  root.classList.toggle(OVERLAY_TITLE_BAR_CLASS, hasOverlayTitleBar(o));
}

/**
 * Boot hook for the real entry points. Called synchronously before the first
 * render so the inset is part of the first paint rather than a visible jump
 * one frame in — which is why this is not a `useEffect` in AppShell.
 */
export function initWindowChrome(): void {
  const bridge = getDesktopBridge();
  applyOverlayTitleBarClass(document.documentElement, {
    overlayTitleBar: bridge?.overlayTitleBar === true,
    pathname: window.location.pathname,
  });
}
