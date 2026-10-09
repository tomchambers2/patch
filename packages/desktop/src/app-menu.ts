// The application menu, which exists for exactly one reason: Reload.
//
// The whole Patch UI is a remote page. When the deployed SPA and the window
// disagree — the auto-reload didn't fire, a deploy landed while the app was
// asleep, the socket never reconnected — the only way back is to re-fetch it.
// Without a menu there was no way to do that at all: the app runs frameless
// with no accelerators of its own, so the only remedy anyone could offer was
// "quit and reopen", which is not a remedy for a window that is loading the
// wrong thing.
//
// Electron's DEFAULT menu does carry Reload, but it is replaced the moment
// anything sets a menu, and it carries a pile of items this app has no use for.
// So the menu is declared explicitly: the standard macOS app/edit/window roles
// that keep copy, paste and ⌘W behaving, plus View → Reload and Force Reload.
//
// Like context-menu.ts, this module is deliberately free of any electron
// RUNTIME import so it can be unit-tested under plain node — the box that runs
// the test gate is Linux and has no Electron binary at all, so a runtime import
// here fails the whole deploy. `shell.openExternal` is injected; only the
// template type is imported.

import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuDeps {
  /** `shell.openExternal`, injected so this file needs no electron runtime. */
  openExternal(url: string): void;
  /** Overridable for tests; defaults to the host platform. */
  platform?: NodeJS.Platform;
  /**
   * Where Help → Patch on the web points: the server this app is connected to,
   * when a browser could reach it (nothing is built in, spec/05 § Desktop first
   * run). Absent for a server that only this Mac can see.
   */
  webUrl?: string;
  /** App menu → Switch Server…: forget which server this app uses and ask again. */
  switchServer(): void;
}

export function buildAppMenuTemplate(
  appName: string,
  deps: AppMenuDeps,
): MenuItemConstructorOptions[] {
  const isMac = (deps.platform ?? process.platform) === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Switch Server…', click: () => deps.switchServer() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      // The point of the whole file. `reload` re-fetches the SPA entry (served
      // no-store), `forceReload` additionally bypasses the HTTP cache for the
      // hashed assets — the bigger hammer for "I am definitely on the wrong
      // build".
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  });

  const webUrl = deps.webUrl;
  template.push({
    role: 'help',
    submenu:
      webUrl === undefined
        ? []
        : [{ label: 'Patch on the web', click: () => deps.openExternal(webUrl) }],
  });

  return template;
}
