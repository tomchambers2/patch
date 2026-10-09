// NavHistoryControls — browser-style Back / Forward buttons (plus ⌘←/⌘→) for
// the in-app navigation history (todo: "Back/forward buttons to go through
// history"; later, "cmd left right should go back and forward in pages").
//
// react-router v6 exposes navigate(-1)/navigate(+1) but not whether a
// back/forward step is possible, nor the stack itself — so we keep our own
// ordered stack of visited locations plus a cursor. Every organic navigation
// (a Link click, a programmatic navigate()) pushes onto the stack, truncating
// any forward entries first (browser semantics). Going Back/Forward (click or
// chord) moves the cursor and replays that entry via navigate(); a suppress
// flag stops the resulting location change from being re-pushed.

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shortcutTitle } from '../lib/shortcuts.js';

const ICON = 16;

// The stack is module-level, not per-instance: every route renders its own
// NavHistoryControls, so an instance-owned stack was thrown away on each route
// change and Back from Settings had nowhere to go.
const navHistory: { stack: string[]; index: number } = { stack: [], index: -1 };

/** Forget all visited locations (tests). */
export function resetNavHistory(): void {
  navHistory.stack = [];
  navHistory.index = -1;
}

export function NavHistoryControls(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const key = location.pathname + location.search;

  // The stack and cursor live in `navHistory` (module-level, mutated in place);
  // a version counter forces the re-render that recomputes the disabled states.
  if (navHistory.stack.length === 0) {
    navHistory.stack = [key];
    navHistory.index = 0;
  }
  // Set immediately before a Back/Forward navigate() so the ensuing location
  // change is recognised as internal and not pushed as a new entry.
  const suppressRef = useRef(false);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    if (suppressRef.current) {
      // This change came from a Back/Forward click — cursor already moved.
      suppressRef.current = false;
      rerender();
      return;
    }
    // Ignore no-op navigations to the location we are already sitting on
    // (e.g. clicking the link for the current chat) — they must not spawn a
    // duplicate history entry.
    if (navHistory.stack[navHistory.index] === key) return;
    // Organic navigation: drop any forward history, then push.
    navHistory.stack = navHistory.stack.slice(0, navHistory.index + 1);
    navHistory.stack.push(key);
    navHistory.index = navHistory.stack.length - 1;
    rerender();
  }, [key, rerender]);

  const canBack = navHistory.index > 0;
  const canForward = navHistory.index < navHistory.stack.length - 1;

  const goBack = useCallback(() => {
    // Reachable at index 0 via ⌘← even though the Back button is `disabled`
    // there — a chord has no disabled state to stop it firing.
    if (navHistory.index <= 0) return;
    const target = navHistory.stack[navHistory.index - 1];
    /* v8 ignore next -- defensive: the bounds check above guarantees an entry. */
    if (target === undefined) return;
    suppressRef.current = true;
    navHistory.index -= 1;
    navigate(target);
  }, [navigate]);

  const goForward = useCallback(() => {
    // Reachable at the tip via ⌘→ even though the Forward button is
    // `disabled` there — a chord has no disabled state to stop it firing.
    if (navHistory.index >= navHistory.stack.length - 1) return;
    const target = navHistory.stack[navHistory.index + 1];
    /* v8 ignore next -- defensive: the bounds check above guarantees an entry. */
    if (target === undefined) return;
    suppressRef.current = true;
    navHistory.index += 1;
    navigate(target);
  }, [navigate]);

  // ⌘←/⌘→ walk the same stack as the buttons (Todoist: "cmd left right should
  // go back and forward in pages"). Skipped while a text field has focus —
  // ⌘← and ⌘→ are the OS's own "start/end of line" chord there, and stealing
  // them would make it impossible to jump within a line of composer text.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') goBack();
      else goForward();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goBack, goForward]);

  return (
    <div className="nav-history" data-testid="nav-history">
      <button
        type="button"
        className="nav-history-btn"
        data-testid="nav-back"
        aria-label="Back"
        title={shortcutTitle('Back', '⌘←')}
        disabled={!canBack}
        onClick={goBack}
      >
        <ChevronLeft size={ICON} aria-hidden />
      </button>
      <button
        type="button"
        className="nav-history-btn"
        data-testid="nav-forward"
        aria-label="Forward"
        title={shortcutTitle('Forward', '⌘→')}
        disabled={!canForward}
        onClick={goForward}
      >
        <ChevronRight size={ICON} aria-hidden />
      </button>
    </div>
  );
}
