// Real-Electron E2E for the LINK CHOICE — spec/14 § Links and the web panel.
//
// The feature is "a link opens in Patch OR in the real browser, and the gesture
// is the choice", and the only honest way to test it is a REAL trusted click:
// Chromium — not Patch — decides whether a modified click arrives as a
// navigation (`will-navigate`) or as a new-window request
// (`setWindowOpenHandler`), and a synthetic JS `click()` routes differently from
// a real one. So this boots the production main.js, serves a real page with real
// anchors over real HTTP, and clicks them with `sendInputEvent`.
//
// Usage: electron scripts/smoke-link-choice.cjs
// Prints `LINK_CHOICE_RESULT <json>`; exit 0 = all checks passed.

const assert = require('node:assert/strict');
const http = require('node:http');

// --- the page under test ------------------------------------------------
// Big, well-separated hit targets so a click lands where we think it does.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; font: 16px sans-serif; }
  a { display: block; height: 80px; line-height: 80px; padding: 0 20px; }
</style>
<a id="ext" href="https://example.com/plain-click">plain</a>
<a id="ext2" href="https://example.org/modified-click">modified</a>
<a id="ext3" href="https://example.net/shift-click">shift</a>
<a id="bad" href="file:///etc/passwd">bad scheme</a>
<a id="same" href="/elsewhere">same origin</a>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/elsewhere' ? '<!doctype html><title>elsewhere</title>elsewhere' : PAGE);
});

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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, '127.0.0.1', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.PATCH_SERVER_URL = `${origin}/`;

  const { app, shell, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();

  // Record instead of launching a real browser — the point of half these checks
  // is WHETHER this gets called.
  const externalOpens = [];
  shell.openExternal = (url) => {
    externalOpens.push(url);
    return Promise.resolve();
  };

  await app.whenReady();
  const m = require('../dist/main.js');
  m.bootstrap();
  const win = m.createMainWindow();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('page load timeout')), 20000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t);
      resolve();
    });
  });

  /** Click the centre of `#id` with a REAL input event (trusted, like a user). */
  async function clickLink(id, modifiers = []) {
    const rect = await win.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('${id}').getBoundingClientRect();
         return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    for (const type of ['mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({
        type,
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1,
        modifiers,
      });
    }
    await delay(600);
  }

  const panel = () => m.getInAppBrowser();
  // Chromium's "open in a new tab" modifier is platform-specific; Patch's
  // policy follows whatever Chromium calls a new-window request.
  const NEW_TAB = process.platform === 'darwin' ? ['meta'] : ['control'];

  // --- 1. a PLAIN click keeps the page in Patch ---------------------------
  check('panel-closed-before-any-click', () =>
    assert.ok(!panel() || !panel().isOpen(), 'panel open before any link was clicked'),
  );
  await clickLink('ext');
  check('plain-click-opens-the-patch-panel', () => {
    assert.ok(panel(), 'no panel controller after a plain click');
    assert.ok(panel().isOpen(), 'plain click did not open the panel');
    assert.match(panel().currentUrl(), /example\.com\/plain-click/);
  });
  check('plain-click-does-not-reach-the-real-browser', () =>
    assert.deepEqual(externalOpens, [], `leaked to the real browser: ${externalOpens}`),
  );
  check('plain-click-leaves-the-spa-where-it-was', () =>
    assert.ok(
      win.webContents.getURL().startsWith(origin),
      `SPA navigated away to ${win.webContents.getURL()}`,
    ),
  );

  // --- 2. a ⌘/Ctrl-click goes to the REAL browser instead ----------------
  const panelUrlBefore = panel().currentUrl();
  await clickLink('ext2', NEW_TAB);
  check('modified-click-opens-the-real-browser', () =>
    assert.ok(
      externalOpens.some((u) => /example\.org\/modified-click/.test(u)),
      `modified click did not reach the real browser: ${JSON.stringify(externalOpens)}`,
    ),
  );
  check('modified-click-does-not-touch-the-panel', () =>
    assert.equal(
      panel().currentUrl(),
      panelUrlBefore,
      'a modified click hijacked the panel instead of leaving for the browser',
    ),
  );

  // --- 3. a shift-click on an EXTERNAL link also leaves ------------------
  await clickLink('ext3', ['shift']);
  check('shift-click-on-an-external-link-opens-the-real-browser', () =>
    assert.ok(
      externalOpens.some((u) => /example\.net\/shift-click/.test(u)),
      `shift-click did not reach the real browser: ${JSON.stringify(externalOpens)}`,
    ),
  );

  // --- 4. a non-http(s) scheme is refused on BOTH routes ----------------
  const externalCount = externalOpens.length;
  const panelUrlBeforeBad = panel().currentUrl();
  await clickLink('bad');
  await clickLink('bad', NEW_TAB);
  check('a-file-url-is-refused-not-loaded', () => {
    assert.equal(externalOpens.length, externalCount, `file: URL sent to the browser`);
    assert.equal(panel().currentUrl(), panelUrlBeforeBad, 'file: URL loaded into the panel');
    assert.ok(win.webContents.getURL().startsWith(origin), 'SPA followed a file: URL');
  });

  // --- 5. a same-origin plain click is still an ordinary in-app route ----
  // Last: this one is SUPPOSED to navigate the window away from the test page.
  await clickLink('same');
  await delay(600);
  check('same-origin-click-navigates-the-app-itself', () => {
    assert.ok(
      win.webContents.getURL().startsWith(`${origin}/elsewhere`),
      `same-origin click did not route in-app (at ${win.webContents.getURL()})`,
    );
    assert.equal(panel().currentUrl(), panelUrlBeforeBad, 'same-origin click opened the panel');
  });

  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  server.close();
  const pass = errors.length === 0;
  // eslint-disable-next-line no-console
  console.log('LINK_CHOICE_RESULT ' + JSON.stringify({ pass, checks, errors }, null, 2));
  app.exit(pass ? 0 : 1);
});

require('electron').app.on('window-all-closed', () => {});
