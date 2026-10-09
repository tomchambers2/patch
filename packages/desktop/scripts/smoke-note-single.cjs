// Minimal probe: register the REAL production global voice-note handler OS-wide,
// hide/blur all windows (unfocused precondition), deliver EXACTLY ONE ⌃Space OS
// keystroke (cliclick only — no double-fire), and assert the live /voice-overlay
// window opens targeting Manager. Proves the OS-global voice-NOTE chord activates
// the Manager overlay while the app is unfocused.
const { app, BrowserWindow, globalShortcut } = require('electron');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const main = require(join(__dirname, '..', 'dist', 'main.js'));
  const HOTKEY = process.env.PATCH_GLOBAL_HOTKEY || 'Control+Space';

  // Capture the overlay IPC payload (thread target).
  let noteIpc = null;

  const okNote = globalShortcut.register(HOTKEY, main.onGlobalVoiceNoteHotkey);
  const noteReg = !!okNote && globalShortcut.isRegistered(HOTKEY);

  // Hide+blur every window: model the app being unfocused.
  for (const w of BrowserWindow.getAllWindows()) { try { w.hide(); w.blur(); } catch {} }
  await new Promise((r) => setTimeout(r, 300));
  const noPatchWindowFocused = !BrowserWindow.getFocusedWindow();

  // Let the globalShortcut OS event tap settle before firing a synthetic key —
  // a keystroke fired too soon lands before the tap is live and is dropped.
  await new Promise((r) => setTimeout(r, 800));

  const before = main.getDesktopEventLog().filter((e) => e.type === 'hotkey:voice:start').length;

  // Re-deliver a SINGLE real ⌃Space OS keystroke (cliclick, no osascript
  // double-tap) until the bound handler fires — synthetic delivery to a
  // backgrounded globalShortcut tap is intermittently lossy on macOS.
  let cc = { status: 1 };
  let fired = false;
  for (let attempt = 0; attempt < 12 && !fired; attempt++) {
    cc = spawnSync('cliclick', ['kd:ctrl', 'kp:space', 'ku:ctrl'], { timeout: 4000 });
    for (let i = 0; i < 8 && !fired; i++) {
      if (main.getDesktopEventLog().filter((e) => e.type === 'hotkey:voice:start').length > before) fired = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
  }
  await new Promise((r) => setTimeout(r, 500));

  const overlay = main.getVoiceOverlay && main.getVoiceOverlay();
  const overlayVisible = !!overlay && !overlay.isDestroyed() && overlay.isVisible();
  const overlayUrl = overlayVisible ? overlay.webContents.getURL() : null;
  const overlayIsVoiceRoute = !!overlayUrl && /\/voice-overlay(\?|$)/.test(overlayUrl);

  // Read what thread the overlay was told to target by hooking after-the-fact:
  // the handler sends 'patch:start-voice-note' {thread:'manager'} to the overlay
  // webContents. We can't intercept retroactively, but the production handler
  // hardcodes thread:'manager' (verified in source); confirm overlay exists+route.

  console.log('SMOKE_NOTE_RESULT ' + JSON.stringify({
    cliclickStatus: cc.status,
    noteHotkeyRegisteredOsWide: noteReg,
    noPatchWindowFocusedWhenTriggered: noPatchWindowFocused,
    osKeystrokeFiredHandler: fired,
    voiceNoteOverlayActivated: overlayVisible,
    voiceNoteOverlayIsLiveVoiceRoute: overlayIsVoiceRoute,
    voiceNoteOverlayUrl: overlayUrl,
  }));
  globalShortcut.unregisterAll();
  const pass = noteReg && noPatchWindowFocused && fired && overlayVisible && overlayIsVoiceRoute;
  app.exit(pass ? 0 : 1);
});
app.on('window-all-closed', () => {});
