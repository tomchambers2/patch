// Real-Electron smoke for G4-15: the menu-bar surface emits surface.heartbeat
// ONLY while the dropdown (tray popover) is OPEN, and stops when it closes.
//
// The dropdown's open/closed state is delivered to the popover renderer via the
// `patch:menubar-visibility` IPC that main.ts sends from the popover window's
// show/hide (Electron's BrowserWindow.hide() does NOT fire the renderer's
// `visibilitychange`, so the renderer can't infer this from the DOM). The
// menu-bar surface drives PatchWs.foreground()/background() off that IPC, which
// starts/stops the 10s surface.heartbeat.
//
// We load the real /menubar route (authenticated via the dev ?credential=
// bypass) with the real preload, hook WebSocket.send in the renderer to count
// outbound surface.heartbeat frames, and drive the SAME IPC main.ts sends:
//   1. open (visible:true)  for one interval → expect ≥1 heartbeat
//   2. close (visible:false) for one interval → expect 0 NEW heartbeats
//   3. open again            for one interval → heartbeats resume
//
// This exercises the production wiring end-to-end (preload bridge → MenubarRoute
// effect → PatchWs heartbeat). The only piece NOT exercised here is Electron's
// window show/hide *event* firing — unreliable on a headless host with no
// WindowServer session — but main.ts wires those events to this exact IPC, and
// the IPC→heartbeat path (the substantive behaviour) is fully verified.
//
// Usage: electron scripts/smoke-heartbeat.cjs <full /menubar ?credential= url>

const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

const CRED_URL = process.argv[2] || process.env.PATCH_MENUBAR_URL;
if (!CRED_URL) {
  console.error('usage: electron smoke-heartbeat.cjs <full /menubar ?credential= url>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTERVAL = 12500; // > the 10s HEARTBEAT_INTERVAL_MS

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, c, d) => reject(new Error(`load ${c} ${d}`)));
    win.loadURL(CRED_URL);
  });

  await win.webContents.executeJavaScript(`
    (function () {
      window.__hb = [];
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === 'string' && data.indexOf('surface.heartbeat') !== -1) {
            window.__hb.push(Date.now());
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      return true;
    })();
  `);

  const count = () => win.webContents.executeJavaScript(`window.__hb.length`);
  const setVisible = (visible) =>
    win.webContents.send('patch:menubar-visibility', { visible });

  const steps = {};

  // Phase 1: dropdown OPEN.
  setVisible(true);
  await sleep(INTERVAL);
  steps.phase1_open_count = await count();

  // Phase 2: dropdown CLOSED (tray-icon-only).
  const atClose = await count();
  setVisible(false);
  await sleep(INTERVAL);
  const afterClosed = await count();
  steps.phase2_closed = { atClose, afterClosed, newWhileClosed: afterClosed - atClose };

  // Phase 3: dropdown OPEN again.
  const atReopen = await count();
  setVisible(true);
  await sleep(INTERVAL);
  const afterReopen = await count();
  steps.phase3_reopen = { atReopen, afterReopen, newAfterReopen: afterReopen - atReopen };

  const errors = [];
  if (steps.phase1_open_count < 1) errors.push('no heartbeat while dropdown open');
  if (steps.phase2_closed.newWhileClosed !== 0)
    errors.push(`heartbeats fired while dropdown closed (${steps.phase2_closed.newWhileClosed}, want 0)`);
  if (steps.phase3_reopen.newAfterReopen < 1)
    errors.push('heartbeats did not resume after reopening dropdown');

  win.destroy();
  const pass = errors.length === 0;
  // eslint-disable-next-line no-console
  console.log('HEARTBEAT_SMOKE_RESULT ' + JSON.stringify({ pass, steps, errors }));
  app.exit(pass ? 0 : 1);
});

app.on('window-all-closed', () => {});
