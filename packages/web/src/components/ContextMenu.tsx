// ContextMenu — the app's right-click menu (spec/14 § Row context menu).
//
// Portalled to `document.body` and positioned in viewport coordinates. The
// containers a menu is opened over are scrolling or `overflow: hidden` boxes
// (`.sb-scroll`, the header crumb), and a pop-up rendered in place inside one
// of those opens clipped AND painted over — present in the DOM, unclickable in
// a real browser.
//
// Note a React portal still bubbles its events through the REACT tree, not the
// DOM tree: an item rendered here is a descendant of the row that owns the
// menu, so its click would reach that row's own handler (navigating into the
// chat) unless it is stopped. Every item handler below stops it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';

/** One row of the menu. `run` is called on click or ⏎; the menu closes first. */
export interface ContextMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** Destructive actions are drawn in the danger colour, as in the header menu. */
  danger?: boolean;
  run: () => void;
  /**
   * Sub-choices. Clicking the item expands them in place, indented, and keeps
   * the menu open; `run` is ignored. Each sub-item runs and closes as usual.
   */
  submenu?: ContextMenuItem[];
}

/** Where the menu was asked for, in viewport coordinates. */
export interface ContextMenuAnchor {
  x: number;
  y: number;
}

/** Clear space kept between the menu and the window edges. */
const EDGE = 6;

/**
 * Open/close state for one context menu.
 *
 * `openAt` is a `contextmenu` handler: it takes the browser's own menu off the
 * table and puts ours at the pointer instead. Leaving both up is the failure
 * mode of every hand-rolled context menu, so the `preventDefault` is the
 * point of the handler rather than an incidental detail.
 */
export function useContextMenu(): {
  anchor: ContextMenuAnchor | null;
  openAt: (e: ReactMouseEvent) => void;
  close: () => void;
} {
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);

  const openAt = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    // Shift+F10 / the keyboard's own menu key dispatch `contextmenu` with no
    // pointer behind it, at (0, 0). Anchor those to the focused element
    // instead, or the menu opens in the window's top-left corner nowhere near
    // the row it belongs to.
    if (e.clientX === 0 && e.clientY === 0) {
      const box = e.currentTarget.getBoundingClientRect();
      setAnchor({ x: box.left, y: box.bottom });
      return;
    }
    setAnchor({ x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback((): void => setAnchor(null), []);

  return { anchor, openAt, close };
}

export function ContextMenu({
  anchor,
  items,
  onClose,
  label,
  testId,
}: {
  anchor: ContextMenuAnchor | null;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Names the menu for assistive tech, e.g. `Chat actions`. */
  label: string;
  testId: string;
}): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // null until the menu has been measured; the raw anchor is used for that
  // first (pre-paint) render.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // What had focus when the menu opened, so Esc / dismissal hands it back.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useDismissOnClickOff(anchor !== null, [menuRef], onClose);

  // Keep the whole menu inside the window: slide left of the pointer at the
  // right edge, flip above it at the bottom. Measured in a LAYOUT effect, so
  // the corrected position is in place before the browser paints and the menu
  // is never seen at the uncorrected one.
  useLayoutEffect(() => {
    if (anchor === null) return;
    const el = menuRef.current;
    if (el === null) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE;
    const maxTop = window.innerHeight - height - EDGE;
    setPos({
      left: Math.max(EDGE, Math.min(anchor.x, maxLeft)),
      top: anchor.y > maxTop ? Math.max(EDGE, Math.min(anchor.y - height, maxTop)) : anchor.y,
    });
  }, [anchor, items.length, expanded]);

  useEffect(() => {
    if (anchor === null) setExpanded(null);
  }, [anchor]);

  // Focus moves into the menu on open (the ARIA menu pattern) so it is usable
  // from the keyboard alone — the menu key opens it, ↑/↓ walk it, ⏎ runs.
  useEffect(() => {
    if (anchor === null) return;
    const active = document.activeElement;
    returnFocusTo.current = active instanceof HTMLElement ? active : null;
    // `preventScroll`: the menu is `position: fixed` at the pointer, so there is
    // nothing to scroll INTO view — and letting the browser try fires a
    // document `scroll` that this same component reads as "the user scrolled
    // away" and closes on, so the menu shut itself the instant it opened.
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    if (anchor === null) return;

    function itemsInMenu(): HTMLButtonElement[] {
      const el = menuRef.current;
      if (el === null) return [];
      return Array.from(el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
        return;
      }
      const options = itemsInMenu();
      if (options.length === 0) return;
      e.preventDefault();
      const at = options.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? options.length - 1
            : e.key === 'ArrowDown'
              ? (at + 1) % options.length
              : at <= 0
                ? options.length - 1
                : at - 1;
      options[next]!.focus();
    }

    // The menu is anchored to a POINT, not to the row: scrolling the list under
    // it would leave it hanging over a different chat, still holding the first
    // one's actions. Capture, because the sidebar list scrolls in its own box
    // and that scroll event never reaches `window` by bubbling.
    function onViewportChange(): void {
      onClose();
    }

    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [anchor, onClose]);

  // Hand focus back to whatever opened the menu once it closes. Guarded on the
  // node still being in the document: an action that removes its own row (the
  // archive, the delete) leaves a detached element behind.
  useEffect(() => {
    if (anchor !== null) return;
    const back = returnFocusTo.current;
    returnFocusTo.current = null;
    if (back !== null && document.contains(back)) back.focus({ preventScroll: true });
  }, [anchor]);

  if (anchor === null) return null;

  return createPortal(
    <div
      className="context-menu"
      data-testid={testId}
      role="menu"
      aria-label={label}
      ref={menuRef}
      style={{ left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y }}
      // A second right-click inside the menu is not a request for a menu on
      // the menu, and it must not let the browser's own one through either.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.flatMap((item) => {
        const open = item.submenu !== undefined && expanded === item.id;
        const rows = [{ item, sub: false }];
        if (open) for (const child of item.submenu!) rows.push({ item: child, sub: true });
        return rows.map(({ item: it, sub }) => (
          <button
            key={sub ? `${item.id}/${it.id}` : it.id}
            type="button"
            role="menuitem"
            className={`context-menu-item${it.danger === true ? ' danger' : ''}${sub ? ' sub' : ''}`}
            data-testid={`${testId}-${it.id}`}
            aria-expanded={!sub && item.submenu !== undefined ? open : undefined}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!sub && item.submenu !== undefined) {
                setExpanded(open ? null : item.id);
                return;
              }
              onClose();
              it.run();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ));
      })}
    </div>,
    document.body,
  );
}
