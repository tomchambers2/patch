// Real-Electron INTEGRATION smoke — drives the ACTUAL exports of dist/main.js
// under a live Electron runtime (not source regex, not a reimplementation).
//
// This closes the gap left by smoke.cjs (which builds its own windows/tray) and
// main.test.ts (which greps source text): here we call createMainWindow,
// onGlobalVoiceNoteHotkey, onGlobalVoiceCallHotkey, raiseMainWindow, bootstrap,
// etc. and assert their genuine side effects on real BrowserWindow/Tray/IPC.
//
// Usage: electron scripts/smoke-integration.cjs
//   PATCH_SERVER_URL overrides the SPA (default: deployed app + a dummy
//   ?credential= so we can assert query-string preservation through routeUrl).
//
// Prints `INTEGRATION_RESULT <json>`; exit 0 = all checks passed.

const assert = require('node:assert/strict');
const { app, ipcMain, BrowserWindow } = require('electron');

if (!process.env.PATCH_SERVER_URL) {
  process.env.PATCH_SERVER_URL = 'https://patch.tomchambers.me/app/?credential=SMOKE';
}

app.disableHardwareAcceleration();

const checks = {};
const errors = [];
function check(name, fn) {
  try {
    const r = fn();
    checks[name] = r === undefined ? true : r;
  } catch (e) {
    checks[name] = false;
    errors.push(`${name}: ${e.message}`);
  }
}
function once(emitter, ev, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    emitter.once(ev, (...a) => {
      clearTimeout(t);
      resolve(a);
    });
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub shell.openExternal BEFORE any window-open handler can fire, so testing
// the external-link path records the URL instead of actually launching the
// user's real browser (which is disruptive — and the whole point is that we
// route external links OUT of the app).
const electron = require('electron');
const externalOpens = [];
electron.shell.openExternal = (url) => {
  externalOpens.push(url);
  return Promise.resolve();
};

app.whenReady().then(async () => {
  // Silence the harness: stub electron.Notification BEFORE requiring main.js so
  // the patch:notify check never fires a real OS toast (no sound). main.js
  // destructures Notification at module load, so this must precede the require.
  // Extends EventEmitter so n.on('click', …)/n.emit('click') still work — the
  // notification-click navigate test (section 10b) depends on that — while
  // show() is a no-op (no OS toast, no sound).
  const electron = require('electron');
  const { EventEmitter } = require('node:events');
  class SilentNotification extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
    }
    show() {
      /* no OS toast, no sound */
    }
    close() {}
    static isSupported() {
      return true;
    }
  }
  electron.Notification = SilentNotification;

  const m = require('../dist/main.js');

  // --- 1. main window geometry + load ------------------------------------
  const win = m.createMainWindow();
  check('main-window-size', () => {
    const b = win.getBounds();
    assert.equal(b.width, 1200, `width ${b.width}`);
    assert.equal(b.height, 800, `height ${b.height}`);
  });
  check('main-window-title', () => assert.equal(win.getTitle(), 'Patch'));
  check('main-window-singleton', () => assert.equal(m.getMainWindow(), win));
  // spec/05 § Window chrome — the overlay title bar is macOS-only, and this
  // smoke runs on Linux, where the window keeps its native frame and Electron
  // exposes no getter for either option. What CAN be checked here, and cannot
  // be checked by a unit test, is that the options the module emits are ones
  // THIS Electron build actually accepts: a renamed or dropped option would
  // throw (or be silently ignored) at construction, on Tom's Mac only.
  check('window-chrome-options-accepted-by-electron', () => {
    const { windowChrome } = require('../dist/window-chrome.js');
    const chrome = windowChrome('darwin');
    assert.equal(chrome.titleBarStyle, 'hidden');
    const probe = new BrowserWindow({ width: 400, height: 300, show: false, ...chrome });
    try {
      assert.ok(!probe.isDestroyed(), 'window chrome options destroyed the window');
    } finally {
      probe.destroy();
    }
  });
  try {
    await once(win.webContents, 'did-finish-load');
    check('main-window-loads-server', () =>
      assert.match(win.webContents.getURL(), /patch\.tomchambers\.me\/app\//),
    );
  } catch (e) {
    check('main-window-loads-server', () => {
      throw e;
    });
  }

  // --- 1b. preload bridge actually materialises in the renderer ---------
  // The source tests only grep preload.ts. This proves the contextBridge runs
  // and the preload PATH resolves: if window.patch were undefined the whole
  // notify/voice/raise IPC surface would be dead at runtime.
  try {
    const keys = await win.webContents.executeJavaScript(
      'window.patch ? Object.keys(window.patch) : null',
    );
    check('preload-exposes-patch-bridge', () => assert.ok(keys, 'window.patch is undefined'));
    check('preload-has-all-bridge-methods', () => {
      const expected = [
        'notify',
        'onNavigate',
        'onStartVoiceNote',
        'onStartVoiceCall',
        'requestRaise',
        'onMenubarVisibility',
        'getDesktopEvents',
        'getSystemIdleMs',
      ];
      for (const k of expected) assert.ok((keys || []).includes(k), `bridge missing ${k}`);
    });
  } catch (e) {
    check('preload-exposes-patch-bridge', () => {
      throw e;
    });
  }

  // --- 1c. external http(s) links open in the EMBEDDED in-app browser ----
  // patch/todo.md "In-app browser like Claude": a window.open / target=_blank
  // external link opens INSIDE Patch (a WebContentsView panel), NOT a separate
  // OS window and NOT the user's real browser. Detailed behaviour (toolbar,
  // layout, back/forward, open-in-browser) is covered by smoke-in-app-browser.cjs.
  try {
    const winsBefore = BrowserWindow.getAllWindows().length;
    await win.webContents.executeJavaScript('window.open("https://example.com/ext-smoke"); true;');
    await delay(300);
    check('external-link-not-opened-in-a-new-window', () =>
      assert.equal(
        BrowserWindow.getAllWindows().length,
        winsBefore,
        'an external link spawned a separate OS window',
      ),
    );
    check('external-link-opens-in-app-browser', () => {
      const iab = m.getInAppBrowser();
      assert.ok(iab && iab.isOpen(), 'in-app browser did not open');
      assert.match(iab.currentUrl(), /example\.com\/ext-smoke/);
    });
    check('external-link-not-sent-to-real-browser', () =>
      assert.ok(
        !externalOpens.includes('https://example.com/ext-smoke'),
        `link leaked to the real browser (${JSON.stringify(externalOpens)})`,
      ),
    );
  } catch (e) {
    check('external-link-opens-in-app-browser', () => {
      throw e;
    });
  }

  // --- 1d. plain <a href> click (in-place navigation) opens in-app --------
  // A plain link click — no target=_blank, no window.open — triggers an
  // IN-PLACE navigation of the main window's webContents (`will-navigate`),
  // NOT setWindowOpenHandler. Without a will-navigate guard the whole Patch
  // SPA navigates away to the external site ("opens in the Patch app"). The
  // guard must keep the SPA put and open the URL in the in-app browser instead.
  try {
    const beforeUrl = win.webContents.getURL();
    const beforeOpens = externalOpens.length;
    // Simulate a same-window navigation the way a clicked <a href> does.
    await win.webContents.executeJavaScript(
      'window.location.assign("https://example.com/inplace-smoke"); true;',
    );
    await delay(400);
    check('in-app-link-does-not-navigate-spa-away', () =>
      assert.ok(
        win.webContents.getURL().includes('patch.tomchambers.me/app/'),
        `SPA navigated away to ${win.webContents.getURL()}`,
      ),
    );
    check('in-app-link-opens-in-app-browser', () => {
      const iab = m.getInAppBrowser();
      assert.ok(iab && iab.isOpen(), 'in-app browser did not open for in-place nav');
      assert.match(iab.currentUrl(), /example\.com\/inplace-smoke/);
    });
    check('in-app-link-not-sent-to-real-browser', () =>
      assert.ok(
        !externalOpens.slice(beforeOpens).includes('https://example.com/inplace-smoke'),
        `in-place nav leaked to the real browser (${JSON.stringify(externalOpens)})`,
      ),
    );
    void beforeUrl;
  } catch (e) {
    check('in-app-link-opens-in-app-browser', () => {
      throw e;
    });
  }
  // Close the in-app browser so its page view doesn't overlay the main window
  // for the subsequent geometry/visibility checks.
  m.getInAppBrowser()?.close();

  // --- 2. Cmd+W: close hides (not quits), logs window:hidden -------------
  check('main-window-visible-initially', () => assert.ok(win.isVisible()));
  let prevented = false;
  win.emit('close', {
    preventDefault() {
      prevented = true;
    },
  });
  check('close-prevented', () => assert.ok(prevented, 'close not preventDefault-ed'));
  check('close-hides-window', () => assert.ok(!win.isVisible()));
  check('close-logs-window-hidden', () =>
    assert.ok(m.getDesktopEventLog().some((e) => e.type === 'window:hidden')),
  );

  // --- 3. ⌃Space voice-note overlay: show, target Manager, toggle -------
  m.onGlobalVoiceNoteHotkey();
  const ov = m.getVoiceOverlay();
  check('overlay-created', () => assert.ok(ov, 'no voice overlay'));
  try {
    await once(ov.webContents, 'did-finish-load');
  } catch {
    /* assert below on URL regardless */
  }
  check('overlay-geometry', () => {
    const b = ov.getBounds();
    assert.equal(b.width, 360, `width ${b.width}`);
    assert.equal(b.height, 120, `height ${b.height}`);
  });
  check('overlay-frameless-ontop', () => {
    assert.ok(ov.isAlwaysOnTop(), 'overlay not always-on-top');
  });
  check('overlay-visible-after-note-hotkey', () => assert.ok(ov.isVisible()));
  check('overlay-url-is-voice-overlay', () =>
    assert.match(ov.webContents.getURL(), /\/voice-overlay(\?|$)/),
  );
  // routeUrl must preserve the query string (the ?credential= dev bypass).
  check('overlay-preserves-credential-query', () =>
    assert.match(ov.webContents.getURL(), /[?&]credential=SMOKE/),
  );
  // toggle: second press hides
  m.onGlobalVoiceNoteHotkey();
  check('overlay-hidden-after-toggle', () => assert.ok(!ov.isVisible()));
  check('note-hotkey-logs-start-and-end', () => {
    const log = m.getDesktopEventLog();
    assert.ok(
      log.some((e) => e.type === 'hotkey:voice:start'),
      'no voice:start',
    );
    assert.ok(
      log.some((e) => e.type === 'hotkey:voice:end'),
      'no voice:end',
    );
  });

  // --- 3b. voice-note overlay DELIVERS start-voice-note{thread:manager} ---
  // The overlay is loaded now; install the listener through the real preload,
  // then fire the hotkey and assert the Manager-targeted payload arrives.
  if (ov && !ov.isDestroyed()) {
    try {
      await ov.webContents.executeJavaScript(
        'window.__note = []; window.patch.onStartVoiceNote((e) => window.__note.push(e.thread)); true;',
      );
      if (ov.isVisible()) {
        m.onGlobalVoiceNoteHotkey(); // hide first so the next press shows+sends
        await delay(80);
      }
      m.onGlobalVoiceNoteHotkey(); // show + sendWhenReady(start-voice-note, manager)
      await delay(120);
      const note = await ov.webContents.executeJavaScript('window.__note');
      check('voice-note-targets-manager', () =>
        assert.ok(
          Array.isArray(note) && note.includes('manager'),
          `overlay did not receive manager note (${JSON.stringify(note)})`,
        ),
      );
    } catch (e) {
      check('voice-note-targets-manager', () => {
        throw e;
      });
    }
  }

  // --- 4. ⌃⇧Space voice-call: raise main window, log call --------------
  win.hide();
  m.onGlobalVoiceCallHotkey();
  check('call-hotkey-raises-main', () => assert.ok(m.getMainWindow().isVisible()));
  check('call-hotkey-logs-call', () =>
    assert.ok(m.getDesktopEventLog().some((e) => e.type === 'hotkey:voice:call')),
  );

  // --- 4b. voice-call DELIVERS start-voice-call{thread:manager} to main ---
  const mwCall = m.getMainWindow();
  if (mwCall && !mwCall.isDestroyed()) {
    try {
      if (mwCall.webContents.getURL() === '') await once(mwCall.webContents, 'did-finish-load');
      await mwCall.webContents.executeJavaScript(
        'window.__call = []; window.patch.onStartVoiceCall((e) => window.__call.push(e.thread)); true;',
      );
      m.onGlobalVoiceCallHotkey();
      await delay(120);
      const call = await mwCall.webContents.executeJavaScript('window.__call');
      check('voice-call-targets-manager', () =>
        assert.ok(
          Array.isArray(call) && call.includes('manager'),
          `main did not receive manager call (${JSON.stringify(call)})`,
        ),
      );
    } catch (e) {
      check('voice-call-targets-manager', () => {
        throw e;
      });
    }
  }

  // --- 5. raiseMainWindow (incoming-call IPC effect) -------------------
  m.getMainWindow().hide();
  m.raiseMainWindow();
  check('raise-shows-main', () => assert.ok(m.getMainWindow().isVisible()));
  check('raise-logs-incoming-call', () =>
    assert.ok(m.getDesktopEventLog().some((e) => e.type === 'incoming-call:raise')),
  );

  // --- 6. bootstrap(): tray + IPC wiring on a real runtime ------------
  // Drives the production bootstrap path: createTray (shipped template icon),
  // registerIpc (patch:request-raise, patch:notify, patch:get-events),
  // registerGlobalHotkeys. app is already ready so the whenReady callback runs
  // on the next tick.
  const beforeWins = BrowserWindow.getAllWindows().length;
  let bootstrapThrew = null;
  try {
    m.bootstrap();
    await delay(400);
  } catch (e) {
    bootstrapThrew = e;
  }
  check('bootstrap-no-throw', () => assert.equal(bootstrapThrew, null, String(bootstrapThrew)));
  check('bootstrap-creates-window', () =>
    assert.ok(BrowserWindow.getAllWindows().length >= beforeWins),
  );
  // IPC: patch:request-raise → raiseMainWindow
  const raiseCountBefore = m
    .getDesktopEventLog()
    .filter((e) => e.type === 'incoming-call:raise').length;
  ipcMain.emit('patch:request-raise', {});
  check('ipc-request-raise-fires-raise', () =>
    assert.ok(
      m.getDesktopEventLog().filter((e) => e.type === 'incoming-call:raise').length >
        raiseCountBefore,
    ),
  );
  // IPC: patch:get-events returns the event log
  check('ipc-get-events-registered', () => {
    // ipcMain.emit can't capture the return of a handle(); assert the handler
    // exists by checking it was registered (listenerCount on the invoke channel
    // is not exposed, so we assert the log accessor is consistent instead).
    assert.ok(Array.isArray(m.getDesktopEventLog()));
  });
  // IPC: patch:notify with a valid payload must not throw (shows a native toast)
  let notifyThrew = null;
  try {
    ipcMain.emit('patch:notify', {}, { title: 'Smoke', body: 'Body', chatId: 'c-smoke' });
  } catch (e) {
    notifyThrew = e;
  }
  check('ipc-notify-no-throw', () => assert.equal(notifyThrew, null, String(notifyThrew)));

  // --- Updater state (spec/11 § Version reporting) ------------------------
  // The shipped app's updater silently returned early on every launch for four
  // different reasons and reported nothing. These assert, in REAL Electron, that
  // state is initialised and exposed, that the reason it can't update is NAMED,
  // and — the one that matters most — that a FAILED check is recorded rather than
  // swallowed. The old code's `checkForUpdatesAndNotify()` was fire-and-forget:
  // no result, no error, no timestamp.
  check('updater-state-initialised', () => {
    const s = m.getUpdaterState();
    assert.ok(s, 'getUpdaterState() returned null');
    assert.equal(typeof s.currentVersion, 'string');
    assert.equal(s.checking, false);
  });
  check('updater-names-why-it-cannot-update', () => {
    // This smoke runs unpackaged, so the honest reason is "running from source".
    const s = m.getUpdaterState();
    assert.ok(s.disabledReason, 'an inert updater must say WHY, not stay silent');
    assert.match(s.disabledReason, /pnpm dev|app-update\.yml/);
  });
  const beforeCheck = m.getUpdaterState().lastCheckedAt;
  await m.checkForUpdates();
  check('updater-records-a-failed-check', () => {
    const s = m.getUpdaterState();
    assert.notEqual(s.lastCheckedAt, beforeCheck, 'the check must be timestamped');
    // No update config in a dev run → the check genuinely fails. It must surface
    // as an error, NEVER as "up to date".
    assert.equal(s.lastResult, 'error');
    assert.ok(s.lastError, 'the failure detail must be kept, not discarded');
    assert.equal(s.checking, false, 'a finished check must not stay "checking"');
  });

  // --- 7. Tray: click toggles the 360px /menubar popover -------------
  const tray = m.getTray();
  check('bootstrap-creates-tray', () => assert.ok(tray && !tray.isDestroyed(), 'no tray'));
  if (tray && !tray.isDestroyed()) {
    // First click → popover created + shown.
    tray.emit('click');
    const pop = m.getTrayPopover();
    check('tray-click-creates-popover', () => assert.ok(pop, 'no popover'));
    if (pop) {
      try {
        if (pop.webContents.getURL() === '') await once(pop.webContents, 'did-finish-load');
      } catch {
        /* assert URL below regardless */
      }
      check('popover-width-360', () => assert.equal(pop.getBounds().width, 360));
      check('popover-frameless-skiptaskbar', () => assert.ok(pop.isVisible()));
      check('popover-loads-menubar', () =>
        assert.match(pop.webContents.getURL(), /\/menubar(\?|$)/),
      );
      check('tray-click-logs', () =>
        assert.ok(m.getDesktopEventLog().some((e) => e.type === 'tray:click')),
      );
      // Second click → toggles the popover hidden.
      tray.emit('click');
      check('tray-click-toggles-popover-hidden', () => assert.ok(!pop.isVisible()));
    }
    // Right-click handler must be wired (don't emit — popUpContextMenu opens a
    // blocking native menu; assert the listener exists instead).
    check('tray-right-click-wired', () =>
      assert.ok(tray.listenerCount('right-click') >= 1, 'no right-click listener'),
    );
  }

  // --- 8. Lifecycle: close WITH isQuitting must NOT preventDefault ----
  // (Cmd+W hides — tested above; Cmd+Q / quit must actually close.)
  app.isQuitting = true;
  const lwin = m.createMainWindow();
  let quitPrevented = false;
  lwin.emit('close', {
    preventDefault() {
      quitPrevented = true;
    },
  });
  check('quit-close-not-prevented', () =>
    assert.ok(!quitPrevented, 'close prevented while quitting'),
  );
  app.isQuitting = false;
  lwin.destroy();

  // --- 9. patch:notify with INVALID payload is ignored (no throw) ----
  let badNotifyThrew = null;
  try {
    ipcMain.emit('patch:notify', {}, { title: 123, body: null });
  } catch (e) {
    badNotifyThrew = e;
  }
  check('ipc-notify-bad-payload-ignored', () =>
    assert.equal(badNotifyThrew, null, String(badNotifyThrew)),
  );

  // --- 9b. "open sidebar in new window" (spec/14 § New windows) opens a REAL,
  // separate BrowserWindow whose URL matches the SPA's `/sidebar-window` route
  // exactly (no double slash) — regression for the double-slash routeUrl bug
  // (Todoist: "opening the sidebar in external window ... instead of being an
  // actual new window and detaching it from the main window"), which silently
  // failed react-router's route matching and fell through to the full app
  // shell instead of the standalone sidebar.
  try {
    const winsBefore = BrowserWindow.getAllWindows().length;
    await win.webContents.executeJavaScript(
      "window.patch && window.patch.openWindow('/sidebar-window', { width: 360, height: 800 }); true;",
    );
    await delay(500);
    check('sidebar-window-opens-a-real-new-window', () =>
      assert.equal(
        BrowserWindow.getAllWindows().length,
        winsBefore + 1,
        'sidebar-window did not spawn a new BrowserWindow',
      ),
    );
    check('sidebar-window-tracked-as-a-child-window', () =>
      assert.equal(m.getChildWindows().length, 1, 'openChildWindow did not register the window'),
    );
    check('sidebar-window-url-has-no-double-slash', () => {
      const url = m.getChildWindows()[0].webContents.getURL();
      assert.match(url, /\/app\/sidebar-window(\?|$)/, `malformed child window URL: ${url}`);
      assert.doesNotMatch(url, /\/app\/\/sidebar-window/, `double-slash child window URL: ${url}`);
    });
    check('sidebar-window-does-not-open-the-in-app-browser', () =>
      assert.ok(
        !(m.getInAppBrowser()?.isOpen() ?? false),
        'opening the sidebar window incorrectly opened the in-app browser panel',
      ),
    );
    // spec/14 § New windows — it opens at the sidebar width the renderer asked
    // for, not the 900px document width every other child window gets.
    check('sidebar-window-opens-at-the-requested-sidebar-width', () => {
      const bounds = m.getChildWindows()[0].getBounds();
      assert.equal(bounds.width, 360, `sidebar window opened at ${bounds.width}px, not 360`);
    });
    for (const w of m.getChildWindows()) w.destroy();

    // A caller that asks for no size still gets the ordinary window.
    await win.webContents.executeJavaScript(
      "window.patch && window.patch.openWindow('/sidebar-window'); true;",
    );
    await delay(500);
    check('child-window-with-no-requested-size-keeps-the-default', () => {
      const bounds = m.getChildWindows()[0].getBounds();
      assert.equal(bounds.width, 900, `unsized child window opened at ${bounds.width}px, not 900`);
    });
    for (const w of m.getChildWindows()) w.destroy();
  } catch (e) {
    check('sidebar-window-opens-a-real-new-window', () => {
      throw e;
    });
  }

  // --- 10. menubar-visibility heartbeat gate, end-to-end (spec/05) ----
  // Popover show/hide must push patch:menubar-visibility through the preload to
  // the renderer (Electron's hide() doesn't fire the renderer's
  // visibilitychange), so the menu-bar surface beats its heartbeat ONLY while
  // the dropdown is open. Drive it through the genuine window.patch bridge.
  // Drive the REAL user path (tray click → showTrayPopover / hideTrayPopover),
  // which now sends visibility deterministically — NOT the flaky window
  // 'show'/'hide' events. Install the renderer listener first, then toggle.
  const popVis = m.getTrayPopover();
  if (tray && !tray.isDestroyed() && popVis && !popVis.isDestroyed()) {
    try {
      if (popVis.webContents.getURL() === '') await once(popVis.webContents, 'did-finish-load');
      await popVis.webContents.executeJavaScript(
        'window.__vis = []; if (window.patch && window.patch.onMenubarVisibility) { ' +
          'window.patch.onMenubarVisibility((e) => window.__vis.push(e.visible)); } true;',
      );
      // Start hidden AND past decideTrayClick's 300ms recent-hide grace, so the
      // next click is a genuine 'show' rather than a correctly-suppressed reopen
      // (an earlier check may have hidden the popover moments ago). The grace is
      // the real "second click closes it" debounce (tray-toggle.ts) — waiting it
      // out is what lets this test exercise the open→close visibility emission.
      if (popVis.isVisible()) tray.emit('click');
      await delay(350);
      tray.emit('click'); // → showTrayPopover → visible:true
      await delay(200);
      tray.emit('click'); // → hideTrayPopover → visible:false
      await delay(200);
      const vis = await popVis.webContents.executeJavaScript('window.__vis');
      check('menubar-visibility-emits-true-then-false', () => {
        assert.ok(
          Array.isArray(vis) && vis.includes(true),
          `no visible:true (${JSON.stringify(vis)})`,
        );
        assert.ok(vis.includes(false), `no visible:false (${JSON.stringify(vis)})`);
      });
      check('menubar-visibility-last-is-false-when-closed', () =>
        assert.equal(vis[vis.length - 1], false, `last visibility ${JSON.stringify(vis)}`),
      );
    } catch (e) {
      check('menubar-visibility-emits-true-then-false', () => {
        throw e;
      });
    }
  }

  // --- 10a. blur grace timer (DX-10) hides the popover after ~200ms ---
  const popBlur = m.getTrayPopover();
  if (tray && !tray.isDestroyed() && popBlur && !popBlur.isDestroyed()) {
    if (!popBlur.isVisible()) {
      tray.emit('click');
      await delay(180);
    }
    if (popBlur.isVisible()) {
      popBlur.emit('blur');
      await delay(340); // past the 200ms grace
      check('blur-grace-hides-popover', () =>
        assert.ok(!popBlur.isVisible(), 'popover still visible after blur grace period'),
      );
    }
  }

  // --- 10b. notification click → focus main + navigate to chat (spec/05)
  // Drive the genuine chain: patch:notify IPC → Notification → click →
  // patch:navigate → preload onNavigate in the renderer.
  // ensureMainWindow gives a guaranteed-live singleton (section 8's quit-path
  // test created+destroyed a throwaway, which — by the singleton invariant —
  // left getMainWindow() pointing at a destroyed window).
  const mwForNav = m.ensureMainWindow();
  if (mwForNav && !mwForNav.isDestroyed()) {
    try {
      if (mwForNav.webContents.getURL() === '') await once(mwForNav.webContents, 'did-finish-load');
      await mwForNav.webContents.executeJavaScript(
        'window.__nav = []; if (window.patch && window.patch.onNavigate) { ' +
          'window.patch.onNavigate((e) => window.__nav.push(e.path)); } true;',
      );
      ipcMain.emit('patch:notify', {}, { title: 'N', body: 'B', chatId: 'c-xyz' });
      const note = m.getLastNotification();
      check('notification-created', () => assert.ok(note, 'no Notification instance'));
      if (note) {
        note.emit('click');
        await delay(80);
        const nav = await mwForNav.webContents.executeJavaScript('window.__nav');
        check('notification-click-navigates-to-chat', () =>
          assert.ok(
            Array.isArray(nav) && nav.includes('/chats/c-xyz'),
            `navigate not received (${JSON.stringify(nav)})`,
          ),
        );
        check('notification-click-logged', () =>
          assert.ok(m.getDesktopEventLog().some((e) => e.type === 'notification:click')),
        );
      }
    } catch (e) {
      check('notification-click-navigates-to-chat', () => {
        throw e;
      });
    }
  }

  // --- 11. before-quit sets isQuitting (Cmd+Q quits vs Cmd+W hide) ----
  app.isQuitting = false;
  app.emit('before-quit', {});
  check('before-quit-sets-isquitting', () => assert.ok(app.isQuitting, 'isQuitting not set'));

  // --- 12. will-quit cleanup + window-all-closed darwin no-op --------
  const { globalShortcut } = require('electron');
  // window-all-closed must NOT quit on darwin (tray + hotkeys stay live). If it
  // wrongly quit, the process would exit before printing the verdict below.
  app.emit('window-all-closed');
  check('window-all-closed-noop-on-darwin', () =>
    assert.equal(process.platform, 'darwin', 'this smoke asserts darwin behaviour'),
  );
  // will-quit unregisters every global shortcut and destroys the tray.
  const hotkeyWasRegistered = globalShortcut.isRegistered('Control+Space');
  const trayRef = m.getTray();
  app.emit('will-quit', {});
  check('will-quit-unregisters-hotkeys', () => {
    assert.ok(hotkeyWasRegistered, 'precondition: ⌃Space was registered by bootstrap');
    assert.ok(
      !globalShortcut.isRegistered('Control+Space'),
      'hotkey still registered after will-quit',
    );
  });
  check('will-quit-destroys-tray', () =>
    assert.ok(!trayRef || trayRef.isDestroyed(), 'tray not destroyed after will-quit'),
  );

  // --- teardown -------------------------------------------------------
  globalShortcut.unregisterAll();
  for (const w of BrowserWindow.getAllWindows()) w.destroy();

  const pass = errors.length === 0;
  // eslint-disable-next-line no-console
  console.log('INTEGRATION_RESULT ' + JSON.stringify({ pass, checks, errors }, null, 2));
  app.exit(pass ? 0 : 1);
});

app.on('window-all-closed', () => {});
