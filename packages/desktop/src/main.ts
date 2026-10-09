// Electron main process — group 19 desktop shell.
//
// Surfaces:
//   - Main BrowserWindow loads the deployed web SPA (PATCH_SERVER_URL) in
//     production, the vite dev server in dev (default :5173).
//   - System tray (macOS menu-bar). Click → BrowserWindow popover modeled on
//     design/web-hi-fi-menubar.html (manager + recents). Right-click →
//     context menu (Open Patch / Quit Patch).
//   - Global hotkey `⌃ Space` (configurable later) opens a small frameless
//     voice-note overlay window targeting Manager.
//   - Native macOS notifications via Electron's Notification (better OS
//     integration than web Notification: badges, action centre, sound).
//   - Auto-update via electron-updater against the box's own feed
//     (/api/desktop/latest-mac.yml), with every check outcome recorded and
//     reportable to the Settings panel — see updater.ts and spec/11 § Version
//     reporting.
//
// NO FALLBACK: if the configured server URL is missing in production we
// fail loudly at boot; if a global hotkey fails to register we throw.

import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  session,
  desktopCapturer,
  dialog,
  screen,
  shell,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  diagnoseUpdater,
  emptyPersisted,
  initialUpdaterState,
  parsePersisted,
  persistedOf,
  quitAndInstallNow,
  createCheckRunner,
  reduceUpdater,
  type UpdaterEvent,
  type UpdaterState,
} from './updater';
import { buildContextMenuTemplate } from './context-menu';
import { buildAppMenuTemplate } from './app-menu';
import { InAppBrowser } from './in-app-browser';
import { PANEL_WIDTH_FRACTION } from './in-app-browser-layout';
import { routeLink, routeWindowOpen } from './link-policy';
import { parseWindowSize, type ChildWindowSize } from './window-size';
import { windowChrome } from './window-chrome';
import { parseSavedPlacement, resolvePlacement, type DisplayInfo } from './window-bounds';
import { decideTrayClick } from './tray-toggle';
import { configurePermissions } from './permissions';
import { loadRetryDelay, shouldRetryLoad } from './load-retry';
import { installLocalDaemon, localDaemonStatus, serverOrigin } from './local-daemon';
import { loadFirstRun, type SetupChoice } from './first-run-api';
import { toastSound, type NotifyPriority } from './toastSound';
import {
  MeetingDetector,
  SystemAudio,
  callingAppsIn,
  helperPath,
  watchMicrophone,
} from './meeting-audio';
import {
  buildNotificationExtras,
  decideDesktopIntent,
  type NotifyActionsPayload,
} from './notificationActions';

// NO server address is built into the app (spec/05 § Desktop first run). A
// packaged app learns which server it uses from the first run and remembers it;
// `pnpm dev` runs against the local vite SPA; PATCH_SERVER_URL overrides either
// way (a developer's escape hatch, never a default).
const DEV_SERVER_URL = 'http://localhost:5173/app/';
/** The SPA's base URL, once known. Set before any window is created. */
let SERVER_URL = process.env['PATCH_SERVER_URL'] ?? (app.isPackaged ? '' : DEV_SERVER_URL);
/** The first page the main window loads: SERVER_URL plus the credential in its fragment. */
let initialUrl: string | null = null;
/** What the first run started (the local server, a relay bridge), to stop at quit. */
let activeLaunch: { stop(): Promise<void> } | null = null;

// Group 20 fix-7 (DX-11): the global hotkey is configurable via env.
// Default `Control+Space` collides with macOS "Select previous input
// source"; users can pick e.g. `Alt+Space` or `CommandOrControl+Shift+P`
// without rebuilding.
const GLOBAL_HOTKEY = process.env['PATCH_GLOBAL_HOTKEY'] ?? 'Control+Space';
// spec/14 ## Global hotkey: ⌃⇧Space → toggle a voice CALL with Manager
// (distinct from ⌃Space, which is the press-and-hold voice NOTE). Configurable.
const GLOBAL_CALL_HOTKEY = process.env['PATCH_GLOBAL_CALL_HOTKEY'] ?? 'Control+Shift+Space';

/**
 * Build a route URL under the SPA base path, preserving any query string
 * (e.g. the dev `?credential=JWT` bypass). Naive string concatenation onto a
 * `…/app/?credential=JWT` URL would corrupt the token — re-home the path and
 * carry the query separately.
 *
 * `routePath` may itself carry a query (e.g. `/chats/<id>?sidebar=hidden`,
 * spec/14 § New windows) — split it off before assigning to `pathname`,
 * whose setter percent-encodes a literal `?`, and merge it onto whatever
 * query SERVER_URL already carries rather than overwriting it.
 *
 * `routePath` is inconsistently rooted across call sites — `menubarUrl`/
 * `voiceOverlayUrl` pass a bare segment (`'menubar'`), while `openChildWindow`
 * always gets a leading-slash path from `lib/newWindow.ts` (`'/sidebar-window'`,
 * `'/chats/<id>?sidebar=hidden'`). `baseDir` already has no trailing slash, so
 * joining with a literal `/` when `path` ALSO starts with one produces a
 * double slash (`…/app//sidebar-window`) — react-router's `matchPath` does not
 * treat that as equivalent to the single-slash route, so NONE of AppShell's
 * `<Route>`s match and the window silently falls through to the full app
 * shell instead of the intended bare/standalone route (Todoist: "opening the
 * sidebar in external window ... instead of being an actual new window and
 * detaching it from the main window"). Strip any leading slash(es) off
 * `path` before joining so both calling conventions produce exactly one.
 */
function routeUrl(routePath: string): string {
  const u = new URL(SERVER_URL);
  const baseDir = u.pathname.replace(/\/$/, '');
  const [path, query] = routePath.split('?');
  u.pathname = `${baseDir}/${(path ?? '').replace(/^\/+/, '')}`;
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
  }
  return u.toString();
}
function menubarUrl(): string {
  return routeUrl('menubar');
}
function voiceOverlayUrl(): string {
  return routeUrl('voice-overlay');
}

let mainWindow: BrowserWindow | null = null;
let trayPopover: BrowserWindow | null = null;

// Date.now() of the most recent popover hide (0 = never). The tray-click
// decision uses this to distinguish "user is reopening a long-closed popover"
// from "the blur fired by THIS same click just closed it" — see decideTrayClick
// / tray-toggle.ts for the macOS blur/click race this guards against.
let popoverHiddenAt = 0;
let voiceOverlay: BrowserWindow | null = null;
let tray: Tray | null = null;

// The embedded web panel (spec/14 § Links and the web panel), bound to the main
// window. Lazily created the first time PATCH asks to show a page, so a session
// that never opens one pays nothing.
let inAppBrowser: InAppBrowser | null = null;

/** The module's web panel (test/smoke introspection). */
export function getInAppBrowser(): InAppBrowser | null {
  return inAppBrowser;
}

// The panel's dragged width SHARE (spec/14 § Links and the web panel: "the
// width persists across opens and restarts; window resizes keep the same
// share"). Owned here rather than on the InAppBrowser instance alone because a
// link clicked in another window tears the instance down and rebuilds it
// (openInAppBrowser), and a link Patch opens on its own never round-trips
// through the renderer first — main has to already know the share before any
// panel exists.
let panelWidthFraction = PANEL_WIDTH_FRACTION;
const PANEL_LAYOUT_FILE = (): string => join(app.getPath('userData'), 'panel-layout.json');

/** A missing or corrupt file is a legitimate first-run state (the default
 * share), not a silenced error — same reasoning as readDesktopBuildInfo below. */
function loadPanelWidthFraction(): number {
  try {
    const parsed = JSON.parse(readFileSync(PANEL_LAYOUT_FILE(), 'utf8')) as {
      widthFraction?: unknown;
    };
    return typeof parsed.widthFraction === 'number' ? parsed.widthFraction : PANEL_WIDTH_FRACTION;
  } catch {
    return PANEL_WIDTH_FRACTION;
  }
}

