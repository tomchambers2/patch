// Popup placement — keep an anchored pop-up inside the space it actually has.
//
// Why this exists (Tom, `patch/todo.md` — "folder picker gets cut off by the
// composer, cant reach browse or type a path"): the new-chat setup row sits low
// in the chat window, and its pop-ups (folder picker, model picker) dropped
// DOWNWARD into the narrow gap above the composer. The composer paints over
// them, so the Browse tree and the type-a-path field — the picker's whole
// escape hatch for a folder that isn't in the recents list — were unreachable
// at ordinary laptop heights. Meanwhile the top half of the chat window was
// empty.
//
// The rule: a pop-up opens on whichever side has more room, and is capped to
// that room so it scrolls internally instead of being clipped by something
// painted on top of it. The lower boundary is the composer when there is one —
// the viewport edge is not the real limit, the composer is.
//
// There is deliberately no minimum height: a floor larger than the real room
// pushes the pop-up back under the header/composer on short windows (phone
// landscape, split-screen, keyboard open) — the second "dropdown cut off".
// A short pop-up that scrolls is better than a tall one that is clipped.

import { useLayoutEffect, useState, type RefObject } from 'react';

/** Breathing room between the pop-up and the boundary it stops at. */
const MARGIN = 8;

export interface PopupPlacement {
  /** `up` renders the pop-up above its anchor, `down` below it. */
  direction: 'up' | 'down';
  /** Cap for the pop-up's height, in px. */
  maxHeight: number;
}

/**
 * The lower edge the pop-up must stay clear of. The composer is the real
 * boundary inside a chat window (it is painted over the transcript); anywhere
 * else, the viewport is.
 */
function lowerBound(el: HTMLElement): number {
  const composer = el.closest('main')?.querySelector('.composer');
  if (composer) return composer.getBoundingClientRect().top;
  return window.innerHeight;
}

/**
 * The upper edge the pop-up must stay clear of. The chat header is painted over
 * whatever sits under it, so a list that opens upward and is only capped to the
 * room above its anchor slides under the header and loses its first rows
 * (Todoist "dropdown cut off", phone-sized window).
 */
function upperBound(el: HTMLElement): number {
  const head = el.closest('main')?.querySelector('[data-testid="chat-head"]');
  if (head) return head.getBoundingClientRect().bottom;
  return 0;
}

/**
 * Measure the space around `anchorRef` and decide which way its pop-up should
 * open. Re-measures on open, on resize and on scroll — the anchor moves with
 * the transcript.
 */
export function usePopupPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): PopupPlacement {
  const [placement, setPlacement] = useState<PopupPlacement>({
    direction: 'down',
    maxHeight: 320,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;

    function measure(el: HTMLElement): void {
      const rect = el.getBoundingClientRect();
      const below = lowerBound(el) - rect.bottom - MARGIN;
      const above = rect.top - upperBound(el) - MARGIN;
      const direction = below >= above ? 'down' : 'up';
      const maxHeight = Math.max(0, Math.round(direction === 'down' ? below : above));
      setPlacement((prev) =>
        prev.direction === direction && prev.maxHeight === maxHeight
          ? prev
          : { direction, maxHeight },
      );
    }

    measure(anchor);
    const onChange = (): void => {
      measure(anchor);
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [anchorRef, open]);

  return placement;
}
