// TooltipHost — one global tooltip mounted once at the app root (spec/14 §
// Copy — Tooltips).
//
// Why this exists (Todoist "patch icon tooltips are not working well"): every
// icon-only control names itself with the plain HTML `title` attribute, and
// nothing has ever drawn it — the browser's own bubble does, which is slow to
// appear, carries no app styling, and clips at the window edge instead of
// flipping. Rewriting every one of those call sites (100+, spread across the
// sidebar, the chat header, the tools panel...) to a bespoke Tooltip
// component would be the bigger and riskier change, and would touch copy this
// codebase has spent several commits pinning (`Sidebar.tooltips.test.tsx`,
// `tooltipCopy.test.ts`, `e2e/tooltip-copy.spec.ts`). Instead this listens for
// the browser about to show its own tooltip on ANY `[title]` element, steps in
// first: it blanks `title` for the moment it is hovered/focused (so only ONE
// tooltip ever shows) and draws the app's own popover from the same string,
// restoring `title` the moment the pointer or focus leaves. No call site
// changes; the copy is untouched, byte for byte.
//
// Delegated to `document` rather than wired per-control, so it costs nothing
// to add a tooltip anywhere in the app: give an icon-only control a `title`
// and it is covered.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { computeTooltipPosition, type TooltipPosition } from '../lib/tooltipPosition.js';

/** Hover shows after a short pause, like a native tooltip but far faster. */
const HOVER_DELAY_MS = 350;
/** A control reached by Tab is already the user's deliberate target. */
const FOCUS_DELAY_MS = 0;

interface Shown {
  el: HTMLElement;
  text: string;
}

export function TooltipHost(): JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TooltipPosition | null>(null);

  // Tracks the element currently armed/shown, and what its `title` said
  // before this component blanked it, so it can be put back exactly as it
  // was found.
  const sourceRef = useRef<HTMLElement | null>(null);
  const stashRef = useRef<Map<HTMLElement, string>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stash = stashRef.current;

    function clearTimer(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function restore(el: HTMLElement): void {
      const original = stash.get(el);
      if (original !== undefined) {
        el.setAttribute('title', original);
        stash.delete(el);
      }
    }

    function hide(el: HTMLElement | null): void {
      clearTimer();
      if (sourceRef.current === el) sourceRef.current = null;
      if (el) restore(el);
      setShown((cur) => (cur !== null && (el === null || cur.el === el) ? null : cur));
    }

    function arm(target: EventTarget | null, delay: number): void {
      const el = target instanceof Element ? target : null;
      const source = el?.closest<HTMLElement>('[title]') ?? null;
      if (!source || source === sourceRef.current) return;
      // Moving straight from one `[title]` element into a NESTED one (e.g. a
      // sidebar row naming itself, around icon buttons that each name
      // themselves) skips the outer element's own mouseout/focusout — its
      // `title` must still be put back before the inner one is taken.
      if (sourceRef.current) hide(sourceRef.current);
      clearTimer();
      sourceRef.current = source;
      const text = source.getAttribute('title');
      if (!text) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (sourceRef.current !== source) return;
        // A re-render (e.g. the usage poll rebuilding a row) can replace the
        // hovered node during the pause; a detached node measures as an
        // all-zero rect and would pin the bubble to the window's corner.
        if (!source.isConnected) {
          sourceRef.current = null;
          return;
        }
        stash.set(source, text);
        source.removeAttribute('title');
        setShown({ el: source, text });
      }, delay);
    }

    /** Ignore leaving toward a node still inside the tracked source (e.g. its own children). */
    function leavingSource(source: HTMLElement, related: EventTarget | null): boolean {
      return related instanceof Node && source.contains(related);
    }

    function onMouseOver(e: MouseEvent): void {
      arm(e.target, HOVER_DELAY_MS);
    }
    function onMouseOut(e: MouseEvent): void {
      const source = sourceRef.current;
      if (source && !leavingSource(source, e.relatedTarget)) hide(source);
    }
    function onFocusIn(e: FocusEvent): void {
      arm(e.target, FOCUS_DELAY_MS);
    }
    function onFocusOut(e: FocusEvent): void {
      const source = sourceRef.current;
      if (source && !leavingSource(source, e.relatedTarget)) hide(source);
    }
    function onScroll(): void {
      hide(sourceRef.current);
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') hide(sourceRef.current);
    }

    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mouseover', onMouseOver);
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown);
      clearTimer();
      // A control could unmount mid-hover (e.g. the row it names is removed
      // from the list); its `title` must not stay lost.
      for (const [el, original] of stash) el.setAttribute('title', original);
      stash.clear();
    };
  }, []);

  // Two-phase: paint invisibly first so the bubble can be measured, then
  // place it — avoids guessing its width up front to centre it under a
  // control that ellipsises to very different widths.
  useLayoutEffect(() => {
    if (!shown) {
      setPos(null);
      return;
    }
    const bubble = bubbleRef.current;
    if (!bubble) return;
    if (!shown.el.isConnected) {
      setShown(null);
      return;
    }
    const trigger = shown.el.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    setPos(
      computeTooltipPosition(trigger, size, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [shown]);

  if (!shown) return null;

  return createPortal(
    <div
      ref={bubbleRef}
      className="app-tooltip"
      role="tooltip"
      data-testid="app-tooltip"
      data-placement={pos?.placement}
      style={{
        position: 'fixed',
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {shown.text}
    </div>,
    document.body,
  );
}