// Debounced: a drag fires resizeTo() on every pointermove, and writeFileSync
// on each of those would block the main process dozens of times a second.
let panelWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePanelWidthSave(fraction: number): void {
  panelWidthFraction = fraction;
  if (panelWidthSaveTimer) clearTimeout(panelWidthSaveTimer);
  panelWidthSaveTimer = setTimeout(() => {
    panelWidthSaveTimer = null;
    try {
      writeFileSync(PANEL_LAYOUT_FILE(), JSON.stringify({ widthFraction: panelWidthFraction }));
    } catch (err) {
      console.error('[panel] failed to persist width', err);
    }
  }, 200);
}

/**
 * Open `url` in the embedded web panel bound to `win`, (re)creating the
 * controller if the previous one's window was torn down. Two callers: a page
 * PATCH wants to show (`patch:panel:open`), and a link the user CHOSE to open
 * in Patch — a plain click, or the right-click "Open Link in Patch" (spec/14 §
 * Links and the web panel). The panel's toolbar carries an "open in browser"
 * button so its page can always be popped back out.
 *
 * There is exactly ONE panel app-wide: the `patch:iab:*` toolbar channels are
 * global, so a second controller in another window would leave buttons driving
 * the wrong page. A link clicked in a different window therefore MOVES the
 * panel — the old one is closed first, which also restores that window's full
 * width (its inset goes back to 0) instead of stranding a dead gap beside it.
 */
export function openInAppBrowser(win: BrowserWindow, url: string): void {
  if (inAppBrowser && !inAppBrowser.isDestroyed() && inAppBrowser.parentWindow() !== win)
    inAppBrowser.close();
  if (!inAppBrowser || inAppBrowser.isDestroyed() || inAppBrowser.parentWindow() !== win)
    inAppBrowser = new InAppBrowser(win, panelWidthFraction);
  inAppBrowser.open(url);
}

/** Test-visible event log — lets vitest assert tray:click etc. */
export interface DesktopEvent {
  type:
    | 'tray:click'
    | 'tray:context-menu'
    | 'hotkey:voice:start'
    | 'hotkey:voice:end'
    | 'hotkey:voice:call'
    | 'notification:click'
    | 'incoming-call:raise'
    | 'auto-update:available'
    | 'auto-update:downloaded'
    | 'window:hidden'
    | 'window:load-retry'
    | 'window:load-failed'
    | 'window:render-process-gone'
    | 'meeting:detection-off';
  ts: number;
  payload?: Record<string, unknown>;
}
const eventLog: DesktopEvent[] = [];
function logDesktopEvent(e: Omit<DesktopEvent, 'ts'>): void {
  eventLog.push({ ...e, ts: Date.now() });
  // Mirror to stdout so test harnesses can grep stdout if they prefer.

  console.log(`[desktop-event] ${JSON.stringify(e)}`);
}
export function getDesktopEventLog(): readonly DesktopEvent[] {
  return eventLog;
}

/** The module's singleton main window (test/smoke introspection). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** The module's singleton voice-note overlay window (test/smoke introspection). */
export function getVoiceOverlay(): BrowserWindow | null {
  return voiceOverlay;
}

/** The module's singleton tray (test/smoke introspection). */
export function getTray(): Tray | null {
  return tray;
}

/** The module's singleton tray popover window (test/smoke introspection). */
export function getTrayPopover(): BrowserWindow | null {
  return trayPopover;
}

/**
 * Create the main window and assign it as the module singleton (test/smoke
 * helper — production assigns it in the whenReady bootstrap below). Lets a
 * real-Electron smoke exercise raiseMainWindow against the same window the
 * incoming-call IPC handler raises.
 */
export function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  return mainWindow;
}

/**
 * Create the voice-note overlay and assign it as the module singleton without
 * showing it (test/smoke helper). Lets a real-Electron smoke hook the overlay's
 * webContents.send BEFORE the global voice-note hotkey fires, so it can capture
 * the Manager-targeted IPC payload the same way the main window captures the
 * voice-call payload — proving the note chord targets Manager, not just that
 * the overlay appears.
 */
export function ensureVoiceOverlay(): BrowserWindow {
  if (!voiceOverlay || voiceOverlay.isDestroyed()) voiceOverlay = createVoiceOverlay();
  return voiceOverlay;
}

/**
 * Wire the shared link policy onto `win` (spec/14 § Links and the web panel).
 * The user chooses where a link opens, and the gesture IS the choice:
 *
 *   1. `window.open` / `<a target="_blank">` / a ⌘/Ctrl/Shift-click →
 *      setWindowOpenHandler → the USER's real browser. Chromium turns a
 *      modified click into a new-window request rather than a navigation, which
 *      is what makes "⌘-click for my own browser" work with no renderer code.
 *   2. A plain `<a href>` click → an IN-PLACE navigation of THIS webContents
 *      (`will-navigate`) → Patch's own web panel, beside the chat the link came
 *      from. Without the guard below, clicking an external link inside a chat
 *      would navigate the whole Patch SPA away to that site. Same-origin
 *      navigations (the SPA loading its own routes / reloading) are left alone.
 *
 * Neither route is a dead end: the panel's toolbar pops its page out to the real
 * browser, and the right-click menu below names both destinations outright.
 * Also wires the right-click context menu (Cut/Copy/Paste/Select All, plus
 * link actions when on a link). Applied to every Patch window — the main
 * window and any window opened via `openChildWindow` (spec/14 § New
 * windows) alike — so a link inside a detached chat or sidebar window
 * behaves identically to one in the main window.
 */
function attachWindowLinkPolicy(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const action = routeWindowOpen(url);
    if (action.kind === 'external') void shell.openExternal(action.url);
    // Nothing may spawn a new Electron window THIS way: an external URL has
    // already gone to the real browser, a same-origin one belongs in this
    // window's router, and anything else is refused outright (NO FALLBACK).
    // Patch's own "open in new window" actions never go through here — they
    // use the dedicated `patch:window:open` IPC / `openChildWindow` below.
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const action = routeLink(url, SERVER_URL);
    if (action.kind === 'spa') return; // in-app SPA navigation — allow.
    event.preventDefault();
    // A plain click keeps the page inside Patch. NO FALLBACK: a blocked URL is
    // dropped here, never quietly handed to the real browser instead.
    if (action.kind === 'panel') openInAppBrowser(win, action.url);
  });
  win.webContents.on('context-menu', (_event, params) => {
    void (async () => {
      // Monaco (the file editor) pops its own rich context menu — undo/redo,
      // format document, go to definition — from the SAME right-click's DOM
      // event, via a floating div. Electron's native 'context-menu' event
      // fires regardless of whether the page called preventDefault() on that
      // DOM event, so without this guard the generic Cut/Copy/Paste menu
      // below popped on top of Monaco's own menu on every right-click inside
      // the file editor. Ask the page what's under the click and stand down
      // there, leaving Monaco's own menu as the only one.
      const insideMonacoEditor = await win.webContents
        .executeJavaScript(
          `!!document.elementFromPoint(${params.x}, ${params.y})?.closest('.monaco-editor')`,
        )
        .catch(() => false);
      if (insideMonacoEditor) return;

      const template = buildContextMenuTemplate(params, {
        openExternal: (url) => void shell.openExternal(url),
        // Same guard the `patch:panel:open` IPC uses: only a real http(s) page
        // may be loaded into the panel, whatever the right-clicked href said.
        openInPatch: (url) => {
          const action = routeWindowOpen(url);
          if (action.kind === 'external') openInAppBrowser(win, action.url);
        },
        writeText: (text) => clipboard.writeText(text),
      });
      Menu.buildFromTemplate(template).popup({ window: win });
    })();
  });
}

// Windows opened via `openChildWindow` (spec/14 § New windows) — a chat or
// the sidebar detached into its own window. Tracked only so tests/smoke can
// introspect them; each is otherwise independent (own titlebar, closes
// normally, no `close`→`hide()` singleton behaviour like `mainWindow`).
const childWindows = new Set<BrowserWindow>();

