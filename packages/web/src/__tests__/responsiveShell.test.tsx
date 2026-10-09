// Narrow-viewport shell behaviour (spec/14 ## Layout → Narrow widths).
// Todoist: "stop the ugly horizontal scrolling at narrower widths". These
// unit tests cover the crossing-detection logic in isolation (jsdom, no
// browser layout); e2e/narrow-layout.spec.ts proves the same behaviour
// against real CSS.

import type { JSX } from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useResponsiveShell } from '../lib/responsiveShell.js';
import { useUiStore } from '../stores/uiStore.js';

function Harness(): JSX.Element {
  useResponsiveShell();
  return <div />;
}

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const ORIGINAL_WIDTH = window.innerWidth;

describe('useResponsiveShell', () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarCollapsed: false });
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: ORIGINAL_WIDTH,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: ORIGINAL_WIDTH,
    });
  });

  it('collapses the sidebar on mount if the viewport already loads narrower than 768px', () => {
    setWidth(1280); // baseline "wide" before mount so the assertion below is meaningful
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 700 });
    render(<Harness />);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('does not collapse the sidebar on mount at a wide viewport', () => {
    setWidth(1280);
    render(<Harness />);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('collapses the sidebar on a LIVE resize below 768px (not just on-mount)', () => {
    setWidth(1280);
    render(<Harness />);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    setWidth(700);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('does not re-fire (flap) on further resizes that stay on the narrow side, so a manual re-expand survives', () => {
    setWidth(1280);
    render(<Harness />);
    setWidth(700);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);

    // The user manually reopens it while still narrow.
    act(() => {
      useUiStore.getState().setSidebarCollapsed(false);
    });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);

    // A further resize that stays below 768px must not re-collapse it.
    setWidth(690);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('crossing back above the breakpoint does not force the sidebar back open', () => {
    setWidth(1280);
    render(<Harness />);
    setWidth(700);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    setWidth(1280);
    // Still collapsed — only the manual toggle re-opens it.
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('re-collapses on the NEXT genuine crossing after a manual re-expand', () => {
    setWidth(1280);
    render(<Harness />);
    setWidth(700);
    act(() => {
      useUiStore.getState().setSidebarCollapsed(false);
    });
    // Cross back above, then narrow again — a fresh crossing.
    setWidth(1280);
    setWidth(700);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('stops listening once unmounted', () => {
    setWidth(1280);
    const { unmount } = render(<Harness />);
    unmount();
    setWidth(700);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});
