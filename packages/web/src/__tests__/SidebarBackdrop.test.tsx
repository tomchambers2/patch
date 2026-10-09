// SidebarBackdrop — the dimmed layer under the sidebar while it is a drawer
// (spec/14 § Layout → Narrow widths). The mirror image of SidebarExpandButton:
// that one exists only while the sidebar is collapsed, this one only while it
// is open.
//
// Whether the sidebar is a DRAWER (and so whether this is actually painted) is
// decided by the breakpoint in index.css, which jsdom neither loads nor
// computes — so the geometry and the hidden-at-desktop-widths half live in
// e2e/narrow-layout.spec.ts. What is testable here is the component's own
// contract: when it is in the tree, and what clicking it does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SidebarBackdrop } from '../components/SidebarBackdrop.js';
import { useUiStore } from '../stores/uiStore.js';

describe('SidebarBackdrop', () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarCollapsed: false });
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing while the sidebar is collapsed — there is no drawer to dismiss', () => {
    useUiStore.setState({ sidebarCollapsed: true });
    const { container } = render(<SidebarBackdrop />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('sidebar-backdrop')).not.toBeInTheDocument();
  });

  it('is in the tree while the sidebar is open', () => {
    render(<SidebarBackdrop />);
    expect(screen.getByTestId('sidebar-backdrop')).toBeInTheDocument();
  });

  it('closes the sidebar when clicked', () => {
    render(<SidebarBackdrop />);
    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });
});
