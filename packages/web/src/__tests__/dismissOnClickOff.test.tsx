// Unit coverage for the click-off dismissal hook (spec/14 § Dismissing pop-ups
// (click-off)). The user-visible behaviour is asserted in the real browser
// (e2e/dropdown-click-off.spec.ts); these cover the hook's own edge cases — the
// closed state, unsubscribing on close, and a region whose ref is still null.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';

afterEach(cleanup);

function Harness({
  open,
  onDismiss,
  nullRegion = false,
}: {
  open: boolean;
  onDismiss: () => void;
  nullRegion?: boolean;
}): React.ReactElement {
  const inside = useRef<HTMLDivElement>(null);
  const absent = useRef<HTMLDivElement>(null);
  const regions: Array<RefObject<HTMLElement | null>> = nullRegion ? [absent, inside] : [inside];
  useDismissOnClickOff(open, regions, onDismiss);
  return (
    <div>
      <div ref={inside} data-testid="inside">
        <button type="button" data-testid="inside-child">
          in
        </button>
      </div>
      <button type="button" data-testid="outside">
        out
      </button>
    </div>
  );
}

function pointerDown(target: EventTarget): void {
  target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
}

describe('useDismissOnClickOff', () => {
  it('dismisses on a pointer-down outside every region', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness open onDismiss={onDismiss} />);
    pointerDown(getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss on a pointer-down inside a region (or its descendants)', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness open onDismiss={onDismiss} />);
    pointerDown(getByTestId('inside'));
    pointerDown(getByTestId('inside-child'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('listens only while open, and unsubscribes when it closes', () => {
    const onDismiss = vi.fn();
    const { getByTestId, rerender } = render(<Harness open={false} onDismiss={onDismiss} />);
    pointerDown(getByTestId('outside'));
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<Harness open onDismiss={onDismiss} />);
    pointerDown(getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<Harness open={false} onDismiss={onDismiss} />);
    pointerDown(getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('skips an unmounted (null) region rather than treating it as a match', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness open nullRegion onDismiss={onDismiss} />);
    pointerDown(getByTestId('inside'));
    expect(onDismiss).not.toHaveBeenCalled();
    pointerDown(getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
