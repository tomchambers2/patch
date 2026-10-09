// Real-Electron E2E for the overlay title bar's DRAG REGIONS — spec/05 §
// Desktop packaging (Electron) → Window chrome, spec/14 § Layout — desktop.
//
// On a window with no title bar the top chrome rows are `-webkit-app-region:
// drag`, with their controls punched back out as `no-drag`. Whether a click at
// a point reaches the page or starts a window move is decided NATIVELY, before
// the renderer ever sees the event — so neither a browser test nor
// `webContents.sendInputEvent` (which is delivered straight to the renderer)
// can observe it. Only a real OS-level click can.
//
// Electron folds the page's regions together IN DOCUMENT ORDER: a `drag` rect
// is unioned in, a `no-drag` rect subtracted, each overwriting what came before.
// A `no-drag` control that sits EARLIER in the DOM than a `drag` row painted
// over the same pixels is therefore swallowed by it, whatever its z-index and
// whatever `elementFromPoint` says. That is how the collapsed sidebar's expand
// chevron went dead while every browser test of it passed (Tom, Todoist:
// "patch expand sidebar doesnt work").
//
// So this opens the web dev harness in a frameless window — the Linux
// equivalent of the macOS hidden title bar: the same drag regions, folded by
// the same code — and clicks with XTest, which goes through the window
// system exactly as a mouse does.
//
// Linux only, under Xvfb: `xvfb-run -a electron scripts/smoke-drag-regions.cjs`
// (the `smoke:drag-regions` script). Needs python3 and libXtst. Starts its own
// vite dev server for packages/web on a free port.
// Prints `DRAG_REGIONS_RESULT <json>`; exit 0 = every check passed.

const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const WEB_DIR = path.resolve(__dirname, '../../web');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'linux' || !process.env.DISPLAY) {
  console.error('smoke-drag-regions: needs Linux with an X display — run it under xvfb-run -a');
  process.exit(2);
}

/** A real left click at screen (x, y), through the X server like a mouse. */
function osClick(x, y) {
  execFileSync('python3', [
    '-c',
    `import ctypes, time
X = ctypes.cdll.LoadLibrary('libX11.so.6'); T = ctypes.cdll.LoadLibrary('libXtst.so.6')
X.XOpenDisplay.restype = ctypes.c_void_p
d = ctypes.c_void_p(X.XOpenDisplay(None))
T.XTestFakeMotionEvent(d, -1, ${x}, ${y}, 0); X.XFlush(d); time.sleep(0.15)
T.XTestFakeButtonEvent(d, 1, 1, 0); X.XFlush(d); time.sleep(0.05)
T.XTestFakeButtonEvent(d, 1, 0, 0); X.XFlush(d); time.sleep(0.15)`,
  ]);
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await delay(300);
  }
  throw new Error(`dev server never answered at ${url}`);
}

const checks = {};
const errors = [];
async function check(name, fn) {
  try {
    await fn();
    checks[name] = true;
  } catch (e) {
    checks[name] = false;
    errors.push(`${name}: ${e.message}`);
  }
}

const ROUTES = ['/chats/chat_bus', '/chats/new', '/jobs', '/settings'];

async function main() {
  const port = await freePort();
  const vite = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: WEB_DIR,
      stdio: 'ignore',
      detached: true,
    },
  );
  const stopVite = () => {
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', stopVite);
  const base = `http://127.0.0.1:${port}/app/dev-harness.html`;
  await waitForHttp(base, 60000);

  await app.whenReady();
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'smoke-drag-regions.preload.cjs'),
      contextIsolation: false,
      sandbox: false,
    },
  });
  const js = (s) => win.webContents.executeJavaScript(s, true);

  async function open(route, sidebarHidden) {
    const url = `${base}?chat=chat_bus&route=${encodeURIComponent(route)}${sidebarHidden ? '&sidebar=hidden' : ''}`;
    await win.loadURL(url);
    for (let i = 0; i < 50; i++) {
      if (await js(`!!document.querySelector('.three-col')`)) break;
      await delay(200);
    }
    await delay(800);
  }

  /** Screen point at the centre of the first element matching `sel`. */
  async function centreOf(sel) {
    const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null; const b = e.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!r) return null;
    const c = win.getContentBounds();
    return { x: c.x + r.x, y: c.y + r.y };
  }

  for (const route of ROUTES) {
    await open(route, true);
    await check(`${route}: harness booted as an overlay-titlebar window`, async () => {
      assert.equal(await js(`!!document.querySelector('.overlay-titlebar')`), true);
    });
    await check(`${route}: a real click on the expand chevron restores the sidebar`, async () => {
      const p = await centreOf('[data-testid=sidebar-expand]');
      assert.ok(p, 'no expand chevron on a collapsed shell');
      osClick(p.x, p.y);
      await delay(600);
      assert.equal(
        await js(`document.querySelectorAll('[data-testid=sidebar]').length`),
        1,
        'the click never reached the chevron — the drag region took it',
      );
    });
  }

  // Control: the same kind of click on the sidebar's own collapse chevron,
  // which lives inside the brand row's drag region and is punched out of it.
  await open('/chats/chat_bus', false);
  await check('collapse chevron in the brand row takes a real click', async () => {
    const p = await centreOf('[data-testid=sidebar-collapse]');
    assert.ok(p, 'no collapse chevron');
    osClick(p.x, p.y);
    await delay(600);
    assert.equal(await js(`document.querySelectorAll('[data-testid=sidebar]').length`), 0);
  });

  const ok = errors.length === 0;
  console.log(`DRAG_REGIONS_RESULT ${JSON.stringify({ ok, checks, errors })}`);
  stopVite();
  app.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