/** Currently open child windows (test/smoke introspection). */
export function getChildWindows(): readonly BrowserWindow[] {
  return [...childWindows];
}

/**
 * Open `routePath` (an in-app SPA route, e.g. `/chats/<id>?sidebar=hidden`
 * or `/sidebar-window`) in a NEW, independent BrowserWindow — spec/14 §
 * New windows. Distinct from `createMainWindow`: this is never the
 * singleton `mainWindow`, closes like an ordinary window (no hide-on-close),
 * and there can be any number of them at once.
 *
 * `size` is what the caller asked for — the detached sidebar asks for a
 * sidebar's width (spec/14 § New windows). A chat window asks for nothing and
 * gets the ordinary document-sized window below.
 */
export function openChildWindow(routePath: string, size?: ChildWindowSize): BrowserWindow {
  const win = new BrowserWindow({
    width: size?.width ?? 900,
    height: size?.height ?? 700,
    title: 'Patch',
    show: true,
    // Same overlay title bar as the main window (see createMainWindow): a chat
    // or the sidebar detached into its own window is the same UI, and a native
    // bar on it would be exactly the "patch top bar" being removed.
    ...windowChrome(process.platform),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // See createMainWindow for why this must be false.
      backgroundThrottling: false,
    },
  });
  void win.loadURL(routeUrl(routePath));
  attachWindowLinkPolicy(win);
  childWindows.add(win);
  win.on('closed', () => childWindows.delete(win));
  return win;
}

// Main-window placement (spec/05 § Window placement). Saved on move/resize
// (debounced), hide and quit; read once at creation.
const WINDOW_BOUNDS_FILE = (): string => join(app.getPath('userData'), 'window-bounds.json');

function attachedDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen
    .getAllDisplays()
    .map((d) => ({ id: d.id, workArea: d.workArea }))
    .sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId));
}

function saveWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const maximized = win.isMaximized() || win.isFullScreen();
  // Normal bounds, so un-maximising later returns to the size the user chose.
  const b = win.getNormalBounds();
  const displayId = screen.getDisplayMatching(win.getBounds()).id;
  try {
    writeFileSync(WINDOW_BOUNDS_FILE(), JSON.stringify({ ...b, displayId, maximized }));
  } catch (err) {
    console.error('[window] failed to persist bounds', err);
  }
}

export function createMainWindow(): BrowserWindow {
  const placement = resolvePlacement(
    parseSavedPlacement(
      existsSync(WINDOW_BOUNDS_FILE()) ? readFileSync(WINDOW_BOUNDS_FILE(), 'utf8') : undefined,
    ),
    attachedDisplays(),
    { width: 1200, height: 800 },
  );
  const win = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    title: 'Patch',
    show: true,
    // No native title bar — the SPA runs to the window's top edge and the
    // traffic lights float over its top-left (spec/05 § Window chrome; Tom,
    // App Updates: "clean at top, no patch top bar"). The renderer reserves
    // the strip they land in; see `--overlay-titlebar-inset` in index.css.
    ...windowChrome(process.platform),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Group 19: explicit CSP relax — the renderer is the same web SPA
      // bundle Caddy serves; in dev we additionally need to talk to
      // localhost:3000 (server) and any audio WSS the host exposes.
      //
      // Electron's default (true) throttles this renderer's timers once the
      // window is hidden or unfocused — which is its NORMAL state, since
      // Cmd+W hides rather than closes and day-to-day use goes through the
      // tray popover instead. That throttling delayed the WS reconnect
      // backoff (api/ws.ts) that drives liveUpdate.ts's auto-reload after a
      // deploy, so a hidden main window could sit on a stale bundle
      // indefinitely and need a manual Cmd+R. Off, so a deploy reloads this
      // window whether or not it's the one currently in front.
      backgroundThrottling: false,
    },
  });
  if (placement.maximized) win.maximize();
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleBoundsSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveWindowBounds(win), 300);
  };
  win.on('move', scheduleBoundsSave);
  win.on('resize', scheduleBoundsSave);
  win.on('close', () => saveWindowBounds(win));
  void win.loadURL(initialUrl ?? SERVER_URL);
  initialUrl = null; // the credential fragment is handed over once; later loads need none
  attachLoadRetry(win, SERVER_URL);

  // Cmd+W hides; Cmd+Q quits. Tray + hotkey stay alive while hidden.
  // Anything that means to genuinely end the process must set `app.isQuitting`
  // FIRST or this guard swallows it — that is what broke "restart to install"
  // (quitAndInstall closes all windows, then quits). See quitAndInstallNow.
  win.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      win.hide();
      logDesktopEvent({ type: 'window:hidden' });
    }
  });

  attachWindowLinkPolicy(win);

  // Register as THE singleton main window. Without this, getMainWindow()
  // stays null after a direct createMainWindow() call, and every guarded site
  // (`if (!mainWindow) mainWindow = createMainWindow()` — notification click,
  // ⌃⇧Space call, raiseMainWindow, tray "Open Patch") would spawn a SECOND,
  // orphaned main window. The factory owns the invariant so callers can't drift.
  mainWindow = win;
  return win;
}

/** Tray popover — small frameless window anchored to the tray icon. */
function createTrayPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    fullscreenable: false,
    resizable: false,
    skipTaskbar: true,
    movable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // See createMainWindow for why this must be false.
      backgroundThrottling: false,
    },
  });
  // Group 20 fix-2: SPA uses BrowserRouter (not hash); load the path
  // directly. The server's catch-all for /app/* returns index.html so
  // deep-links work.
  void win.loadURL(menubarUrl());
  // Group 20 fix DX-10: 200ms grace period — only hide if no Patch window
  // grabbed focus during that window. This stops transient blur events
  // (e.g. a child menu opening) from killing the popover instantly. Hiding
  // routes through hideTrayPopover so the renderer's heartbeat is told to stop
  // (spec/05 — see sendPopoverVisibility).
  let blurTimer: NodeJS.Timeout | null = null;
  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      // If another Patch window is now focused, don't hide.
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && focused !== win) return;
      hideTrayPopover();
    }, 200);
  });
  win.on('focus', () => {
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
  });
  return win;
}

/**
 * Tell the popover renderer whether the dropdown is visible, so it starts/stops
 * its `surface.heartbeat` (spec/05 — beats only while open).
 *
 * This is sent from the imperative show/hide CALL SITES rather than
 * `win.on('show'/'hide')` because those BrowserWindow events are unreliable on
 * macOS: `win.hide()` genuinely hides the window (isVisible() → false) yet the
 * 'hide' event frequently never fires, so an event-driven gate would leave the
 * heartbeat running after the dropdown closes. Electron's `hide()` also does
 * NOT fire the renderer's own `visibilitychange`, so the renderer can't infer
 * it either — main must say so explicitly.
 */
function sendPopoverVisibility(visible: boolean): void {
  if (!trayPopover || trayPopover.isDestroyed()) return;
  trayPopover.webContents.send('patch:menubar-visibility', { visible });
}

function hideTrayPopover(): void {
  if (!trayPopover || trayPopover.isDestroyed()) return;
  trayPopover.hide();
  popoverHiddenAt = Date.now();
  sendPopoverVisibility(false);
}

function showTrayPopover(): void {
  if (!trayPopover) trayPopover = createTrayPopover();
  if (!tray) return;
  const trayBounds = tray.getBounds();
  const winBounds = trayPopover.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  trayPopover.setPosition(x, y, false);
  trayPopover.show();
  trayPopover.focus();
  sendPopoverVisibility(true);
}

