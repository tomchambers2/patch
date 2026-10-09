// Real-Electron smoke for the menu-bar surface + global hotkeys (G4).
//
// Boots a real Electron runtime and exercises the SAME APIs main.ts uses:
//   - Tray created from the shipped template icon (throws if missing).
//   - 360px frameless popover BrowserWindow loads /menubar from the dev SPA.
//   - globalShortcut.register for ⌃Space (voice note) and ⌃⇧Space (call).
//   - A frameless voice-note overlay BrowserWindow loads /voice-overlay.
//
// Asserts each step against the live Electron API (not source regex), prints a
// JSON verdict to stdout, and quits. Exit code 0 = pass.
//
// Usage: electron scripts/smoke.cjs  (PATCH_SERVER_URL overrides the dev URL)

const { app, BrowserWindow, Tray, globalShortcut, nativeImage } = require('electron');
const { join } = require('node:path');

const SERVER_URL = process.env.PATCH_SERVER_URL || 'http://localhost:5173/app/';
// Build a route URL under /app, preserving any ?credential= dev-bypass param
// (appending `/menubar` to a `?credential=JWT` URL would corrupt the token).
function routeUrl(routePath) {
  const u = new URL(SERVER_URL);
  const baseDir = u.pathname.replace(/\/$/, '');
  u.pathname = `${baseDir}/${routePath}`;
  return u.toString();
}
const HOTKEY = process.env.PATCH_GLOBAL_HOTKEY || 'Control+Space';
const CALL_HOTKEY = process.env.PATCH_GLOBAL_CALL_HOTKEY || 'Control+Shift+Space';

const steps = {};
const errors = [];

function loadWindow(opts, url) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    ...opts,
  });
  return new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', () =>
      resolve({ win, url: win.webContents.getURL(), width: win.getBounds().width }),
    );
    win.webContents.once('did-fail-load', (_e, code, desc) =>
      reject(new Error(`did-fail-load ${code} ${desc}`)),
    );
    win.loadURL(url);
  });
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let tray = null;
  let popover = null;
  let overlay = null;

  // 1. Tray icon
  try {
    const candidate = join(__dirname, '..', 'build', 'trayIconTemplate.png');
    const icon = nativeImage.createFromPath(candidate);
    if (icon.isEmpty()) throw new Error(`tray icon empty: ${candidate}`);
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Patch');
    steps['tray-icon-loads'] = !tray.isDestroyed();
  } catch (e) {
    steps['tray-icon-loads'] = false;
    errors.push(`tray: ${e.message}`);
  }

  // 2. 360px popover → /menubar
  try {
    const r = await loadWindow({ width: 360, height: 480, resizable: false }, routeUrl('menubar'));
    popover = r.win;
    steps['popover-loads-menubar'] = { width: r.width, url: r.url };
    if (r.width !== 360) errors.push(`popover width ${r.width} != 360`);
    if (!/\/menubar(\?|$)/.test(r.url)) errors.push(`popover url ${r.url} not /menubar`);
  } catch (e) {
    steps['popover-loads-menubar'] = false;
    errors.push(`popover: ${e.message}`);
  }

  // 3. ⌃Space voice-note hotkey
  try {
    const ok = globalShortcut.register(HOTKEY, () => {});
    if (!ok) throw new Error(`register failed for ${HOTKEY}`);
    steps['voice-note-hotkey'] = {
      ok,
      registered: globalShortcut.isRegistered(HOTKEY),
      accelerator: HOTKEY,
    };
    if (!globalShortcut.isRegistered(HOTKEY)) errors.push('voice-note hotkey not registered');
  } catch (e) {
    steps['voice-note-hotkey'] = false;
    errors.push(`voice-note-hotkey: ${e.message}`);
  }

  // 4. ⌃⇧Space voice-call hotkey
  try {
    const ok = globalShortcut.register(CALL_HOTKEY, () => {});
    if (!ok) throw new Error(`register failed for ${CALL_HOTKEY}`);
    steps['voice-call-hotkey'] = {
      ok,
      registered: globalShortcut.isRegistered(CALL_HOTKEY),
      accelerator: CALL_HOTKEY,
    };
    if (!globalShortcut.isRegistered(CALL_HOTKEY)) errors.push('voice-call hotkey not registered');
  } catch (e) {
    steps['voice-call-hotkey'] = false;
    errors.push(`voice-call-hotkey: ${e.message}`);
  }

  // 5. voice-note overlay → /voice-overlay
  try {
    const r = await loadWindow(
      { width: 360, height: 120, alwaysOnTop: true, transparent: true },
      routeUrl('voice-overlay'),
    );
    overlay = r.win;
    steps['voice-overlay-loads'] = { url: r.url };
    if (!/\/voice-overlay(\?|$)/.test(r.url)) errors.push(`overlay url ${r.url} not /voice-overlay`);
  } catch (e) {
    steps['voice-overlay-loads'] = false;
    errors.push(`overlay: ${e.message}`);
  }

  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
  if (popover) popover.destroy();
  if (overlay) overlay.destroy();

  const pass = errors.length === 0;
  // eslint-disable-next-line no-console
  console.log('SMOKE_RESULT ' + JSON.stringify({ pass, steps, errors }));
  app.exit(pass ? 0 : 1);
});

app.on('window-all-closed', () => {});
