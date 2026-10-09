// SidebarExpandButton — the collapsed sidebar's only reachable control: a
// chevron near the shell's top-left that restores it (spec/14 §
// Layout — desktop, § Sidebar §1). Sizing and inset live on
// `.sidebar-expand-btn` in index.css — it is the sole way back to the
// sidebar, so it is a real hit target rather than the smallest thing that
// would fit. The `aside` itself unmounts while
// collapsed (`{sidebarCollapsed ? null : <Sidebar />}`), so this can't live
// inside Sidebar.tsx — it reads/writes useUiStore directly so AppShell and
// dev-harness can mount it unconditionally and let it decide its own
// visibility.

import type { JSX } from 'react';
import { ChevronRight } from 'lucide-react';
import { useUiStore } from '../stores/uiStore.js';
import { shortcutTitle } from '../lib/shortcuts.js';

export function SidebarExpandButton(): JSX.Element | null {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);

  if (!sidebarCollapsed) return null;

  return (
    <button
      type="button"
      className="sidebar-expand-btn"
      data-testid="sidebar-expand"
      aria-label="Expand sidebar"
      title={shortcutTitle('Expand sidebar', '⌘/')}
      onClick={() => setSidebarCollapsed(false)}
    >
      <ChevronRight size={16} aria-hidden />
    </button>
  );
}