function createTray(): Tray {
  // Group 20 fix DX-12: ship a real template image (mac auto-tints
  // light/dark) at build/trayIconTemplate.png. NO FALLBACK: if the asset
  // is missing in the bundle we throw rather than show an invisible icon.
  const candidate = join(__dirname, '..', 'build', 'trayIconTemplate.png');
  const icon = nativeImage.createFromPath(candidate);
  if (icon.isEmpty()) {
    throw new Error(`tray icon missing or unreadable: ${candidate}`);
  }
  icon.setTemplateImage(true);
  const t = new Tray(icon);
  t.setToolTip('Patch');
  t.on('click', () => {
    logDesktopEvent({ type: 'tray:click' });
    // Route through decideTrayClick so a second click always CLOSES the popover
    // and never re-opens it via the blur/click race (patch/todo.md, tray-toggle.ts).
    const action = decideTrayClick({
      visible: !!trayPopover?.isVisible(),
      hiddenAt: popoverHiddenAt,
      now: Date.now(),
    });
    if (action === 'hide') {
      hideTrayPopover();
    } else if (action === 'show') {
      showTrayPopover();
    }
    // 'noop' → the blur from this same click already closed it; stay closed.
  });
  t.on('right-click', () => {
    logDesktopEvent({ type: 'tray:context-menu' });
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open Patch',
        click: () => {
          if (!mainWindow) mainWindow = createMainWindow();
          mainWindow.show();
          mainWindow.focus();
        },
      },
      {
        // spec/11 § Version reporting — one click to "what am I running, and is
        // anything stale?". Worth a top-level entry: the answer used to be
        // unobtainable from inside the app at all.
        label: 'Version & updates…',
        click: () => {
          if (!mainWindow) mainWindow = createMainWindow();
          mainWindow.show();
          mainWindow.focus();
          sendWhenReady(mainWindow, 'patch:navigate', { path: '/settings' });
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Patch',
        click: () => {
          (app as unknown as { isQuitting: boolean }).isQuitting = true;
          app.quit();
        },
      },
    ]);
    t.popUpContextMenu(menu);
  });
  return t;
}

function createVoiceOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 120,
    show: false,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: false,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // See createMainWindow for why this must be false.
      backgroundThrottling: false,
    },
  });
  void win.loadURL(voiceOverlayUrl());
  return win;
}

/**
 * Re-dial a window whose DOCUMENT load failed (spec/12 § Connection diagnostics
 * screen; see `load-retry.ts` for why), AND a window whose renderer PROCESS
 * died out from under an already-loaded document.
 *
 * The shell IS the SPA, so either failure is one the SPA cannot heal itself —
 * `did-fail-load` leaves Chromium's error page; `render-process-gone` leaves a
 * blank/white one, because the document that would have shown an error is
 * gone along with the process that was rendering it. Nothing in Electron
 * reloads a window on its own in either case, which is what "Patch keeps
 * crashing to a white screen and needs refreshing on desktop" actually was —
 * a renderer crash (OOM, GPU fault, native asserts) with no listener to
 * recover it, so it sat blank until Tom did the reload himself.
 *
 * A `patch-server` restart makes Caddy 502 for a second or two, which is
 * exactly long enough to catch a shell that happens to be loading; a renderer
 * crash has no comparable "it'll pass" window, so it gets the same ladder
 * rather than a bespoke one — sharing `attempt` means a crash-reload that
 * itself crashes still backs off and eventually gives up instead of spinning.
 *
 * The counter resets on every completed load, so the error state clears itself
 * the moment the server is back (or the reload holds), and a later blip gets
 * the full ladder again rather than resuming at its ceiling.
 */
function attachLoadRetry(win: BrowserWindow, url: string): void {
  let attempt = 0;
  win.webContents.on('did-finish-load', () => {
    attempt = 0;
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!shouldRetryLoad(errorCode, isMainFrame)) return;
    attempt += 1;
    const delay = loadRetryDelay(attempt);
    if (delay === null) {
      // NO FALLBACK: the ladder is spent, so the failure stays on screen. A
      // server that is genuinely down must look down, not look like it is
      // still trying.
      logDesktopEvent({
        type: 'window:load-failed',
        payload: { errorCode, errorDescription, attempt },
      });
      return;
    }
    logDesktopEvent({
      type: 'window:load-retry',
      payload: { errorCode, errorDescription, attempt, delay },
    });
    setTimeout(() => {
      if (!win.isDestroyed()) void win.loadURL(url);
    }, delay).unref?.();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    // 'clean-exit' is `webContents.forcefullyCrashRenderer()` or an
    // intentional exit, not a crash — the window isn't blank, so leave it
    // alone. Everything else (crashed/abnormal-exit/oom/killed/launch-failed/
    // integrity-failure) means the process that was painting this window is
    // gone, so the document is too: reload, on the same ladder as a failed
    // load.
    if (details.reason === 'clean-exit') return;
    attempt += 1;
    const delay = loadRetryDelay(attempt);
    logDesktopEvent({
      type: 'window:render-process-gone',
      payload: { reason: details.reason, exitCode: details.exitCode, attempt, delay },
    });
    if (delay === null) return; // NO FALLBACK: ladder spent, blank screen stands.
    setTimeout(() => {
      if (!win.isDestroyed()) void win.loadURL(url);
    }, delay).unref?.();
  });
}

/**
 * Send a main→renderer IPC, deferring until the page has finished loading if
 * it's still in flight. A freshly created BrowserWindow's `loadURL` is async,
 * so a synchronous `webContents.send` right after creation races the load and
 * Electron DROPS renderer-bound IPC that arrives before the renderer registers
 * its listeners. The voice-note overlay is GUARANTEED cold on the first ⌃Space
 * press (lazily created), so without this the first voice note opens the
 * overlay but never starts recording. NO FALLBACK: we don't swallow the send,
 * we delay it to the exact moment the renderer is ready.
 */
function sendWhenReady(win: BrowserWindow, channel: string, payload: unknown): void {
  const wc = win.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (!win.isDestroyed()) wc.send(channel, payload);
    });
  } else {
    wc.send(channel, payload);
  }
}

// ---- Meeting mode: system audio + noticing a call -----------------------------
// The renderer hears "everyone else" through `patch-audio tap` (a Core Audio tap:
// no screen picker), and is told when a calling app opens or closes the mic so it
// can offer to start or end a meeting. See meeting-audio.ts.

/** Patch's own helper processes also open the mic (voice notes, the meeting). */
const OWN_BUNDLE_PREFIX = 'io.github.tomchambers2.patch';

const systemAudio = new SystemAudio(() =>
  helperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, devDir: __dirname }),
);
let stopMicWatch: (() => void) | null = null;
/** Held while shown: an unreferenced Notification can be collected before it is clicked. */
const meetingToasts = new Set<Notification>();

function showMeetingToast(phase: 'started' | 'ended', appName: string): void {
  const n = new Notification({
    title: phase === 'started' ? `Meeting started — ${appName}` : `Meeting ended — ${appName}`,
    body: phase === 'started' ? 'Click to start a Patch meeting' : 'Click to end the Patch meeting',
    ...toastSound('normal'),
  });
  n.on('click', () => {
    logDesktopEvent({ type: 'notification:click', payload: { kind: `meeting-${phase}` } });
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    mainWindow.show();
    mainWindow.focus();
    sendWhenReady(mainWindow, 'patch:meeting-signal', { phase, app: appName });
  });
  meetingToasts.add(n);
  n.on('close', () => meetingToasts.delete(n));
  n.show();
}

/** NO FALLBACK: detection that cannot run says so, once, instead of going quiet. */
function startMeetingDetection(): void {
  const detector = new MeetingDetector({
    // A meeting Patch is already capturing needs no prompt to start; the end
    // prompt only matters while it is.
    started: (appName) => {
      if (!systemAudio.running) showMeetingToast('started', appName);
    },
    ended: (appName) => {
      if (systemAudio.running) showMeetingToast('ended', appName);
    },
  });
  try {
    const binary = helperPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      devDir: __dirname,
    });
    stopMicWatch = watchMicrophone(binary, {
      onProcesses: (processes) =>
        detector.update(callingAppsIn(processes, OWN_BUNDLE_PREFIX), Date.now()),
      onFailed: (message) => reportMeetingDetectionOff(message),
    });
    setInterval(() => detector.tick(Date.now()), 1000).unref();
  } catch (err) {
    reportMeetingDetectionOff((err as Error).message);
  }
}

