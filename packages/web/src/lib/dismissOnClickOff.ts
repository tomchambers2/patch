// Click-off dismissal for anchored, non-modal pop-ups (spec/14 § Dismissing
// pop-ups (click-off)).
//
// Why this exists (Tom, `patch/todo.md` — "clicking off doesnt close the
// dropdowns"): the folder picker, the model picker and the composer's skill
// autocomplete could only be closed by re-clicking their trigger, picking a
// row, or pressing Esc. Clicking anywhere else — the empty chat body, the
// header — left the list hanging over the page, which reads as a stuck UI.
//
// The rule: a pointer-down OUTSIDE every registered region closes the pop-up; a
// pointer-down INSIDE any of them is left alone, so scrolling the browse tree,
// typing in the ad-hoc path field, or clicking the trigger (which owns its own
// toggle) all behave as before. Dismissal changes nothing else — nothing is
// selected and no text is cleared, exactly as Esc behaves.

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Call `onDismiss` when a pointer-down lands outside ALL of `regions` while
 * `open` is true.
 *
 * `pointerdown` (not `click`) so the pop-up closes on press, matching how every
 * native menu behaves and beating any re-render the click target triggers.
 * Registered in the CAPTURE phase so a region that stops propagation for its
 * own reasons can't silently disable dismissal.
 *
 * A region ref that is currently `null` is skipped — an unmounted region cannot
 * contain the event, so it simply doesn't protect anything.
 */
export function useDismissOnClickOff(
  open: boolean,
  regions: ReadonlyArray<RefObject<HTMLElement | null>>,
  onDismiss: () => void,
): void {
  // Callers pass a fresh array literal and inline callback every render; keep
  // the listener subscribed to `open` alone by reading both through a ref.
  const latest = useRef({ regions, onDismiss });
  latest.current = { regions, onDismiss };

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      // An event that reaches a listener on `document` was dispatched at a node
      // inside this document, so `target` is always a Node here — no defensive
      // branch to leave untested.
      const node = e.target as Node;
      const { regions: current, onDismiss: dismiss } = latest.current;
      if (current.some((r) => r.current?.contains(node) === true)) return;
      dismiss();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);
}
