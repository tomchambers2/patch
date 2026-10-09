// SidebarExpandButton — the collapsed sidebar's own chevron (spec/14 §
// Sidebar §1, § Layout — desktop). See Sidebar.test.tsx for the collapse
// chevron ('sidebar-collapse') that lives inside the sidebar itself.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SidebarExpandButton } from '../components/SidebarExpandButton.js';
import { useUiStore } from '../stores/uiStore.js';

describe('SidebarExpandButton', () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarCollapsed: false });
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing while the sidebar is expanded', () => {
    const { container } = render(<SidebarExpandButton />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('sidebar-expand')).not.toBeInTheDocument();
  });

  it('shows the expand chevron once the sidebar is collapsed, and clicking it expands it', () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<SidebarExpandButton />);
    const btn = screen.getByTestId('sidebar-expand');
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});