function reportMeetingDetectionOff(message: string): void {
  logDesktopEvent({ type: 'meeting:detection-off', payload: { message } });
  new Notification({ title: 'Meeting detection is off', body: message }).show();
}

/**
 * The exact effect the OS fires on the ⌃Space global keypress: open (or
 * toggle) the Manager voice-note overlay. Exported as a named function so a
 * real-Electron smoke can drive the SAME code path the OS dispatches — there
 * is no public `globalShortcut.trigger`, so testing the genuine binding means
 * registering this exact reference and invoking it.
 *
 * spec/14: press-and-hold opens the overlay; tap toggles Superwhisper-style.
 */
export function onGlobalVoiceNoteHotkey(): void {
  logDesktopEvent({ type: 'hotkey:voice:start' });
  if (!voiceOverlay || voiceOverlay.isDestroyed()) voiceOverlay = createVoiceOverlay();
  if (voiceOverlay.isVisible()) {
    voiceOverlay.hide();
    logDesktopEvent({ type: 'hotkey:voice:end' });
  } else {
    voiceOverlay.show();
    voiceOverlay.focus();
    sendWhenReady(voiceOverlay, 'patch:start-voice-note', { thread: 'manager' });
  }
}

/**
 * The effect the OS fires on the ⌃⇧Space global keypress: raise the main
 * window and open a Manager voice CALL (spec/14). Exported for the same
 * real-binding smoke reason as {@link onGlobalVoiceNoteHotkey}.
 */
export function onGlobalVoiceCallHotkey(): void {
  logDesktopEvent({ type: 'hotkey:voice:call' });
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  mainWindow.show();
  mainWindow.focus();
  sendWhenReady(mainWindow, 'patch:start-voice-call', { thread: 'manager' });
}

function registerGlobalHotkeys(): void {
  // ⌃ Space — voice note to Manager. globalShortcut binds OS-wide (Carbon
  // RegisterEventHotKey) so it fires regardless of which app is focused.
  const ok = globalShortcut.register(GLOBAL_HOTKEY, onGlobalVoiceNoteHotkey);
  if (!ok) {
    // NO FALLBACK: another app owns the hotkey. Surface loudly. The user
    // can override the default via PATCH_GLOBAL_HOTKEY (group 20 fix DX-11).
    throw new Error(
      `failed to register global shortcut ${GLOBAL_HOTKEY} ` +
        `(set PATCH_GLOBAL_HOTKEY=… to pick a different combination)`,
    );
  }

  // ⌃⇧Space — voice CALL with Manager (spec/14).
  const callOk = globalShortcut.register(GLOBAL_CALL_HOTKEY, onGlobalVoiceCallHotkey);
  if (!callOk) {
    throw new Error(
      `failed to register global shortcut ${GLOBAL_CALL_HOTKEY} ` +
        `(set PATCH_GLOBAL_CALL_HOTKEY=… to pick a different combination)`,
    );
  }
}

/**
 * Native macOS notifications. The renderer can either ask main to show a
 * toast (via IPC `patch:notify`) or main can show one directly when an
 * upstream `notify { channel: 'desktop' }` event arrives via the WS — the
 * SPA proxies those through the preload bridge.
 */
let lastNotification: Notification | null = null;

/** The most recently shown native notification (test/smoke introspection). */
export function getLastNotification(): Notification | null {
  return lastNotification;
}

/**
 * Notification actions (spec/09 § Notification actions). Reply/Approve-Deny/
 * question-option/quickReply taps on the toast are decided here
 * (`notificationActions.ts`), then handed to the renderer — which owns the
 * live WS connection and the guaranteed-delivery trackers — over
 * `patch:notification-send`, keyed by a `requestId` this map resolves when
 * the renderer answers back on `patch:notification-send-result`.
 */
const pendingNotificationSends = new Map<string, (ok: boolean) => void>();
let notificationSendCounter = 0;

function showNativeNotification(opts: {
  title: string;
  body: string;
  chatId?: string;
  priority?: NotifyPriority;
  kind?: 'message' | 'call' | 'batch' | 'ask';
  actions?: NotifyActionsPayload;
  /** Set when this toast IS a "Not sent — tap to retry" state: a click retries the same thing instead of opening the chat. */
  retry?: { chatId: string; actions?: NotifyActionsPayload; index?: number; replyText?: string };
}): void {
  const extras = buildNotificationExtras(opts.actions, process.platform);
  const n = new Notification({
    title: opts.title,
    body: opts.body,
    ...toastSound(opts.priority),
    ...extras,
  });
  n.on('click', () => {
    logDesktopEvent({
      type: 'notification:click',
      payload: { chatId: opts.chatId, kind: opts.kind },
    });
    if (opts.retry) {
      dispatchNotificationAction({
        title: opts.title,
        chatId: opts.retry.chatId,
        actions: opts.retry.actions,
        index: opts.retry.index,
        replyText: opts.retry.replyText,
      });
      return;
    }
    if (!mainWindow) mainWindow = createMainWindow();
    mainWindow.show();
    mainWindow.focus();
    // spec/09 § Batch check-in — lands on the batch view, never a chat; the
    // renderer's `useDesktopNavigation` special-cases this path.
    if (opts.kind === 'batch') {
      sendWhenReady(mainWindow, 'patch:navigate', { path: '/batch' });
    } else if (opts.chatId) {
      sendWhenReady(mainWindow, 'patch:navigate', { path: `/chats/${opts.chatId}` });
    }
  });
  if (opts.actions) {
    n.on('reply', (_e: unknown, replyText: string) => {
      dispatchNotificationAction({
        title: opts.title,
        chatId: opts.chatId,
        actions: opts.actions,
        replyText,
      });
    });
    n.on('action', (_e: unknown, index: number) => {
      dispatchNotificationAction({
        title: opts.title,
        chatId: opts.chatId,
        actions: opts.actions,
        index,
      });
    });
  }
  lastNotification = n;
  n.show();
}

/**
 * A Reply/Approve/Deny/option/quickReply tap decided to mean something real
 * (not `ignore`). Hands it to the renderer to actually send — it owns the WS
 * — and shows "Sent" / "Not sent — tap to retry" on the result, keeping
 * everything needed to retry (spec/09: never silently lost).
 */
function dispatchNotificationAction(opts: {
  title: string;
  chatId?: string;
  actions?: NotifyActionsPayload;
  index?: number;
  replyText?: string;
}): void {
  const intent = decideDesktopIntent(opts.actions, {
    index: opts.index,
    replyText: opts.replyText,
  });
  if (intent.kind === 'ignore' || !opts.chatId || !mainWindow) return;
  const chatId = opts.chatId;
  const requestId = `notif-send-${++notificationSendCounter}`;
  pendingNotificationSends.set(requestId, (ok: boolean) => {
    pendingNotificationSends.delete(requestId);
    showNativeNotification({
      title: opts.title,
      body: ok ? 'Sent' : 'Not sent — tap to retry',
      ...(ok
        ? {}
        : {
            retry: { chatId, actions: opts.actions, index: opts.index, replyText: opts.replyText },
          }),
    });
  });
  sendWhenReady(mainWindow, 'patch:notification-send', { requestId, chatId, intent });
}

/**
 * spec/14 ## Manager incoming-call UX: foreground the main window. On macOS a
 * renderer `window.focus()` cannot raise a backgrounded/minimised app window —
 * only the main process can, and the app must steal focus from whatever app is
 * frontmost. NO FALLBACK: create the window if it was closed so the banner has
 * somewhere to render.
 */
