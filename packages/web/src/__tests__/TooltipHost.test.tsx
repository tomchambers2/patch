// spec/14 § Copy — Tooltips: the app's own popover, not the browser's slow,
// unstyled built-in one. TooltipHost is the mechanism; the copy itself stays
// exactly what every `title="…"` already says (Sidebar.tooltips.test.tsx,
// tooltipCopy.test.ts, e2e/tooltip-copy.spec.ts pin that half).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { TooltipHost } from '../components/TooltipHost.js';

function Fixture(): JSX.Element {
  return (
    <div>
      <button data-testid="plain-btn" title="Archive">
        icon
      </button>
      <a data-testid="row" title="index-rebuild">
        <button data-testid="nested-btn" title="Pin">
          pin-icon
        </button>
      </a>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TooltipHost', () => {
  it('shows nothing until a title-bearing control is hovered', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
  });

  it('draws its own tooltip after a short hover pause, and blanks the native title meanwhile', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const btn = screen.getByTestId('plain-btn');
    fireEvent.mouseOver(btn);

    // Not yet — the pause hasn't elapsed.
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Archive');

    act(() => {
      vi.runAllTimers();
    });

    const bubble = screen.getByTestId('app-tooltip');
    expect(bubble.textContent).toBe('Archive');
    // Only ONE tooltip may show at a time — the native one must be silenced.
    expect(btn.getAttribute('title')).toBeNull();
  });

  it('restores the native title and hides on mouseout', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const btn = screen.getByTestId('plain-btn');
    fireEvent.mouseOver(btn);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId('app-tooltip')).toBeTruthy();

    fireEvent.mouseOut(btn, { relatedTarget: document.body });
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Archive');
  });

  it('cancels a pending show if the pointer leaves before the pause elapses', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const btn = screen.getByTestId('plain-btn');
    fireEvent.mouseOver(btn);
    fireEvent.mouseOut(btn, { relatedTarget: document.body });
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Archive');
  });

  it('shows immediately on keyboard focus, for a control reached without a pointer', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const btn = screen.getByTestId('plain-btn');
    fireEvent.focusIn(btn);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId('app-tooltip').textContent).toBe('Archive');

    fireEvent.focusOut(btn, { relatedTarget: document.body });
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Archive');
  });

  it('hides on Escape', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    fireEvent.mouseOver(screen.getByTestId('plain-btn'));
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId('app-tooltip')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
  });

  it('hides on scroll, since its position would go stale', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    fireEvent.mouseOver(screen.getByTestId('plain-btn'));
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId('app-tooltip')).toBeTruthy();

    fireEvent.scroll(document);
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
  });

  it('moving from a named row straight into one of its own named icons restores the row’s title and shows the icon’s', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const row = screen.getByTestId('row');
    const nested = screen.getByTestId('nested-btn');

    fireEvent.mouseOver(row);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId('app-tooltip').textContent).toBe('index-rebuild');

    // The row's own mouseout does not fire on this transition in a real
    // browser either — entering a child dispatches mouseover on the child
    // without first dispatching mouseout on the parent's own listeners in a
    // way that would restore it, which is exactly the case this component
    // has to cover itself.
    fireEvent.mouseOver(nested);
    expect(row.getAttribute('title')).toBe('index-rebuild');
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId('app-tooltip').textContent).toBe('Pin');
    expect(nested.getAttribute('title')).toBeNull();
  });

  it('restores every stashed title on unmount, so a control never loses its name for good', () => {
    const { unmount } = render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const btn = screen.getByTestId('plain-btn');
    fireEvent.mouseOver(btn);
    act(() => {
      vi.runAllTimers();
    });
    expect(btn.getAttribute('title')).toBeNull();

    unmount();
    expect(btn.getAttribute('title')).toBe('Archive');
  });
});

describe('TooltipHost — detached trigger', () => {
  it('shows nothing when the hovered node is replaced during the hover pause', () => {
    render(
      <>
        <Fixture />
        <TooltipHost />
      </>,
    );
    const btn = screen.getByTestId('plain-btn');
    fireEvent.mouseOver(btn);
    btn.remove();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('app-tooltip')).toBeNull();
  });
});
