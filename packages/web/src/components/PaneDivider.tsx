// PaneDivider — the drag-resizable handle between two children of a pane
// split (spec/14 § Panes and tabs — "Dividers are drag-resizable"). Same
// pointer-capture idiom as `ColumnDivider`, but resizes a pair of FRACTIONS
// (0..1, summing to 1 within the split) rather than a fixed pixel width, since
// a pane's size is relative to whatever the split container currently
// measures — not a persisted absolute pixel count.

import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useRef } from 'react';
import type { JSX } from 'react';

export function PaneDivider({
  direction,
  onResize,
}: {
  /** The split's own axis — 'row' resizes horizontally, 'column' vertically. */
  direction: 'row' | 'column';
  /** Called with the fraction (of the split container's own size) the pointer
   *  has moved since the drag started — positive grows the child BEFORE the
   *  divider. */
  onResize: (deltaFraction: number) => void;
}): JSX.Element {
  const startPos = useRef(0);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const container = e.currentTarget.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const containerSize = direction === 'row' ? rect.width : rect.height;
      if (containerSize <= 0) return;
      startPos.current = direction === 'row' ? e.clientX : e.clientY;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent): void => {
        const pos = direction === 'row' ? ev.clientX : ev.clientY;
        const delta = (pos - startPos.current) / containerSize;
        startPos.current = pos;
        onResize(delta);
      };
      const up = (ev: PointerEvent): void => {
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [direction, onResize],
  );

  return (
    <div
      className={`pane-divider pane-divider-${direction}`}
      role="separator"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
    />
  );
}