export function raiseMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // Briefly assert always-on-top so the OS lifts it above the focused app,
  // then release so it behaves normally once raised.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  // macOS: steal activation from the frontmost app so the window truly comes
  // forward even when another app is active.
  if (process.platform === 'darwin') {
    app.dock?.show();
    app.focus({ steal: true });
  }
  logDesktopEvent({ type: 'incoming-call:raise' });
}

function registerIpc(): void {
  panelWidthFraction = loadPanelWidthFraction();
  ipcMain.on('patch:request-raise', () => {
    raiseMainWindow();
  });
  // In-app browser toolbar buttons (in-app-browser.ts / iab-preload.ts). Each
  // drives the single embedded browser controller; a stray message when nothing
  // is open is a no-op.
  ipcMain.on('patch:iab:back', () => inAppBrowser?.goBack());
  ipcMain.on('patch:iab:forward', () => inAppBrowser?.goForward());
  ipcMain.on('patch:iab:reload', () => inAppBrowser?.reload());
  ipcMain.on('patch:iab:open-external', () => inAppBrowser?.openExternal());
  ipcMain.on('patch:iab:close', () => inAppBrowser?.close());
  // The ONLY way the web panel opens: Patch itself asking to show a page
  // (spec/14 § Links and the web panel). A user-clicked link reaches the panel
  // by its own route (`will-navigate`, attachWindowLinkPolicy), not through
  // here. NO FALLBACK: a non-http(s) or unparseable URL is refused rather than
  // loaded.
  ipcMain.on('patch:panel:open', (_e, payload: { url?: string }) => {
    const win = getMainWindow();
    if (!win) return;
    const action = routeWindowOpen(String(payload?.url ?? ''));
    if (action.kind === 'external') openInAppBrowser(win, action.url);
  });
  // The renderer putting the panel away (spec/14 § Artifacts — the panel shows
  // the CURRENT chat's artifact, so opening a chat without one, or leaving the
  // chat route, closes it). Distinct from `patch:iab:close`, which is the
  // panel's own toolbar button; a close with nothing open is a no-op.
  ipcMain.on('patch:panel:close', () => inAppBrowser?.close());
  // The divider is being dragged (spec/14 § Links and the web panel:
  // "drag-resizable like every other column"). Fires on every pointermove;
  // resizeTo moves the real views + pushes the inset immediately, and the
  // resulting share is persisted (debounced — see schedulePanelWidthSave).
  ipcMain.on('patch:panel:resize', (_e, payload: { width?: unknown }) => {
    if (typeof payload?.width !== 'number' || !inAppBrowser) return;
    inAppBrowser.resizeTo(payload.width);
    schedulePanelWidthSave(inAppBrowser.getWidthFraction());
  });
  // Double-click on the divider: back to the default share.
  ipcMain.on('patch:panel:reset-width', () => {
    if (!inAppBrowser) return;
    inAppBrowser.resetWidth();
    schedulePanelWidthSave(inAppBrowser.getWidthFraction());
  });
  ipcMain.on(
    'patch:notify',
    (
      _e,
      payload: {
        title: string;
        body: string;
        chatId?: string;
        priority?: NotifyPriority;
        kind?: 'message' | 'call' | 'batch' | 'ask';
        actions?: NotifyActionsPayload;
      },
    ) => {
      if (typeof payload?.title === 'string' && typeof payload?.body === 'string') {
        const args: Parameters<typeof showNativeNotification>[0] = {
          title: payload.title,
          body: payload.body,
        };
        if (payload.chatId !== undefined) args.chatId = payload.chatId;
        if (
          payload.priority === 'silent' ||
          payload.priority === 'normal' ||
          payload.priority === 'urgent'
        ) {
          args.priority = payload.priority;
        }
        if (payload.kind !== undefined) args.kind = payload.kind;
        if (payload.actions !== undefined) args.actions = payload.actions;
        showNativeNotification(args);
      }
    },
  );
  // spec/09 § Notification actions — the renderer's answer to a
  // `patch:notification-send` it was asked to deliver.
  ipcMain.on(
    'patch:notification-send-result',
    (_e, payload: { requestId?: unknown; ok?: unknown }) => {
      if (typeof payload?.requestId !== 'string' || typeof payload?.ok !== 'boolean') return;
      const resolve = pendingNotificationSends.get(payload.requestId);
      resolve?.(payload.ok);
    },
  );
  ipcMain.handle('patch:get-events', () => eventLog);
  // spec/14 § New windows — the renderer's explicit "open in new window"
  // actions (lib/newWindow.ts), never a link the user clicked (those stay on
  // the `setWindowOpenHandler` deny-and-hand-to-browser path above). A
  // malformed payload is a no-op, matching `patch:panel:open`'s handling of a
  // bad URL — there is no user-supplied string here to refuse loudly over,
  // only a caller bug.
  ipcMain.on('patch:window:open', (_e, payload: { path?: string; size?: unknown }) => {
    const path = payload?.path;
    if (typeof path === 'string' && path.startsWith('/'))
      openChildWindow(path, parseWindowSize(payload?.size));
  });
}

/**
 * Provenance of this shell, written into `dist/build-info.json` by
 * scripts/write-build-info.cjs at build time (shipped via the `dist/**` glob).
 *
 * Absent means unknown provenance — reported as unknown to the panel, NOT treated
 * as current. We don't throw: refusing to launch over a missing metadata file
 * would be worse than saying "I don't know what build I am".
 */
