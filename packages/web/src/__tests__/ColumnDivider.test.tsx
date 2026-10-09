// ColumnDivider — pointer-drag resize handle. jsdom has no
// setPointerCapture/releasePointerCapture, so stub them on the target element
// before firing pointerdown, then dispatch window pointermove/pointerup.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColumnDivider } from '../components/ColumnDivider.js';

function stubPointerCapture(el: HTMLElement): void {
  (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();
  (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
    vi.fn();
}

describe('ColumnDivider', () => {
  it('renders a vertical separator with the given testId', () => {
    render(<ColumnDivider side="left" width={280} onResize={() => {}} testId="col-divider" />);
    const el = screen.getByTestId('col-divider');
    expect(el).toHaveAttribute('role', 'separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('side="left": dragging right makes the column wider (delta added)', () => {
    const onResize = vi.fn();
    render(<ColumnDivider side="left" width={280} onResize={onResize} testId="col-divider" />);
    const el = screen.getByTestId('col-divider');
    stubPointerCapture(el);

    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 140 }));
    expect(onResize).toHaveBeenCalledWith(320); // 280 + (140-100)

    fireEvent(window, new PointerEvent('pointerup', { pointerId: 1 }));

    // After pointerup, listeners are removed — a further pointermove has no effect.
    onResize.mockClear();
    fireEvent(window, new PointerEvent('pointermove', { clientX: 200 }));
    expect(onResize).not.toHaveBeenCalled();
  });

  it('side="right": dragging right makes the column narrower (delta subtracted)', () => {
    const onResize = vi.fn();
    render(<ColumnDivider side="right" width={380} onResize={onResize} testId="col-divider" />);
    const el = screen.getByTestId('col-divider');
    stubPointerCapture(el);

    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 140 }));
    expect(onResize).toHaveBeenCalledWith(340); // 380 - (140-100)

    fireEvent(window, new PointerEvent('pointerup', { pointerId: 1 }));
    expect(
      (el as unknown as { releasePointerCapture: ReturnType<typeof vi.fn> }).releasePointerCapture,
    ).toHaveBeenCalled();
  });

  it('preventDefault is called on pointerdown', () => {
    const onResize = vi.fn();
    render(<ColumnDivider side="left" width={280} onResize={onResize} testId="col-divider" />);
    const el = screen.getByTestId('col-divider');
    stubPointerCapture(el);
    const event = new PointerEvent('pointerdown', {
      clientX: 100,
      bubbles: true,
      cancelable: true,
    });
    const preventSpy = vi.spyOn(event, 'preventDefault');
    fireEvent(el, event);
    expect(preventSpy).toHaveBeenCalled();
  });

  it('renders without a testId when none is passed', () => {
    const { container } = render(<ColumnDivider side="left" width={280} onResize={() => {}} />);
    expect(container.querySelector('.col-divider')).toBeInTheDocument();
  });

  it('double-click calls onReset', () => {
    const onReset = vi.fn();
    render(
      <ColumnDivider
        side="right"
        width={400}
        onResize={() => {}}
        onReset={onReset}
        testId="col-divider"
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('col-divider'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('double-click is a no-op when no onReset is given', () => {
    render(<ColumnDivider side="right" width={400} onResize={() => {}} testId="col-divider" />);
    // Must not throw — a divider with no reset behaviour (sidebar, editor rail
    // today) still has to tolerate the browser's own double-click event.
    expect(() => fireEvent.doubleClick(screen.getByTestId('col-divider'))).not.toThrow();
  });

  it('merges an extra className and style onto the root, for dividers outside the normal flex flow', () => {
    // The web panel's divider (spec/14 § Links and the web panel) isn't a flex
    // sibling of the column it sizes — the panel is a native Electron view, not
    // a DOM column — so it needs its own position/right rule alongside the
    // shared col-divider look.
    const { container } = render(
      <ColumnDivider
        side="right"
        width={504}
        onResize={() => {}}
        testId="col-divider"
        className="panel-divider"
        style={{ right: 504 }}
      />,
    );
    const el = container.querySelector('.col-divider') as HTMLElement;
    expect(el).toHaveClass('panel-divider');
    expect(el.style.right).toBe('504px');
  });
});
