// Narrow-viewport shell behaviour (spec/14 ## Layout → Narrow widths).
//
// `.three-col` is a flex row where the sidebar is `flex-shrink: 0`; only
// `.chat-main` shrinks. Below a certain width there is nowhere left for that
// shrinkage to come from, and the shell grows a page-level horizontal
// scrollbar. This reuses the sidebar's own manual toggle (`sidebarCollapsed`)
// — auto-collapsing it is just another caller of the setter the user's own
// control already uses. (The pane area needed no such rule when the docked
// editor rail retired — spec/14 § Panes and tabs: its panes are already
// flex children that shrink with the window, the same as `.chat-main`.)
//
// Edge-triggered, not level-triggered: the breakpoint only ACTS the moment
// the viewport crosses it (tracked via the previous-resize width), not on
// every resize tick while it stays on the same side. A plain "if narrower
// than 768, collapse" check re-run on every resize event would immediately
// re-collapse a sidebar the user had just deliberately re-expanded at (say)
// 750px — fighting a manual choice made while still narrow. Crossing-based
// detection means the auto-collapse only fires once per crossing, so a
// manual re-expand made while narrow survives further resizes that stay
// narrow, and only fires again on the NEXT genuine crossing.
//
// One-directional: crossing back above the breakpoint does not force the
// sidebar back open. Only "auto-collapse below" is specified — widening back
// out is left to the user's own toggle, so this never overrides a deliberate
// manual collapse made at a wide width.
import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore.js';

/** Below this width the sidebar auto-collapses (spec/14 ## Layout → Narrow widths). */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 768;

/**
 * Wires the narrow-width sidebar behaviour to `window.resize`. Call once from
 * whatever mounts the three-column shell — `AppShell` in production, and the
 * dev harness for e2e (both host the same `.three-col` layout).
 */
export function useResponsiveShell(): void {
  useEffect(() => {
    /* v8 ignore next -- jsdom (the test environment) always defines `window`; this SSR guard can't be exercised under vitest+jsdom. */
    if (typeof window === 'undefined') return;

    // Baseline "wide" so a page that LOADS narrow is treated as a crossing
    // too (live resize response, not just an on-mount snapshot check).
    let wasNarrowSidebar = false;

    function apply(): void {
      const nowNarrowSidebar = window.innerWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
      if (nowNarrowSidebar && !wasNarrowSidebar) {
        useUiStore.getState().setSidebarCollapsed(true);
      }
      wasNarrowSidebar = nowNarrowSidebar;
    }

    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);
}
