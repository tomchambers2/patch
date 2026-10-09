// Right-click context menu for the main window's webContents.
//
// Electron windows have NO context menu by default — right-clicking a chat did
// nothing, so a user could not copy selected text, paste into the composer, or
// copy/open a link the "normal" way. This builds a native menu from the
// `context-menu` event params:
//
//   - On a link  → "Open Link in Patch" (the embedded web panel), "Open Link in
//     Browser" (the user's REAL browser) and "Copy Link Address". Both
//     destinations are named because this menu is where the choice is
//     DISCOVERABLE: a plain click opens the panel and a ⌘/Ctrl/Shift-click goes
//     to the browser, but neither gesture announces itself (spec/14 § Links and
//     the web panel). Patch leads, matching what a plain click does.
//   - Always     → Cut / Copy / Paste (native roles, enabled per editFlags) and
//     Select All, so the general copy/paste menu works everywhere.
//
// This module is intentionally free of any electron RUNTIME import so it can be
// unit-tested under plain node (see context-menu.test.ts): it takes the click
// handlers (shell.openExternal, clipboard.writeText) as injected deps and only
// type-imports MenuItemConstructorOptions.

import type { MenuItemConstructorOptions } from 'electron';

/** The subset of Electron's ContextMenuParams we consume. */
export interface ContextMenuParams {
  linkURL?: string;
  selectionText?: string;
  isEditable?: boolean;
  editFlags?: {
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canSelectAll?: boolean;
  };
}

/** Deps injected so the template stays electron-runtime-free and testable. */
export interface ContextMenuDeps {
  /** Open a URL in the user's real browser (shell.openExternal). */
  openExternal: (url: string) => void;
  /**
   * Show a URL in Patch's own web panel (main.ts `openInAppBrowser`, guarded by
   * the shared link policy so a `file:`/`javascript:` link is refused rather
   * than loaded).
   */
  openInPatch: (url: string) => void;
  /** Write a string to the system clipboard (clipboard.writeText). */
  writeText: (text: string) => void;
}

/**
 * Build the context-menu template for a right-click at `params`. Returns a
 * plain MenuItemConstructorOptions[] — the caller wraps it with
 * Menu.buildFromTemplate(...).popup().
 */
export function buildContextMenuTemplate(
  params: ContextMenuParams,
  deps: ContextMenuDeps,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const flags = params.editFlags ?? {};

  // --- Link actions (only when the click landed on a link) ---------------
  if (params.linkURL) {
    const url = params.linkURL;
    template.push(
      {
        label: 'Open Link in Patch',
        click: () => deps.openInPatch(url),
      },
      {
        label: 'Open Link in Browser',
        click: () => deps.openExternal(url),
      },
      {
        label: 'Copy Link Address',
        click: () => deps.writeText(url),
      },
      { type: 'separator' },
    );
  }

  // --- Editing actions (native roles: Electron dispatches cut/copy/paste to
  // the focused webContents itself). We set `enabled` from editFlags so the
  // items grey out when the action isn't applicable (e.g. paste in a
  // read-only view, copy with no selection). ---------------------------------
  template.push(
    { label: 'Cut', role: 'cut', enabled: flags.canCut ?? false },
    { label: 'Copy', role: 'copy', enabled: flags.canCopy ?? false },
    { label: 'Paste', role: 'paste', enabled: flags.canPaste ?? false },
    { type: 'separator' },
    { label: 'Select All', role: 'selectAll' },
  );

  return template;
}
