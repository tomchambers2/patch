// Smoke tests for the Electron main bundle. We don't boot Electron in
// node:test (the Electron binary spawns a Chromium subprocess); we assert
// on the source-level contracts that downstream tooling depends on:
//
//   - createMainWindow exists (electron-builder ships dist/main.js as
//     the package main; tests confirm the export name didn't drift)
//   - the desktop-event log is exposed for vitest assertions
//   - the global hotkey constant matches spec/14
//
// Real e2e (tray click → popover, hotkey press → overlay) requires a
// headed Electron run; documented as a manual smoke in packages/desktop/README.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_PERMISSIONS, decidePermission } from './permissions';

const here = __dirname;

test('main.ts exports createMainWindow + getDesktopEventLog', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /export function createMainWindow/);
  assert.match(src, /export function getDesktopEventLog/);
});

test('createMainWindow registers the module singleton (no duplicate/orphaned main windows)', () => {
  // Regression: createMainWindow used to return a window WITHOUT assigning the
  // `mainWindow` singleton, so getMainWindow() stayed null and every guarded
  // call site (`if (!mainWindow) mainWindow = createMainWindow()`) would spawn a
  // second, orphaned window. Behaviourally asserted in smoke-integration.cjs
  // (`main-window-singleton`); the source contract is that the factory body
  // assigns the singleton before returning.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(
    src.indexOf('export function createMainWindow'),
    src.indexOf('/** Tray popover'),
  );
  assert.match(body, /\bmainWindow = win\b/);
  assert.match(body, /return win;/);
});

test('both document windows drop the native title bar (spec/05 § Window chrome)', () => {
  // Tom, App Updates: "clean at top, no patch top bar. window extends right to
  // top of screen." The decision itself lives in window-chrome.ts and is tested
  // there; what this pins is that BOTH document-window factories actually apply
  // it — a child window that kept its native bar would still show the bar he
  // asked to be rid of, since a detached chat is the same UI as the main window.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const childBody = src.slice(
    src.indexOf('export function openChildWindow'),
    src.indexOf('export function createMainWindow'),
  );
  const mainBody = src.slice(
    src.indexOf('export function createMainWindow'),
    src.indexOf('/** Tray popover'),
  );
  assert.match(childBody, /\.\.\.windowChrome\(process\.platform\)/, 'child window keeps a frame');
  assert.match(mainBody, /\.\.\.windowChrome\(process\.platform\)/, 'main window keeps a frame');
});

test('the renderer is told whether its window has an overlay title bar', () => {
  // The SPA has to reserve the traffic lights' strip and supply its own drag
  // region, and it must do both on the FIRST paint — hence a plain preload
  // value rather than an awaited IPC round trip that would land a frame late.
  // (Why the rule is inlined instead of imported, and what breaks if it isn't,
  // is pinned by window-chrome.test.ts.)
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /overlayTitleBar:\s*process\.platform === 'darwin'/);
});