interface DesktopBuildInfo {
  version: string;
  gitSha: string | null;
  builtAt: string | null;
  /** Whether the build was produced with a real signing identity. */
  signed: boolean;
}
function readDesktopBuildInfo(): DesktopBuildInfo {
  const path = join(__dirname, 'build-info.json');
  if (!existsSync(path)) {
    return { version: app.getVersion(), gitSha: null, builtAt: null, signed: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DesktopBuildInfo>;
    return {
      version: parsed.version ?? app.getVersion(),
      gitSha: parsed.gitSha ?? null,
      builtAt: parsed.builtAt ?? null,
      signed: parsed.signed === true,
    };
  } catch {
    return { version: app.getVersion(), gitSha: null, builtAt: null, signed: false };
  }
}

/** The feed electron-updater will poll, read from the shipped app-update.yml. */
function readFeedUrl(updateConfigPath: string): string | null {
  if (!existsSync(updateConfigPath)) return null;
  try {
    return /^\s*url:\s*(\S+)/m.exec(readFileSync(updateConfigPath, 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

// Live updater state, owned by main and mirrored to the renderer panel.
let updaterState: UpdaterState | null = null;
const UPDATE_STATE_FILE = (): string => join(app.getPath('userData'), 'update-state.json');

/** Persist the durable slice so "last checked" survives a relaunch. */
function saveUpdaterState(): void {
  if (!updaterState) return;
  try {
    writeFileSync(UPDATE_STATE_FILE(), JSON.stringify(persistedOf(updaterState), null, 2));
  } catch (err) {
    // Losing the timestamp is not worth killing the app over, but it must be
    // visible rather than silent.
    console.error('[updater] failed to persist state', err);
  }
}

/** Apply an event, persist, and push the new state to the panel. */
function applyUpdaterEvent(event: UpdaterEvent): void {
  if (!updaterState) return;
  updaterState = reduceUpdater(updaterState, event);
  saveUpdaterState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('patch:updater-state', updaterState);
  }
}

/** The module's updater state (test/smoke introspection). */
export function getUpdaterState(): UpdaterState | null {
  return updaterState;
}

/**
 * Install a downloaded update now — quits and relaunches. The only install path
 * in the shell, and it is reached ONLY by the user pressing Restart on the
 * pending-update banner (web/components/DesktopUpdateBanner). Nothing in here
 * fires on a timer.
 *
 * A refusal (Squirrel won't apply an update to an adhoc signature) lands on the
 * version panel as an error rather than disappearing.
 */
function installUpdate(): void {
  quitAndInstallNow({
    app: app as unknown as { isQuitting: boolean },
    autoUpdater,
    onError: (err) =>
      applyUpdaterEvent({ type: 'error', message: err.message, at: new Date().toISOString() }),
  });
}

function setupAutoUpdater(): void {
  const build = readDesktopBuildInfo();
  const updateConfig = join(process.resourcesPath, 'app-update.yml');
  const hasUpdateConfig = existsSync(updateConfig);
  // The feed is wherever the server this app uses publishes it — nothing is built
  // in (spec/05 § Desktop first run). A server only this Mac can see publishes none.
  const remembered =
    app.isPackaged && !process.env['PATCH_SERVER_URL']
      ? loadFirstRun().remembered(app.getPath('userData'))
      : null;
  const noFeedReason =
    remembered?.connection.mode === 'local'
      ? 'this app runs its own server on this Mac, which publishes no desktop build — install a newer Patch app to update'
      : null;
  const feedUrl =
    app.isPackaged && SERVER_URL && noFeedReason === null
      ? `${serverOrigin(SERVER_URL)}/api/desktop/`
      : null;

  // Establish — and REPORT — whether this build can update at all, instead of
  // returning early and leaving the app permanently, invisibly inert.
  const disabledReason = diagnoseUpdater({
    isPackaged: app.isPackaged,
    hasUpdateConfig,
    version: build.version,
    signed: build.signed,
    noFeedReason,
  });

  let persisted = emptyPersisted();
  try {
    const file = UPDATE_STATE_FILE();
    if (existsSync(file)) persisted = parsePersisted(readFileSync(file, 'utf8'));
  } catch {
    // Unreadable state file → "never checked", which is the truthful reading.
  }

  updaterState = initialUpdaterState({
    currentVersion: build.version,
    gitSha: build.gitSha,
    builtAt: build.builtAt,
    feedUrl: feedUrl ?? readFeedUrl(updateConfig),
    disabledReason,
    persisted,
  });

  // The panel reads state and drives checks/installs regardless of whether the
  // updater is functional — that's how the disabledReason reaches the user.
  ipcMain.handle('patch:updater:get-state', () => updaterState);
  // spec/09 § Presence heuristic — how long since ANY input on this Mac, in any
  // app. The server reads it to decide whether Tom is at the computer.
  ipcMain.handle('patch:system-idle-ms', () => powerMonitor.getSystemIdleTime() * 1000);
  // Meeting mode: start/stop the system-audio tap and stream its PCM to the
  // renderer that asked. A tap left running by a renderer that reloaded is
  // replaced, not refused.
  ipcMain.handle('patch:system-audio:start', async (e) => {
    const sender = e.sender;
    systemAudio.stop();
    await systemAudio.start({
      onPcm: (pcm) => {
        if (!sender.isDestroyed()) sender.send('patch:system-audio', pcm);
      },
      onFailed: (message) => {
        if (!sender.isDestroyed()) sender.send('patch:system-audio-failed', { message });
      },
    });
    sender.once('destroyed', () => systemAudio.stop());
  });
  ipcMain.on('patch:system-audio:stop', () => systemAudio.stop());
  // spec/02 § Desktop app and the local host — whether this Mac runs a
  // host, and installing one with a pairing code the SPA just minted.
  ipcMain.handle('patch:local-daemon:status', () => localDaemonStatus(app.getPath('home')));
  ipcMain.handle('patch:local-daemon:install', (_e, payload: { code?: unknown }) =>
    installLocalDaemon({
      serverUrl: serverOrigin(SERVER_URL),
      code: typeof payload?.code === 'string' ? payload.code : '',
      home: app.getPath('home'),
    }),
  );
  ipcMain.handle('patch:updater:check', async () => {
    await checkForUpdates();
    return updaterState;
  });
  // A deploy just landed (the SPA saw a new bundle hash on `auth.ok` — see
  // web/lib/liveUpdate.ts). Check the feed NOW rather than waiting up to an hour
  // for the interval, so the banner appears promptly. Downloading is all that
  // follows; installing waits for the user.
  ipcMain.on('patch:updater:check-now', () => {
    void checkForUpdates();
  });

  // The banner's Restart button. This is the ONLY way a running shell quits for
  // an update; everything else waits for an ordinary quit
  // (autoInstallOnAppQuit, left at its default true).
  ipcMain.on('patch:updater:install', () => {
    installUpdate();
  });

  // An unusable updater is wired for reporting but never asked to check — calling
  // checkForUpdates without app-update.yml just ENOENT-rejects on every launch.
  if (disabledReason !== null && !hasUpdateConfig) return;

  if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl, channel: 'latest' });
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info: { version: string }) => {
    logDesktopEvent({ type: 'auto-update:available' });
    applyUpdaterEvent({ type: 'available', version: info.version, at: new Date().toISOString() });
  });
  autoUpdater.on('update-not-available', () => {
    applyUpdaterEvent({ type: 'up-to-date', at: new Date().toISOString() });
  });
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    logDesktopEvent({ type: 'auto-update:downloaded' });
    applyUpdaterEvent({ type: 'downloaded', version: info.version, at: new Date().toISOString() });
    // The update is now staged on disk, and that is ALL that happens here.
    //
    // This used to call installUpdate() — quit the app, swap the bundle, come
    // back ~75 seconds later, whatever you were in the middle of. No other
    // Squirrel app does that: Chrome, VS Code, Slack and Discord all download
    // quietly and wait to be asked. Being ambushed by your own editor vanishing
    // is worse than running an hour-old build, and it is much worse once other
    // people use the app.
    //
    // Two things take its place, neither of them an interruption:
    //   - electron-updater's `autoInstallOnAppQuit` (default true, never
    //     overridden here) applies it the next time the shell quits anyway;
    //   - `staleSince` ages, and the banner escalates — see updateUrgency.
    // The user presses Restart when it suits them, or quits one evening and
    // gets it for free.
  });
  autoUpdater.on('error', (err: Error) => {
    // Surfaced verbatim to the panel. This is the path that used to swallow the
    // "Could not get code signature" failure on an adhoc-signed build.
    applyUpdaterEvent({ type: 'error', message: err.message, at: new Date().toISOString() });
  });

  void checkForUpdates();
  // The shell is a tray app that stays running for days, so a launch-only check
  // left a published update unnoticed until the next restart — which could be
  // weeks. Re-check hourly so a deploy reaches it without the user asking.
  setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
}

/** How often a running shell re-checks the update feed. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Run a check, recording the outcome either way. Exported so the panel's
 * "Check now" and the boot check share one path.
 */
let checkRunner: (() => Promise<void>) | null = null;

export async function checkForUpdates(): Promise<void> {
  if (!updaterState) return;
  // Every check MUST record an outcome. electron-updater reports results through
  // events, and when it is inert (no app-update.yml, updates disabled) it can
  // resolve having emitted nothing at all — leaving `lastCheckedAt` untouched, so
  // "Check now" would appear to do nothing and the panel would keep showing a
  // stale previous result. Caught by the real-Electron smoke. NO FALLBACK to a
  // cheerful "up to date": if nothing answered, say so. The runner also bounds
  // the check in time and joins overlapping calls (see createCheckRunner).
  let before: string | null = null;
  checkRunner ??= createCheckRunner({
    start: () => {
      before = updaterState?.lastCheckedAt ?? null;
      applyUpdaterEvent({ type: 'check-started' });
    },
    record: applyUpdaterEvent,
    check: () => autoUpdater.checkForUpdates(),
    hasOutcomeSinceStart: () => updaterState?.lastCheckedAt !== before,
    silentReason: () => updaterState?.disabledReason ?? null,
  });
  await checkRunner();
}

/**
 * Are we the Electron app entry point (i.e. launched as `electron
 * dist/main.js` or the packaged app), as opposed to being `require()`-d by a
 * smoke/test harness that drives our exports directly?
 *
 * The classic Node idiom `require.main === module` is ALWAYS false under
 * Electron: Electron loads the main script through its own bootstrap, not via
 * CommonJS, so `require.main` is `undefined`. Relying on it left the whole
 * shell (window, tray, global hotkeys, incoming-call raise) un-bootstrapped on
 * every real launch. Instead, compare the resolved entry script
 * (`process.argv[1]`) against this file. When a harness requires us, argv[1]
 * is the harness script — not main.js — so bootstrap is correctly skipped.
 */
function isAppEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(entry) === real(__filename);
}

/**
 * What the shell looks like to the first-run page (spec/05 § Desktop first run):
 * a small window of its own asking where Patch runs, answered over IPC.
 */
function showSetupWindow(): {
  window: BrowserWindow;
  ui: { choose(): Promise<SetupChoice>; progress(m: string): void; fail(m: string): void };
} {
  const window = new BrowserWindow({
    width: 560,
    height: 460,
    title: 'Patch',
    show: true,
    resizable: false,
    ...windowChrome(process.platform),
    webPreferences: {
      preload: join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void window.loadFile(join(__dirname, 'setup.html'));
  let pending: ((c: SetupChoice) => void) | null = null;
  const onChoose = (event: { sender: unknown }, choice: SetupChoice): void => {
    if (event.sender !== window.webContents) return;
    pending?.(choice);
    pending = null;
  };
  ipcMain.on('patch:setup:choose', onChoose as never);
  window.once('closed', () => ipcMain.removeListener('patch:setup:choose', onChoose as never));
  return {
    window,
    ui: {
      choose: () => new Promise<SetupChoice>((resolve) => (pending = resolve)),
      progress: (m) => window.webContents.send('patch:setup:progress', m),
      fail: (m) => window.webContents.send('patch:setup:fail', m),
    },
  };
}

/**
 * Work out which server this app talks to (spec/05 § Desktop first run): the
 * remembered one, or the answer to the first-run question. Sets SERVER_URL and
 * the credential-carrying first page, or quits if the question is closed
 * unanswered. A developer run (`pnpm dev`, or PATCH_SERVER_URL) skips all of it.
 */
async function resolveServer(): Promise<void> {
  if (process.env['PATCH_SERVER_URL'] || !app.isPackaged) return;
  const firstRun = loadFirstRun();
  const userData = app.getPath('userData');
  let setup: ReturnType<typeof showSetupWindow> | null = null;
  const ui = {
    choose: () => {
      if (!setup) {
        setup = showSetupWindow();
        // Closing the question unanswered is declining to use the app.
        setup.window.once('closed', () => {
          if (!activeLaunch) app.exit(0);
        });
      }
      return setup.ui.choose();
    },
    progress: (m: string) => setup?.ui.progress(m),
    fail: (m: string) => setup?.ui.fail(m),
  };
  try {
    const launched = await firstRun.launch({
      userData,
      home: app.getPath('home'),
      resources: process.resourcesPath,
      execPath: process.execPath,
      relayUrl: process.env['PATCH_RELAY_URL'] ?? DEFAULT_RELAY_URL,
      label: `${app.getName()} on ${hostname()}`,
      ui,
      installHost: (origin, code) =>
        installLocalDaemon({ serverUrl: origin, code, home: app.getPath('home') }),
      hostInstalled: () => localDaemonStatus(app.getPath('home')).installed,
    });
    activeLaunch = launched;
    initialUrl = launched.appUrl;
    const base = new URL(launched.appUrl);
    base.hash = '';
    SERVER_URL = base.toString();
  } catch (err) {
    // A remembered connection that cannot be brought up, or a damaged file: say
    // so and stop. Carrying on with no server would be a window with nothing in it.
    dialog.showErrorBox('Patch could not start', err instanceof Error ? err.message : String(err));
    app.exit(1);
    return;
  }
  const done = setup as ReturnType<typeof showSetupWindow> | null;
  if (done) done.window.destroy();
}

/** The relay a phone reaches this Mac's own server through, unless PATCH_RELAY_URL says otherwise. */
const DEFAULT_RELAY_URL = 'wss://patch.tomchambers.me/relay';

/** App menu → Switch Server…: forget the server this app uses, then ask again on relaunch. */
async function switchServer(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Switch Server', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Switch server?',
    detail:
      'This app forgets which server it uses and asks again. Nothing is deleted from any server.',
  });
  if (response !== 0) return;
  loadFirstRun().forgetConnection(app.getPath('userData'));
  app.relaunch();
  app.quit();
}

/** A server a browser can reach, for Help → Patch on the web; nothing for one only this Mac can see. */
function webUrlForHelp(): string | undefined {
  if (!SERVER_URL) return undefined;
  const host = new URL(SERVER_URL).hostname;
  return host === '127.0.0.1' || host === 'localhost' ? undefined : SERVER_URL;
}

export function bootstrap(): void {
  // One process owns the profile. A second copy cannot open Chromium's locked
  // localStorage database and otherwise misleadingly renders the pairing page.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    void app.whenReady().then(() => {
      const win = ensureMainWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      app.dock?.show();
    }
    // Which server this app talks to — the remembered one, or the first-run
    // question — before any window shows Patch itself.
    await resolveServer();
    // Reload has to exist. The UI is a remote page, so when the window and the
    // deployed SPA disagree there is otherwise no way back — see app-menu.ts.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate(app.getName(), {
          openExternal: (url) => void shell.openExternal(url),
          switchServer: () => void switchServer(),
          ...(webUrlForHelp() ? { webUrl: webUrlForHelp() as string } : {}),
        }),
      ),
    );
    // Enable the composer's screenshot-grab button (spec/14 § Composer): the web
    // SPA calls navigator.mediaDevices.getDisplayMedia(), which Electron refuses
    // ("Not supported") UNLESS the main process answers the request. On macOS
    // (Electron 33) `useSystemPicker: true` shows the NATIVE screen/window picker
    // — no custom UI, and it Just Works. We still register a desktopCapturer
    // fallback source so non-macOS builds capture the primary screen rather than
    // failing loudly. NO FALLBACK to a silent no-op: without this the button
    // errored on the desktop shell.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen', 'window'] })
          .then((sources) => {
            // Video only: Meeting mode no longer shares a screen to hear the
            // call (it uses the native audio helper, `meeting-audio.ts`), so
            // nothing here ever hands out system audio.
            callback(sources.length > 0 ? { video: sources[0] } : {});
          })
          .catch(() => callback({}));
      },
      { useSystemPicker: true },
    );
    // The shell's whole permission allowlist, on the app's own origin only: the
    // mic (voice notes / voice calls) and the clipboard WRITE (the code-block
    // copy control, Copy report). Registering a handler at all replaces
    // Electron's defaults, so both have to be granted here or they fail in the
    // packaged app while working in a browser. NO FALLBACK: anything else, and
    // anything from another origin, is refused (permissions.ts).
    configurePermissions(session.defaultSession, SERVER_URL);
    mainWindow = createMainWindow();
    tray = createTray();
    registerGlobalHotkeys();
    registerIpc();
    startMeetingDetection();
    setupAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
      else mainWindow?.show();
    });
  });

  app.on('before-quit', () => {
    (app as unknown as { isQuitting: boolean }).isQuitting = true;
  });

  app.on('will-quit', (e) => {
    globalShortcut.unregisterAll();
    systemAudio.stop();
    stopMicWatch?.();
    tray?.destroy();
    // The server this Mac runs for itself (or the bridge to a relayed one) stops
    // with the app; quitting waits for it so the port is free next time.
    if (activeLaunch) {
      e.preventDefault();
      const launched = activeLaunch;
      activeLaunch = null;
      void launched.stop().finally(() => app.quit());
    }
  });

  // macOS — keep running with no windows so tray + hotkey stay live.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// A PACKAGED app is always the entry — Electron loads `main` from package.json,
// so `process.argv[1]` is NOT main.js and `isAppEntry()` would wrongly return
// false, leaving the app running with no window/tray ("won't launch"). The argv
// check only matters in dev, to skip bootstrap when a test harness imports us.
if (app.isPackaged || isAppEntry()) {
  bootstrap();
}
