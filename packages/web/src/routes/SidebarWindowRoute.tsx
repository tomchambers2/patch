// SidebarWindowRoute (/sidebar-window) — the sidebar detached into its own
// window (spec/14 § Sidebar §1, § New windows). Only reached by
// `lib/newWindow.ts`'s `openSidebarInNewWindow`; no chat panel, no editor
// rail, just the chat list filling the whole window.
//
// `standalone` tells Sidebar to fill 100% width (rather than the shared,
// persisted `sidebarWidth` meant for the three-column layout) and to hide the
// controls that only make sense docked in that layout — collapse (nothing to
// collapse back into here) and its own "open in new window" icon (this
// window already IS that).
//
// The `sidebar-window` class caps that 100% at the width the docked sidebar
// drags to, so a window widened past it shows a sidebar beside empty panel
// rather than a stretched chat list (spec/14 § New windows; cap in index.css).

import type { JSX } from 'react';
import { Sidebar } from '../components/Sidebar.js';

export function SidebarWindowRoute(): JSX.Element {
  return (
    <div className="three-col sidebar-window" data-testid="sidebar-window">
      <Sidebar standalone />
    </div>
  );
}
