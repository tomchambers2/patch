// Real-Electron INTEGRATION smoke for the in-app browser (spec/14 § Links and
// the web panel). Drives the ACTUAL exports of dist/main.js under a live
// Electron runtime — createMainWindow, openInAppBrowser, getInAppBrowser — and
// asserts genuine side effects on real WebContentsViews attached to the main
// window, plus the IPC channels the toolbar buttons use.
//
// The panel's CONTROLS live here (geometry, toolbar bridge, pop-out, teardown).
// Which gesture chooses which destination is smoke-link-choice.cjs, which clicks
// real links with real input events.
//
// Usage: electron scripts/smoke-in-app-browser.cjs
// Prints `IAB_RESULT <json>`; exit 0 = all checks passed.

const assert = require('node:assert/strict');
const { app, ipcMain } = require('electron');

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

// Stub shell.openExternal BEFORE any handler can fire: some checks below assert
// a page was handed to the real browser, and others that it was NOT.
const electron = require('electron');
const externalOpens = [];
electron.shell.openExternal = (url) => {
  externalOpens.push(url);
  return Promise.resolve();
};

app.whenReady().then(async () => {
  const m = require('../dist/main.js');
  const { TOOLBAR_HEIGHT, panelWidthFor, PANEL_WIDTH_FRACTION, PANEL_MAX_FRACTION } = require('../dist/in-app-browser.js');

  // Register the production IPC wiring (patch:iab:* toolbar channels live in
  // registerIpc, invoked by bootstrap) so the toolbar-button emits below drive
  // the real handlers, not a dead channel.
  m.bootstrap();
  await delay(400);

  const win = m.createMainWindow();
  try {
    await once(win.webContents, 'did-finish-load');
  } catch {
    /* proceed — routing/controller checks don't need the SPA loaded */
  }

  // --- 1. window.open(external) is the "somewhere else" gesture: it goes to
  // the user's REAL browser, and must NOT hijack the panel ----------------
  check('iab-initially-closed', () => {
    const iab = m.getInAppBrowser();
    assert.ok(!iab || !iab.isOpen(), 'in-app browser open before any link');
  });
  await win.webContents.executeJavaScript('window.open("https://example.com/iab-window"); true;');
  await delay(300);
  check('window-open-goes-to-the-real-browser', () =>
    assert.ok(
      externalOpens.some((u) => /example\.com\/iab-window/.test(u)),
      `window.open did not reach the real browser: ${JSON.stringify(externalOpens)}`,
    ),
  );
  check('window-open-does-not-open-the-panel', () => {
    const iab = m.getInAppBrowser();
    assert.ok(!iab || !iab.isOpen(), 'window.open opened the embedded panel');
  });

  // Everything below is about the panel's own controls, so open it the way
  // Patch itself does (an artifact, a preview) and exercise it.
  m.openInAppBrowser(win, 'https://example.com/iab-window');
  await delay(300);
  check('patch-opened-page-shows-in-the-panel', () => {
    const iab = m.getInAppBrowser();
    assert.ok(iab, 'no in-app browser controller');
    assert.ok(iab.isOpen(), 'panel did not open');
    assert.match(iab.currentUrl(), /example\.com\/iab-window/);
  });

  // --- 2. the page + toolbar views are attached to the main window -------
  check('page-and-toolbar-views-exist', () => {
    const iab = m.getInAppBrowser();
    assert.ok(iab.getPageView(), 'no page WebContentsView');
    assert.ok(iab.getToolbarView(), 'no toolbar WebContentsView');
  });
  // It is a SIDE panel docked to the right, not a full-window takeover
  // (spec/14 § Links and the web panel) — the Patch UI keeps the rest of the
  // width, which is what lets the user read the chat the link came from.
  check('page-view-sits-below-the-toolbar-strip', () => {
    const iab = m.getInAppBrowser();
    const page = iab.getPageView().getBounds();
    const toolbar = iab.getToolbarView().getBounds();
    assert.equal(toolbar.y, 0, `toolbar not pinned to top (y=${toolbar.y})`);
    assert.equal(toolbar.height, TOOLBAR_HEIGHT, `toolbar height ${toolbar.height}`);
    assert.equal(page.y, TOOLBAR_HEIGHT, `page not below toolbar (y=${page.y})`);
    const content = win.getContentBounds();
    const expected = panelWidthFor(content.width);
    assert.equal(page.width, expected, `page width ${page.width} != panel width ${expected}`);
    assert.ok(page.width < content.width, 'the panel took the whole window width');
    assert.equal(page.x, content.width - expected, `panel not docked right (x=${page.x})`);
    assert.equal(toolbar.x, page.x, 'toolbar not aligned with the page column');
  });

  // --- 3. the toolbar preload bridge (window.iab) materialises -----------
  try {
    const tb = m.getInAppBrowser().getToolbarView().webContents;
    if (tb.isLoading()) await once(tb, 'did-finish-load');
    const keys = await tb.executeJavaScript('window.iab ? Object.keys(window.iab) : null');
    check('toolbar-exposes-iab-bridge', () => {
      assert.ok(keys, 'window.iab undefined in toolbar');
      for (const k of ['back', 'forward', 'reload', 'close', 'openExternal', 'onState'])
        assert.ok(keys.includes(k), `iab bridge missing ${k}`);
    });
  } catch (e) {
    check('toolbar-exposes-iab-bridge', () => {
      throw e;
    });
  }

  // --- 4. resizing the window re-lays-out the page view ------------------
  check('resize-relayouts-page-view', () => {
    const iab = m.getInAppBrowser();
    win.setContentSize(900, 700);
    win.emit('resize');
    const page = iab.getPageView().getBounds();
    const expected = panelWidthFor(900);
    assert.equal(page.width, expected, `page width did not track resize (${page.width})`);
    assert.equal(page.x, 900 - expected, `panel not re-docked right (x=${page.x})`);
    assert.equal(page.y, TOOLBAR_HEIGHT);
  });

  // --- 4b. the divider drag (spec/14 § Links and the web panel) ----------
  // `patch:panel:resize` is what a live pointermove sends; it must move the
  // REAL views immediately (not just echo the inset), and the SHARE it leaves
  // behind must survive an unrelated window resize rather than being
  // recomputed off the default fraction.
  check('drag-resizes-the-real-views-live', () => {
    const iab = m.getInAppBrowser();
    const { width } = win.getContentBounds();
    const target = Math.round(width * 0.6);
    ipcMain.emit('patch:panel:resize', {}, { width: target });
    const page = iab.getPageView().getBounds();
    assert.equal(page.width, target, `page width ${page.width} did not follow the drag to ${target}`);
    assert.equal(iab.getToolbarView().getBounds().width, target, 'toolbar did not follow the drag');
  });
  check('dragged-share-survives-a-window-resize', () => {
    const iab = m.getInAppBrowser();
    win.setContentSize(1000, 700);
    win.emit('resize');
    const page = iab.getPageView().getBounds();
    // ~60% of the NEW width, not the default fraction and not the old pixel width.
    assert.equal(page.width, Math.round(1000 * 0.6), `share did not survive resize (${page.width})`);
  });
  check('drag-past-the-max-fraction-is-clamped', () => {
    const iab = m.getInAppBrowser();
    const { width } = win.getContentBounds();
    ipcMain.emit('patch:panel:resize', {}, { width: width }); // the whole window
    const page = iab.getPageView().getBounds();
    const expected = Math.round(width * PANEL_MAX_FRACTION);
    assert.equal(page.width, expected, `drag past the ceiling was not clamped (${page.width})`);
  });
  check('double-click-reset-ipc-restores-the-default-share', () => {
    const iab = m.getInAppBrowser();
    ipcMain.emit('patch:panel:reset-width');
    const { width } = win.getContentBounds();
    const page = iab.getPageView().getBounds();
    assert.equal(page.width, panelWidthFor(width, PANEL_WIDTH_FRACTION), 'reset did not restore the default share');
  });

  // --- 5. opening another link reuses the SAME panel (no stacking) -------
  check('second-link-navigates-same-panel', () => {
    const iab = m.getInAppBrowser();
    const page1 = iab.getPageView();
    m.openInAppBrowser(win, 'https://example.org/second');
    assert.equal(iab.getPageView(), page1, 'a second link created a new panel');
    assert.match(iab.currentUrl(), /example\.org\/second/);
  });

  // --- 6. toolbar "open in browser" IPC pops out + closes the panel ------
  const beforeExt = externalOpens.length;
  ipcMain.emit('patch:iab:open-external');
  await delay(100);
  check('open-external-ipc-pops-to-real-browser', () =>
    assert.ok(
      externalOpens.slice(beforeExt).some((u) => /example\.org\/second/.test(u)),
      `open-external did not call shell.openExternal (${JSON.stringify(externalOpens)})`,
    ),
  );
  check('open-external-closes-the-panel', () =>
    assert.ok(!m.getInAppBrowser().isOpen(), 'panel still open after open-external'),
  );

  // --- 7. close IPC tears the panel down --------------------------------
  m.openInAppBrowser(win, 'https://example.com/again');
  check('reopen-after-close', () => assert.ok(m.getInAppBrowser().isOpen()));
  ipcMain.emit('patch:iab:close');
  await delay(100);
  check('close-ipc-tears-down-panel', () => assert.ok(!m.getInAppBrowser().isOpen()));

  // --- 8. a plain in-place navigation (will-navigate) stays in-app -------
  // A clicked <a href> (no target) navigates the main webContents in place; the
  // guard must keep the SPA put and open the URL in the panel. (The real-click
  // version of this, with modifiers, is smoke-link-choice.cjs.)
  const beforeUrl = win.webContents.getURL();
  const beforeOpens2 = externalOpens.length;
  await win.webContents.executeJavaScript(
    'window.location.assign("https://example.net/inplace"); true;',
  );
  await delay(400);
  check('will-navigate-keeps-spa-put', () =>
    assert.ok(
      win.webContents.getURL().includes('patch.tomchambers.me/app/'),
      `SPA navigated away to ${win.webContents.getURL()}`,
    ),
  );
  check('will-navigate-opens-in-app-browser', () => {
    const iab = m.getInAppBrowser();
    assert.ok(iab.isOpen(), 'in-place nav did not open the in-app browser');
    assert.match(iab.currentUrl(), /example\.net\/inplace/);
  });
  check('will-navigate-not-sent-to-real-browser', () =>
    assert.equal(
      externalOpens.length,
      beforeOpens2,
      `in-place nav leaked to the real browser (${JSON.stringify(externalOpens)})`,
    ),
  );
  void beforeUrl;

  // --- 9. the panel FOLLOWS the window a link was clicked in -------------
  // One panel app-wide (the toolbar IPC channels are global), so a link clicked
  // in a detached chat/sidebar window moves it rather than opening a second —
  // and the window it left must get its full width back, not keep a dead gap.
  const child = m.openChildWindow('/');
  m.openInAppBrowser(child, 'https://example.com/in-the-child');
  await delay(300);
  check('panel-moves-to-the-window-the-link-was-clicked-in', () => {
    const iab = m.getInAppBrowser();
    assert.ok(iab.isOpen(), 'panel not open after a link in the child window');
    assert.equal(iab.parentWindow(), child, 'panel stayed bound to the old window');
    assert.match(iab.currentUrl(), /example\.com\/in-the-child/);
  });
  check('only-one-panel-exists-across-windows', () => {
    // The views the panel left behind must be detached from the old window.
    const iab = m.getInAppBrowser();
    assert.ok(
      !win.contentView.children.includes(iab.getPageView()),
      'the panel page view is still attached to the previous window',
    );
  });
  child.destroy();

  // --- teardown ---------------------------------------------------------
  const { BrowserWindow } = require('electron');
  for (const w of BrowserWindow.getAllWindows()) w.destroy();

  const pass = errors.length === 0;
  // eslint-disable-next-line no-console
  console.log('IAB_RESULT ' + JSON.stringify({ pass, checks, errors }, null, 2));
  app.exit(pass ? 0 : 1);
});

app.on('window-all-closed', () => {});
