// SidebarBackdrop — dims the chat panel under the sidebar while it is a drawer
// (spec/14 § Layout → Narrow widths) and closes it on click.
//
// Mounted unconditionally beside the sidebar and left to decide its own
// visibility, the same shape as SidebarExpandButton. Whether the sidebar is a
// drawer at all is a pure CSS question (the breakpoint lives in index.css), so
// this only knows whether the sidebar is open — the stylesheet keeps it hidden
// at widths where the sidebar is a column.

import type { JSX } from 'react';
import { useUiStore } from '../stores/uiStore.js';

export function SidebarBackdrop(): JSX.Element | null {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);

  if (sidebarCollapsed) return null;

  return (
    <div
      className="sidebar-backdrop"
      data-testid="sidebar-backdrop"
      onClick={() => setSidebarCollapsed(true)}
    />
  );
}