test('main.ts registers a configurable global hotkey (default ⌃ Space) per spec/14 + DX-11', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  // Group 20 fix DX-11: the accelerator string is now an env-overridable
  // const, defaulting to Control+Space.
  assert.match(src, /PATCH_GLOBAL_HOTKEY/);
  assert.match(src, /['"]Control\+Space['"]/);
  // Bound to the exported production handler so the OS-global binding and its
  // effect are one and the same (driveable by the real-Electron G4-14 smoke).
  assert.match(src, /globalShortcut\.register\(GLOBAL_HOTKEY,\s*onGlobalVoiceNoteHotkey\)/);
  assert.match(src, /export function onGlobalVoiceNoteHotkey/);
});

test('main→renderer start payloads are readiness-gated (cold-press IPC not dropped)', () => {
  // Regression: onGlobalVoiceNoteHotkey created the overlay (async loadURL) then
  // SYNCHRONOUSLY webContents.send'd start-voice-note — on the first press the
  // renderer wasn't loaded so Electron dropped the message and the voice note
  // never started. Proven by scripts/debug-overlay-send.cjs (EARLY send lost).
  // Delivery (when ready) is asserted behaviourally in smoke-integration.cjs
  // (voice-note-targets-manager / voice-call-targets-manager). Source contract:
  // these sends go through sendWhenReady, not a raw webContents.send.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /function sendWhenReady/);
  assert.match(src, /wc\.once\(['"]did-finish-load['"]/);
  assert.match(src, /sendWhenReady\(voiceOverlay, 'patch:start-voice-note'/);
  assert.match(src, /sendWhenReady\(mainWindow, 'patch:start-voice-call'/);
  assert.match(src, /sendWhenReady\(mainWindow, 'patch:navigate'/);
  // the overlay/call/navigate sends must NOT be raw synchronous sends
  assert.doesNotMatch(src, /voiceOverlay\.webContents\.send\(/);
});

test('main.ts registers ⌃⇧Space voice-call hotkey per spec/14', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /PATCH_GLOBAL_CALL_HOTKEY/);
  assert.match(src, /['"]Control\+Shift\+Space['"]/);
  assert.match(src, /globalShortcut\.register\(GLOBAL_CALL_HOTKEY,\s*onGlobalVoiceCallHotkey\)/);
  assert.match(src, /export function onGlobalVoiceCallHotkey/);
  assert.match(src, /patch:start-voice-call/);
});

test('main.ts exports a voice-overlay accessor for smoke introspection', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /export function getVoiceOverlay/);
});

test('preload.ts exposes onStartVoiceCall for the ⌃⇧Space call hotkey', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /patch:start-voice-call/);
  assert.match(src, /onStartVoiceCall/);
});

test('preload.ts exposes onNavigate, the channel a clicked notification routes on', () => {
  // spec/09 § `### desktop` — main sees the toast click, the SPA does the
  // routing. Renaming this method or its channel silently breaks the deep link
  // in both directions: main keeps sending and the renderer keeps listening,
  // just not to each other. The renderer's half is
  // `packages/web/src/__tests__/AppShell.test.tsx` ("desktop bridge: a
  // notification click routes the SPA to the chat it came from").
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /patch:navigate/);
  assert.match(src, /onNavigate/);
});

test('main.ts sends user link clicks to the REAL browser via BOTH window-open and will-navigate', () => {
  // spec/14 § Links and the web panel: a link the USER clicks leaves Patch for
  // the OS browser — it must NOT load in the embedded web panel (that panel is
  // for pages Patch itself wants to show) and must never navigate the SPA away.
  // Two paths reach here: setWindowOpenHandler (window.open / target=_blank) and
  // will-navigate (a plain <a href> click is an in-place navigation of the main
  // webContents). Both go through routeLink (link-policy.test.ts).
  //
  // Both paths — and the context menu — are wired by attachWindowLinkPolicy,
  // shared between createMainWindow and openChildWindow (spec/14 § New
  // windows) so a link inside a detached window behaves identically.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(
    src.indexOf('function attachWindowLinkPolicy'),
    src.indexOf('// Windows opened via `openChildWindow`'),
  );
  assert.match(body, /setWindowOpenHandler/);
  assert.match(body, /webContents\.on\(['"]will-navigate['"]/);
  assert.match(body, /event\.preventDefault\(\)/);
  const navSection = body.slice(body.indexOf('setWindowOpenHandler'), body.indexOf('context-menu'));
  // Both paths consult the shared policy, and they route DIFFERENTLY on purpose
  // (spec/14 § Links and the web panel): the window-open path (a modified
  // click, target=_blank, window.open) hands the URL to the real browser, while
  // a plain in-place click opens Patch's own web panel.
  assert.match(navSection, /routeWindowOpen\(url\)/);
  assert.match(navSection, /routeLink\(url, SERVER_URL\)/);
  const windowOpenSection = navSection.slice(0, navSection.indexOf("'will-navigate'"));
  const willNavigateSection = navSection.slice(navSection.indexOf("'will-navigate'"));
  assert.match(
    windowOpenSection,
    /action\.kind === 'external'.*shell\.openExternal/s,
    'a modified click / target=_blank must go to the real browser',
  );
  assert.match(
    willNavigateSection,
    /action\.kind === 'panel'.*openInAppBrowser\(win, action\.url\)/s,
    'a plain click on an external link must open the Patch web panel',
  );
  assert.doesNotMatch(
    willNavigateSection,
    /shell\.openExternal\(/,
    'a plain click must not ALSO bounce to the real browser',
  );
  assert.match(src, /import \{ routeLink, routeWindowOpen \} from ['"]\.\/link-policy['"]/);
  // createMainWindow and openChildWindow both apply the shared policy rather
  // than wiring their own copy.
  const mainBody = src.slice(
    src.indexOf('export function createMainWindow'),
    src.indexOf('/** Tray popover'),
  );
  assert.match(mainBody, /attachWindowLinkPolicy\(win\)/);
  const childBody = src.slice(
    src.indexOf('export function openChildWindow'),
    src.indexOf('export function createMainWindow'),
  );
  assert.match(childBody, /attachWindowLinkPolicy\(win\)/);
});

test('main.ts exposes the web-panel controller + open helper (Patch-initiated pages only)', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /import \{ InAppBrowser \} from ['"]\.\/in-app-browser['"]/);
  assert.match(src, /export function getInAppBrowser/);
  assert.match(src, /export function openInAppBrowser/);
  // toolbar buttons drive the controller over IPC
  assert.match(src, /ipcMain\.on\(['"]patch:iab:back['"]/);
  assert.match(src, /ipcMain\.on\(['"]patch:iab:forward['"]/);
  assert.match(src, /ipcMain\.on\(['"]patch:iab:reload['"]/);
  assert.match(src, /ipcMain\.on\(['"]patch:iab:open-external['"]/);
  assert.match(src, /ipcMain\.on\(['"]patch:iab:close['"]/);
  // Patch's own surfaces ask for the panel over IPC — the ONLY way it opens.
  assert.match(src, /ipcMain\.on\(['"]patch:panel:open['"]/);
});

test('main.ts lets the renderer CLOSE the panel (spec/14 § Artifacts — it follows the chat)', () => {
  // The panel shows the artifact of the chat you are in, so opening a chat with
  // no artifact, or leaving the chat route, has to put the panel away. That is
  // a renderer-driven close and needs its own channel: `patch:iab:close` is the
  // panel toolbar's own button, on the iab-preload bridge the SPA cannot reach.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /ipcMain\.on\(['"]patch:panel:close['"]/);
  const handler = src.slice(
    src.indexOf("ipcMain.on('patch:panel:close'"),
    src.indexOf("ipcMain.on('patch:notify'"),
  );
  assert.ok(handler.length > 0, 'patch:panel:close handler not found');
  assert.match(handler, /inAppBrowser\?\.close\(\)/);
});

test('patch:panel:open refuses a non-http(s) / unparseable URL (NO FALLBACK)', () => {
  // spec/14 § Links and the web panel: the panel is opened by Patch itself, and
  // even then only for a real web page. The handler routes the requested URL
  // through the shared policy and opens the panel ONLY for `external` — a
  // `file:`/`javascript:`/garbage URL is dropped, never loaded and never
  // "helpfully" rewritten.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const handler = src.slice(
    src.indexOf("ipcMain.on('patch:panel:open'"),
    src.indexOf("ipcMain.on('patch:notify'"),
  );
  assert.ok(handler.length > 0, 'patch:panel:open handler not found');
  assert.match(handler, /routeWindowOpen\(/);
  assert.match(handler, /action\.kind === 'external'/);
  assert.equal(
    (handler.match(/openInAppBrowser\(/g) || []).length,
    1,
    'the panel must open on exactly one guarded path',
  );
});

test('preload.ts exposes the web-panel bridge (open + inset) the renderer needs', () => {
  // The renderer opens the panel through `openPanel` and insets itself by the
  // width main pushes on `patch:panel-inset` (AppShell), which is what makes it
  // a SIDE panel rather than an overlay. Drop either half and the panel covers
  // the chat and composer.
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /openPanel\(url: string\)/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:panel:open['"]/);
  assert.match(src, /onPanelInset\(/);
  assert.match(src, /ipcRenderer\.on\(['"]patch:panel-inset['"]/);
  assert.match(src, /removeListener\(['"]patch:panel-inset['"]/);
  // spec/14 § Artifacts — and the close half, so the renderer can put the panel
  // away when the chat it belongs to is no longer the one on screen. Without it
  // one chat's artifact sits next to every other chat's transcript.
  assert.match(src, /closePanel\(\): void/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:panel:close['"]/);
});

test('preload.ts exposes the panel-divider drag + reset bridge', () => {
  // spec/14 § Links and the web panel: "drag-resizable like every other
  // column." The divider lives in the renderer, but the panel it sizes is a
  // native view only main can move — so both the live drag and the
  // double-click reset have to round-trip through IPC.
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /resizePanel\(width: number\)/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:panel:resize['"]/);
  assert.match(src, /resetPanelWidth\(\): void/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:panel:reset-width['"]/);
});

test('main.ts wires the panel-divider drag + reset to the controller, and persists the result', () => {
  // Every pointermove during a drag fires `patch:panel:resize` — it must reach
  // resizeTo (which moves the real WebContentsViews live) rather than just
  // pushing the inset, and the resulting share must be saved so it survives a
  // restart (spec/14: "persists across opens and restarts").
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /ipcMain\.on\(['"]patch:panel:resize['"]/);
  const resizeHandler = src.slice(
    src.indexOf("ipcMain.on('patch:panel:resize'"),
    src.indexOf("ipcMain.on('patch:panel:reset-width'"),
  );
  assert.ok(resizeHandler.length > 0, 'patch:panel:resize handler not found');
  assert.match(resizeHandler, /inAppBrowser\.resizeTo\(/);
  assert.match(resizeHandler, /schedulePanelWidthSave\(/);

  assert.match(src, /ipcMain\.on\(['"]patch:panel:reset-width['"]/);
  const resetHandler = src.slice(
    src.indexOf("ipcMain.on('patch:panel:reset-width'"),
    src.indexOf("ipcMain.on('patch:window:open'"),
  );
  assert.ok(resetHandler.length > 0, 'patch:panel:reset-width handler not found');
  assert.match(resetHandler, /inAppBrowser\.resetWidth\(\)/);
  assert.match(resetHandler, /schedulePanelWidthSave\(/);
});

test('main.ts persists the dragged panel share to userData and reloads it for new panels', () => {
  // spec/14: "window resizes keep the same share" and the share survives a
  // restart — both need main to own the value independent of any one
  // InAppBrowser instance (a link clicked in another window tears the old
  // instance down and builds a new one; a Patch-opened page never goes through
  // the renderer at all).
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(
    src,
    /PANEL_LAYOUT_FILE.*=.*join\(app\.getPath\(['"]userData['"]\), ['"]panel-layout\.json['"]\)/,
  );
  assert.match(src, /function loadPanelWidthFraction/);
  assert.match(src, /function schedulePanelWidthSave/);
  // Loaded once at IPC registration (app startup) …
  assert.match(src, /panelWidthFraction = loadPanelWidthFraction\(\)/);
  // … and threaded into every new controller, not just the first.
  assert.match(src, /new InAppBrowser\(win, panelWidthFraction\)/);
});

test('main.ts wires a webContents right-click context menu (copy/paste + link actions)', () => {
  // Electron windows have no context menu by default. attachWindowLinkPolicy
  // (applied to every Patch window, including the main one) must register a
  // `context-menu` handler that builds the menu from buildContextMenuTemplate
  // and pops it up. Menu-item behaviour (Open Link → shell.openExternal,
  // roles, enable/disable) is unit-tested in context-menu.test.ts; here we
  // assert the wiring exists.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(
    src.indexOf('function attachWindowLinkPolicy'),
    src.indexOf('// Windows opened via `openChildWindow`'),
  );
  assert.match(body, /webContents\.on\(['"]context-menu['"]/);
  assert.match(body, /buildContextMenuTemplate\(/);
  assert.match(body, /Menu\.buildFromTemplate\(template\)\.popup\(/);
  // Link actions: "Open Link in Browser" → the real browser; "Open Link in
  // Patch" → the embedded web panel, guarded by the shared policy so a
  // file:/javascript: link can never be loaded into it; "Copy Link Address" →
  // clipboard (spec/14 § Links and the web panel).
  assert.match(body, /openInPatch:/);
  assert.match(body, /openInAppBrowser\(win,/);
  assert.match(body, /openExternal:.*shell\.openExternal/);
  assert.match(body, /writeText:.*clipboard\.writeText/);
  // and the module imports buildContextMenuTemplate + clipboard.
  assert.match(src, /import \{ buildContextMenuTemplate \} from ['"]\.\/context-menu['"]/);
  assert.match(src, /\bclipboard\b/);
  // createMainWindow applies the shared policy rather than wiring its own copy.
  const mainBody = src.slice(
    src.indexOf('export function createMainWindow'),
    src.indexOf('/** Tray popover'),
  );
  assert.match(mainBody, /attachWindowLinkPolicy\(win\)/);
});

test('context-menu handler skips the native menu inside a Monaco editor', () => {
  // Regression: "file editor: proper right-click context menus". Monaco pops
  // its own rich context menu (undo/redo, format, go to definition, ...) on
  // the same right-click's DOM event, via a floating div — completely
  // independent of Electron's native webContents 'context-menu' event, which
  // always fires regardless of whether the page called preventDefault(). With
  // no guard, attachWindowLinkPolicy's handler popped the generic native
  // Cut/Copy/Paste menu on top of Monaco's own menu on every right-click
  // inside the file editor, so the file editor showed two overlapping menus.
  // The handler must check whether the click landed inside `.monaco-editor`
  // (via executeJavaScript + elementFromPoint, using the click's own
  // coordinates from ContextMenuParams) and skip its own popup there, leaving
  // Monaco's menu as the only one.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(
    src.indexOf('function attachWindowLinkPolicy'),
    src.indexOf('// Windows opened via `openChildWindow`'),
  );
  assert.match(body, /closest\(['"]\.monaco-editor['"]\)/);
  assert.match(body, /elementFromPoint\(/);
  assert.match(body, /executeJavaScript\(/);
  // The Monaco check must run, and be able to bail, BEFORE the popup call —
  // not just exist somewhere in the handler.
  const menuIndex = body.indexOf("webContents.on('context-menu'");
  const monacoCheckIndex = body.indexOf('monaco-editor', menuIndex);
  const popupIndex = body.indexOf('.popup(', menuIndex);
  assert.ok(menuIndex >= 0, 'context-menu handler not found');
  assert.ok(
    monacoCheckIndex > menuIndex && monacoCheckIndex < popupIndex,
    'Monaco guard must sit between the handler start and the popup call',
  );
});

test('bootstrap wires the permission gate onto session.defaultSession', () => {
  // Regression: the renderer's voice-note/voice-call getUserMedia({audio}) calls
  // were denied because Electron refuses the `media` permission unless the main
  // process approves it — no handler was registered, so the mic never opened and
  // voice did nothing on the desktop app. bootstrap must wire the gate, and onto
  // the DEFAULT session: a handler registered on any other session leaves the
  // renderer running under Electron's own defaults. Decision logic is
  // unit-tested in permissions.test.ts; here we assert the wiring + import.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /import \{ configurePermissions \} from ['"]\.\/permissions['"]/);
  assert.match(src, /configurePermissions\(session\.defaultSession, SERVER_URL\)/);
});

test('the gate wired onto the default session grants the clipboard write', () => {
  // Regression (as end-to-end as this gets without booting Electron): the
  // code-block copy control and Copy report call navigator.clipboard.writeText(),
  // which Chromium gates on `clipboard-sanitized-write`. Registering the mic
  // handler above replaced Electron's own defaults, and the set it granted did
  // not include the clipboard, so every copy in the packaged app failed while
  // the same code worked in a browser. The set bootstrap configures the default
  // session with must carry it for the app's origin — and must still refuse a
  // clipboard READ.
  assert.ok(ALLOWED_PERMISSIONS.includes('clipboard-sanitized-write'));
  assert.ok(!ALLOWED_PERMISSIONS.includes('clipboard-read'));
  const app = 'https://patch.tomchambers.me';
  assert.equal(decidePermission('clipboard-sanitized-write', `${app}/app/`, app), true);
  assert.equal(decidePermission('clipboard-read', `${app}/app/`, app), false);
});

test('main.ts wires Tray click + right-click handlers', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /t\.on\(['"]click['"]/);
  assert.match(src, /t\.on\(['"]right-click['"]/);
});

test('main.ts wires native Notification with click → focus app', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /new Notification\(/);
  assert.match(src, /n\.on\(['"]click['"]/);
});

// spec/09 § Notification actions. A toast with `actions` wires BOTH native
// response events; main decides what they mean (notificationActions.ts) and
// hands the result to the renderer rather than acting on it directly — only
// the renderer holds the live WS + guaranteed-delivery trackers.
test('main.ts wires Notification reply/action to dispatchNotificationAction', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /buildNotificationExtras\(/);
  assert.match(src, /n\.on\(['"]reply['"]/);
  assert.match(src, /n\.on\(['"]action['"]/);
  assert.match(src, /decideDesktopIntent\(/);
});

test("a decided action is sent to the renderer over 'patch:notification-send', keyed by requestId", () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /pendingNotificationSends/);
  assert.match(src, /sendWhenReady\(mainWindow, ['"]patch:notification-send['"]/);
  assert.match(src, /ipcMain\.on\(\s*['"]patch:notification-send-result['"]/);
});

test('a failed send keeps the typed text/decision for retry, and a successful one shows Sent', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(
    src.indexOf('function dispatchNotificationAction'),
    src.indexOf('function registerIpc'),
  );
  assert.match(body, /'Sent'/);
  assert.match(body, /'Not sent — tap to retry'/);
  assert.match(body, /retry:\s*\{\s*chatId/);
});

test('main.ts wires electron-updater with every outcome recorded', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /from ['"]electron-updater['"]/);
  assert.match(src, /autoUpdater\.checkForUpdates\(\)/);
  // `checkForUpdatesAndNotify` was fire-and-forget: no result, no error, no
  // timestamp. The panel needs all three, so every event is now folded into the
  // updater state (see updater.ts / updater.test.ts).
  assert.match(src, /autoUpdater\.on\(['"]update-not-available['"]/);
  assert.match(src, /autoUpdater\.on\(['"]update-available['"]/);
  assert.match(src, /autoUpdater\.on\(['"]update-downloaded['"]/);
  assert.match(src, /autoUpdater\.on\(['"]error['"]/);
});

test('main.ts diagnoses WHY the updater is inert rather than silently returning', () => {
  // The shipped app hit `if (!existsSync(app-update.yml)) return;` on every launch
  // and said nothing. diagnoseUpdater turns each such condition into a reportable
  // reason, and the state is exposed to the panel over IPC.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /diagnoseUpdater\(/);
  assert.match(src, /ipcMain\.handle\(['"]patch:updater:get-state['"]/);
  assert.match(src, /ipcMain\.handle\(['"]patch:updater:check['"]/);
});

test('preload.ts exposes the updater bridge for the version panel', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /getUpdaterState/);
  assert.match(src, /checkForUpdates/);
  assert.match(src, /patch:updater-state/);
});

// spec/09 § Presence heuristic — the server routes notifications by whether
// Tom is at the computer, which only the main process can see (any app's input).
test('the system idle time reaches the renderer over one IPC channel', () => {
  const main = readFileSync(join(here, 'main.ts'), 'utf8');
  const preload = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(
    main,
    /ipcMain\.handle\(\s*['"]patch:system-idle-ms['"],\s*\(\) => powerMonitor\.getSystemIdleTime\(\) \* 1000/,
  );
  assert.match(preload, /getSystemIdleMs/);
  assert.match(preload, /invoke\(['"]patch:system-idle-ms['"]\)/);
});

test('preload.ts exposes the patch bridge via contextBridge', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /contextBridge\.exposeInMainWorld\(['"]patch['"]/);
  assert.match(src, /patch:notify/);
  assert.match(src, /patch:start-voice-note/);
});

test('main.ts raises the main window on an incoming call via patch:request-raise IPC (spec/14)', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  // The IPC handler is wired, the raise helper foregrounds + steals focus on
  // macOS (renderer window.focus() can't raise a backgrounded Electron window).
  assert.match(src, /ipcMain\.on\(['"]patch:request-raise['"]/);
  assert.match(src, /export function raiseMainWindow/);
  assert.match(src, /app\.focus\(\{\s*steal:\s*true\s*\}\)/);
  assert.match(src, /mainWindow\.show\(\)/);
});

test('preload.ts exposes requestRaise for the incoming-call window raise', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /requestRaise/);
  assert.match(src, /patch:request-raise/);
});

test('Cmd+W hides the window (lifecycle keeps tray + hotkey alive)', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /win\.on\(['"]close['"]/);
  assert.match(src, /win\.hide\(\)/);
});

test('tray popover show/hide drives patch:menubar-visibility from the imperative call sites (spec/05)', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  // Regression (heartbeat-never-stops): the visibility IPC used to ride on
  // `win.on('show'/'hide')`, but those BrowserWindow events are unreliable on
  // macOS — `hide()` genuinely hides the window yet 'hide' frequently never
  // fires, so the renderer never got visible:false and beat its heartbeat
  // forever. The signal now comes from the imperative show/hide call sites
  // (showTrayPopover → true, hideTrayPopover → false), proven end-to-end by
  // smoke-integration.cjs (`menubar-visibility-last-is-false-when-closed`).
  assert.doesNotMatch(src, /win\.on\(['"]hide['"]/, 'must not depend on the flaky hide event');
  assert.match(src, /function sendPopoverVisibility/);
  assert.match(src, /function showTrayPopover[\s\S]*?sendPopoverVisibility\(true\)/);
  assert.match(src, /function hideTrayPopover[\s\S]*?sendPopoverVisibility\(false\)/);
  // both hide paths route through hideTrayPopover: the blur grace timer calls it
  // directly, and the tray-click toggle calls it on a 'hide' decision.
  assert.match(src, /blurTimer = setTimeout\([\s\S]*?hideTrayPopover\(\)/);
  assert.match(src, /if \(action === 'hide'\)\s*\{\s*hideTrayPopover\(\)/);
});

test("tray click routes through decideTrayClick so a second click can't reopen (blur race)", () => {
  // Regression: patch/todo.md "Second click of Patch menu bar opens it — should
  // just close." The naive `isVisible() ? hide() : show()` toggle re-opened the
  // popover when the blur-driven auto-hide landed before the click read
  // isVisible(). The decision now goes through decideTrayClick (unit-tested in
  // tray-toggle.test.ts) fed the live visibility + last-hide timestamp.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /import \{ decideTrayClick \} from ['"]\.\/tray-toggle['"]/);
  // hideTrayPopover records when it hid, so a click from the same gesture is
  // recognised as "closing", not "reopening".
  assert.match(src, /function hideTrayPopover[\s\S]*?popoverHiddenAt = Date\.now\(\)/);
  // the tray click handler feeds decideTrayClick the live state.
  assert.match(
    src,
    /t\.on\(['"]click['"][\s\S]*?decideTrayClick\(\{[\s\S]*?hiddenAt: popoverHiddenAt/,
  );
});

test('preload.ts exposes onMenubarVisibility for the menu-bar heartbeat gate', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /onMenubarVisibility/);
  assert.match(src, /patch:menubar-visibility/);
});

test("the shell offers NO native folder picker (spec/04 - browsing is the host's FS)", () => {
  // The host usually runs on another host, so a folder chosen from THIS
  // machine's disk is a path the host does not have and every chat spawned
  // into it dies with folder_not_found. The desktop app browses the host's
  // tree like every other surface — so neither half of the old native-picker
  // bridge may exist.
  const main = readFileSync(join(here, 'main.ts'), 'utf8');
  const preload = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.doesNotMatch(main, /patch:pick-folder/);
  assert.doesNotMatch(main, /showOpenDialog/);
  assert.doesNotMatch(preload, /pickFolder/);
  assert.doesNotMatch(preload, /patch:pick-folder/);
});

test('main.ts exports openChildWindow + getChildWindows for "open in new window" (spec/14 § New windows)', () => {
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /export function openChildWindow/);
  assert.match(src, /export function getChildWindows/);
  const body = src.slice(
    src.indexOf('export function openChildWindow'),
    src.indexOf('export function createMainWindow'),
  );
  // A child window is NEVER the singleton main window and applies the same
  // link policy every other window gets.
  assert.doesNotMatch(body, /\bmainWindow = win\b/);
  assert.match(body, /routeUrl\(routePath\)/);
  assert.match(body, /attachWindowLinkPolicy\(win\)/);
  assert.match(body, /childWindows\.add\(win\)/);
  // it closes like an ordinary window — no hide-on-close singleton behaviour.
  assert.doesNotMatch(body, /win\.on\(['"]close['"]/);
  assert.match(body, /win\.on\(['"]closed['"],\s*\(\)\s*=>\s*childWindows\.delete\(win\)\)/);
});

test('main.ts registers patch:window:open — opens a NEW window, never routed through setWindowOpenHandler', () => {
  // spec/14 § New windows: the renderer's explicit "open in new window"
  // actions (lib/newWindow.ts) go through their OWN dedicated IPC channel,
  // never through window.open — setWindowOpenHandler unconditionally denies
  // (the "Nothing may spawn a new Electron window" comment on that path
  // still holds; this is a deliberately separate path).
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const handler = src.slice(
    src.indexOf("ipcMain.on('patch:window:open'"),
    src.indexOf("ipcMain.on('patch:window:open'") + 400,
  );
  assert.ok(handler.length > 0, 'patch:window:open handler not found');
  assert.match(handler, /openChildWindow\(\s*path,\s*parseWindowSize\(payload\?\.size\)\)/);
  // malformed payload (missing/non-string/non-rooted path) is a no-op.
  assert.match(handler, /typeof path === 'string'/);
  assert.match(handler, /path\.startsWith\('\/'\)/);
});

test('routeUrl carries a query string on the routePath itself without corrupting it', () => {
  // spec/14 § New windows: openChildWindow('/chats/<id>?sidebar=hidden') must
  // reach the SPA with `sidebar=hidden` intact. The WHATWG `pathname` setter
  // percent-encodes a literal '?', so routeUrl must split it off first.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(src.indexOf('function routeUrl'), src.indexOf('function menubarUrl'));
  assert.match(body, /routePath\.split\(['"]\?['"]\)/);
  assert.doesNotMatch(
    body,
    /u\.pathname = `\$\{baseDir\}\/\$\{routePath\}`/,
    'must not assign the raw (possibly query-bearing) routePath straight into pathname',
  );
});

test('routeUrl strips a leading slash from routePath so a rooted path never doubles up with baseDir (Todoist: sidebar-in-new-window opened the full app shell instead of detaching)', () => {
  // `openChildWindow` is always called with a leading-slash routePath
  // (`/sidebar-window`, `/chats/<id>?sidebar=hidden` — see lib/newWindow.ts),
  // while menubarUrl()/voiceOverlayUrl() pass a bare segment ('menubar'). Since
  // `baseDir` already has no trailing slash, joining a leading-slash `path`
  // with a literal '/' produced a double slash (`…/app//sidebar-window`),
  // which react-router's matchPath does NOT treat as equivalent to the
  // single-slash route — so none of AppShell's <Route>s matched and the
  // window silently fell through to rendering the full app shell (with its
  // own embedded Sidebar) instead of the intended bare, standalone
  // `/sidebar-window` route. Behaviourally proven in smoke-integration.cjs's
  // `sidebar-window-*` checks (real Electron, real BrowserWindow.getURL()).
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(src.indexOf('function routeUrl'), src.indexOf('function menubarUrl'));
  assert.match(body, /path\s*\?\?\s*['"]{2}[^)]*\)\.replace\(\/\^\\\/\+\/,\s*['"]{2}\)/);
});

test('preload.ts exposes openWindow for "open in new window" (spec/14 § New windows)', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  // The caller's opening size rides along with the path — spec/14 § New
  // windows, the detached sidebar opens at a sidebar's width.
  assert.match(src, /openWindow\(path: string, size\?: \{ width: number; height: number \}\)/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:window:open['"],\s*\{\s*path,\s*size\s*\}\)/);
});

test('every BrowserWindow disables backgroundThrottling (hidden windows must still auto-reload)', () => {
  // Regression: Electron's default (backgroundThrottling: true) throttles a
  // renderer's timers once its window is hidden or unfocused. This app hides
  // rather than closes on Cmd+W, and day-to-day use goes through the tray
  // popover, so the main window sits hidden/unfocused most of the time. That
  // throttling delayed the WS reconnect backoff (api/ws.ts) driving
  // liveUpdate.ts's post-deploy auto-reload, leaving a hidden window on a
  // stale bundle indefinitely — reported by Tom needing a manual Cmd+R after
  // a deploy. Every window that loads the web SPA must opt out.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const factories = [
    ['openChildWindow', 'export function openChildWindow'],
    ['createMainWindow', 'export function createMainWindow'],
    ['createTrayPopover', 'function createTrayPopover'],
    ['createVoiceOverlay', 'function createVoiceOverlay'],
  ] as const;
  for (let i = 0; i < factories.length; i++) {
    const entry = factories[i];
    if (!entry) continue;
    const [name, marker] = entry;
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${name} not found`);
    const nextMarker = factories[i + 1]?.[1];
    const end = nextMarker ? src.indexOf(nextMarker) : start + 2000;
    const body = src.slice(start, end > start ? end : undefined);
    assert.match(
      body,
      /backgroundThrottling: false/,
      `${name} must set backgroundThrottling: false`,
    );
  }
});

// ── Surviving a deploy ────────────────────────────────────────────────────────
// A deploy used to run `install-to-applications.cjs` as a `postdist` hook: it
// quit Patch, replaced /Applications/Patch.app and never relaunched it, so
// every deploy left the desktop dead until Tom started it by hand. The shell
// now follows a deploy the same way any other machine would — over the update
// feed, which relaunches on install.

test('the deploy no longer replaces /Applications under the running app (no postdist on `dist`)', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts['postdist'],
    undefined,
    'a postdist hook makes every `pnpm dist` — i.e. every deploy — kill the running shell',
  );
  // The deliberate local install is still reachable, just never automatic.
  assert.match(pkg.scripts['install:app'] ?? '', /install-to-applications/);
});

test('install-to-applications refuses to replace a bundle that is still running', () => {
  // Even by hand, deleting a live .app crashes it. It asks the app to quit,
  // WAITS for the process to actually go, and exits non-zero rather than
  // clobbering it — no fallback, no silent half-install.
  const src = readFileSync(join(here, '..', 'scripts', 'install-to-applications.cjs'), 'utf8');
  const quitAt = src.indexOf('quit app "Patch"');
  const removeAt = src.indexOf('fs.rmSync(dest');
  assert.ok(quitAt >= 0 && removeAt > quitAt, 'the quit must precede the removal');
  const between = src.slice(quitAt, removeAt);
  assert.match(between, /runningPids\(\)\.length > 0/, 'must wait for the process to exit');
  assert.match(between, /REFUSING/);
  assert.match(between, /process\.exit\(1\)/);
});

test('a deploy tells the shell to CHECK now instead of waiting for the hourly check', () => {
  // web/lib/liveUpdate.ts sends this the moment the server reports a new bundle
  // hash on `auth.ok` — which happens on the post-deploy WS reconnect. It makes
  // the shell look, and nothing more: the banner then waits to be asked.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.match(src, /ipcMain\.on\(['"]patch:updater:check-now['"]/);
  const handler = src.slice(src.indexOf("ipcMain.on('patch:updater:check-now'"));
  assert.match(handler.slice(0, 200), /checkForUpdates\(\)/);
  assert.doesNotMatch(handler.slice(0, 200), /installUpdate\(\)/, 'checking must not install');
});

test('a downloaded update is staged, and the user decides when it lands', () => {
  // This replaced "EVERY downloaded update installs itself". That policy was a
  // reasonable reading of a real problem — ~20 deploys a day means ~20 prompts
  // for an answer that is always yes — but it bought the absence of prompts by
  // quitting the app mid-use, which no other Squirrel app does. The prompt is
  // still gone; what takes its place is a banner that escalates with age
  // (updater.ts § updateUrgency), plus autoInstallOnAppQuit for the user who
  // never presses it.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const body = src.slice(
    src.indexOf("autoUpdater.on('update-downloaded'"),
    src.indexOf("autoUpdater.on('error'"),
  );
  assert.doesNotMatch(body, /^\s*installUpdate\(\);/m, 'a download must not install itself');
  assert.match(body, /applyUpdaterEvent\(\{ type: 'downloaded'/, 'but it must be recorded');
  assert.doesNotMatch(src, /installWhenDownloaded/, 'the old one-shot flag stays gone');
});

test('the restart-to-install prompt path is gone end to end', () => {
  // No send from main, no listener or quit-and-install channel in the preload,
  // so there is no dead IPC left behind the removed button (VersionPanel.tsx).
  const main = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.doesNotMatch(main, /patch:update-ready/);
  assert.doesNotMatch(main, /patch:apply-update/);
  const preload = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.doesNotMatch(preload, /patch:update-ready/);
  assert.doesNotMatch(preload, /patch:apply-update/);
  assert.doesNotMatch(preload, /onUpdateReady/);
  assert.doesNotMatch(preload, /applyUpdate/);
});

test('every install path goes through quitAndInstallNow, not a bare quitAndInstall', () => {
  // Regression: "restart to install just closes the window". quitAndInstall()
  // closes all windows and then quits, but the main window's `close` handler
  // preventDefault()s + hides unless app.isQuitting is set (Cmd+W hides; the
  // tray app stays alive). Both install paths hit that guard, so the window hid
  // and the shell kept running the OLD build. quitAndInstallNow (updater.ts)
  // sets the flag first and force-relaunches; it is unit-tested there. This
  // asserts nothing calls the raw updater directly and reintroduces the bug.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.doesNotMatch(
    src,
    /autoUpdater\.quitAndInstall\(/,
    'call quitAndInstallNow({ app, autoUpdater }) — a bare quitAndInstall is swallowed by the close guard',
  );
  assert.match(src, /quitAndInstallNow/);

  // One wrapper, so a future call site can't miss the flag or the error report.
  const helper = src.slice(src.indexOf('function installUpdate('));
  assert.match(helper.slice(0, 600), /app: app as unknown as \{ isQuitting: boolean \}/);
  assert.match(helper.slice(0, 600), /autoUpdater,/);
  assert.match(
    helper.slice(0, 600),
    /type: 'error'/,
    'a refused install must reach the version panel',
  );
});

test('preload.ts exposes checkForUpdateNow and installUpdate to the SPA', () => {
  const src = readFileSync(join(here, 'preload.ts'), 'utf8');
  assert.match(src, /checkForUpdateNow\(\): void/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:updater:check-now['"]\)/);
  // The banner's Restart button. Separating it from the check is the whole
  // point: checking is automatic, installing is the user's.
  assert.match(src, /installUpdate\(\): void/);
  assert.match(src, /ipcRenderer\.send\(['"]patch:updater:install['"]\)/);
});

test('a finished download does NOT install itself', () => {
  // The regression that matters. Reinstating installUpdate() in the
  // `update-downloaded` handler brings back an app that quits mid-sentence and
  // returns ~75 seconds later at its front door. Installing is reached ONLY
  // from the IPC the user's Restart button sends.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  const handler = src.slice(src.indexOf("autoUpdater.on('update-downloaded'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  assert.doesNotMatch(
    body,
    /^\s*installUpdate\(\);/m,
    'a download must stage the update and stop there',
  );
  assert.match(
    src,
    /ipcMain\.on\('patch:updater:install', \(\) => \{\s*installUpdate\(\);/,
    'the only install path is the one the user presses',
  );
});

test('autoInstallOnAppQuit is never disabled — the patient path must keep working', () => {
  // Ignoring the banner forever is a supported outcome precisely because the
  // update lands on the next ordinary quit. Turning this off would strand a
  // user who never presses Restart on an ever-older build.
  const src = readFileSync(join(here, 'main.ts'), 'utf8');
  assert.doesNotMatch(src, /autoInstallOnAppQuit\s*=\s*false/);
});

test('main window placement is restored and persisted (spec/05 § Window placement)', () => {
  const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
  assert.match(src, /from '\.\/window-bounds'/);
  assert.match(src, /resolvePlacement\(/);
  assert.match(src, /win\.on\('move', scheduleBoundsSave\)/);
  assert.match(src, /win\.on\('resize', scheduleBoundsSave\)/);
  assert.match(src, /win\.on\('close', \(\) => saveWindowBounds\(win\)\)/);
});
