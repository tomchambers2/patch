// Shift-click guard — spec/14 § "Links and the web panel (desktop shell)",
// patch/todo.md "shift click is refreshing the window".
//
// React Router only handles UNMODIFIED clicks on a <Link>: a shift/meta/ctrl
// click is deliberately left to the browser, whose meaning is "open this in
// another tab or window". Patch has no other tab. In its single window that
// default is a full same-origin page load — the app visibly REFRESHES and the
// socket, streaming messages, drafts, batch and open editor all go with it.
//
// So a shift-click on an in-app link is swallowed here, in one place, for every
// link in the app rather than per-Link. Shift instead means RANGE-SELECT: on a
// sidebar chat row it extends the selection (stores/selectionStore.ts), and
// anywhere else it simply does nothing.
//
// Scope is deliberately narrow: only a primary-button shift-click on a
// SAME-ORIGIN anchor. An external link keeps its normal behaviour — the desktop
// shell's link policy (packages/desktop/src/link-policy.ts) already hands it to
// the user's real browser instead of navigating this window.

import { useEffect } from 'react';

/** Does this click need swallowing to stop the window navigating? */
export function isWindowReloadingShiftClick(e: MouseEvent): boolean {
  if (e.button !== 0) return false;
  if (!e.shiftKey) return false;
  const target = e.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  return anchor.origin === window.location.origin;
}

/** Install the guard for as long as the calling component is mounted. */
export function useShiftClickGuard(): void {
  useEffect(() => {
    // Capture phase: decided before React's own delegated handlers run.
    function onClick(e: MouseEvent): void {
      if (isWindowReloadingShiftClick(e)) e.preventDefault();
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}
