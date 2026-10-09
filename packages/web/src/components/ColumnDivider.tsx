// ColumnDivider — a drag-resizable handle between two layout columns
// (spec/14 ## Layout: "All column dividers are drag-resizable").
//
// Pointer-based: on drag, computes the new width from the pointer's clientX
// relative to an anchor and calls `onResize`. The owning store clamps + persists
// the value, so widths survive reload. `side` decides whether dragging right
// grows ('left' column, e.g. the sidebar) or shrinks ('right' column, e.g. the
// editor rail) the target. `onReset`, when given, wires a double-click to put
// the column back at its default width.

import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useRef } from 'react';

export function ColumnDivider({
  side,
  width,
  onResize,
  onReset,
  testId,
  className,
  style,
}: {
  /** Which column the width belongs to, relative to this divider. */
  side: 'left' | 'right';
  /** Current width of the target column (px). */
  width: number;
  /** Called with the proposed new width during the drag. */
  onResize: (next: number) => void;
  /** Double-click: reset to the default width. Omitted where there is none. */
  onReset?: () => void;
  testId?: string;
  /** Extra class alongside `col-divider` — a divider outside the normal flex
   * column flow (the web panel is a native view, not a DOM column) needs its
   * own positioning rule. */
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const startX = useRef(0);
  const startW = useRef(0);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      startX.current = e.clientX;
      startW.current = width;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent): void => {
        const delta = ev.clientX - startX.current;
        // Left column (sidebar): drag right → wider. Right column (editor):
        // drag right → narrower, so invert the delta.
        const next = side === 'left' ? startW.current + delta : startW.current - delta;
        onResize(next);
      };
      const up = (ev: PointerEvent): void => {
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [side, width, onResize],
  );

  return (
    <div
      className={className ? `col-divider ${className}` : 'col-divider'}
      style={style}
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}
