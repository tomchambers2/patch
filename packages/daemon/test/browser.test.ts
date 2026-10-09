// Agent browser (spec/02 § Browser, spec/06 § Browser tools) — step 1 of 3.
// Drives a REAL Chromium under a real Xvfb virtual display against a tiny
// local fixture server: a login (cookie-based session), a multi-step form,
// and a file upload. Not mocked — a mocked Playwright would prove nothing
// about the thing this module actually promises (real input events, a real
// persistent profile, a real "no automation" fingerprint).

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  BrowserManager,
  BrowserNotInstalledError,
  RefNotFoundError,
  RoutingHostOfflineError,
  TabNotFoundError,
} from '../src/browser.js';
import { BrowserTunnelClient, BrowserTunnelRelay } from '../src/browser-tunnel.js';

const silent = pino({ level: 'silent' });

/**
 * A GET-only fixture site — no body parsing needed, every "submit" is just a
 * link/form navigating with query params:
 *   /login            — username/password form
 *   /login/submit     — checks the password, sets a session cookie, redirects
 *   /account          — "Welcome back" iff the session cookie is present
 *   /form/step1..3    — a 3-step form, each step carrying the prior answers
 *   /form/done        — final confirmation page
 *   /upload           — a file input that echoes the chosen filename
 */
function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local');
      const q = url.searchParams;
      const cookie = req.headers.cookie ?? '';
      const html = (body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>${body}</body></html>`);
      };

      if (url.pathname === '/login') {
        html(`
          <h1>Log in</h1>
          <form method="GET" action="/login/submit">
            <input type="text" aria-label="Username" name="user" />
            <input type="password" aria-label="Password" name="pass" />
            <button type="submit">Log in</button>
          </form>
        `);
        return;
      }
      if (url.pathname === '/login/submit') {
        if (q.get('pass') === 'secret123') {
          res.writeHead(302, {
            // Max-Age makes this a PERSISTENT cookie. A session cookie (no
            // Max-Age/Expires) is exactly what Chromium does NOT write to a
            // profile's disk store — real "stays logged in" sites always set
            // one of these, which is the behaviour worth proving here.
            'set-cookie': 'session=abc123; Path=/; Max-Age=3600',
            location: '/account',
          });
          res.end();
        } else {
          html('<p role="alert">wrong password</p>');
        }
        return;
      }
      if (url.pathname === '/account') {
        if (cookie.includes('session=abc123')) {
          html('<h1 role="status">Welcome back</h1>');
        } else {
          html('<h1 role="status">please log in</h1>');
        }
        return;
      }
      if (url.pathname === '/form/step1') {
        html(`
          <h1>Step 1</h1>
          <form method="GET" action="/form/step2">
            <input type="text" aria-label="Full name" name="name" />
            <button type="submit">Next</button>
          </form>
        `);
        return;
      }
      if (url.pathname === '/form/step2') {
        const name = q.get('name') ?? '';
        html(`
          <h1>Step 2</h1>
          <form method="GET" action="/form/step3">
            <input type="hidden" name="name" value="${name}" />
            <select aria-label="Country" name="country">
              <option value="uk">UK</option>
              <option value="us">US</option>
            </select>
            <input type="checkbox" aria-label="Subscribe" name="subscribe" value="yes" />
            <button type="submit">Next</button>
          </form>
        `);
        return;
      }
      if (url.pathname === '/form/step3') {
        const name = q.get('name') ?? '';
        const country = q.get('country') ?? '';
        const subscribe = q.get('subscribe') ?? '';
        html(`
          <h1>Review</h1>
          <p>${name} / ${country} / ${subscribe || 'no'}</p>
          <a href="/form/done?name=${encodeURIComponent(name)}&country=${encodeURIComponent(country)}&subscribe=${encodeURIComponent(subscribe)}">Submit</a>
        `);
        return;
      }
      if (url.pathname === '/form/done') {
        html(
          `<h1 role="status">Thanks ${q.get('name')} (${q.get('country')}, subscribed=${q.get('subscribe') ? 'yes' : 'no'})</h1>`,
        );
        return;
      }
      if (url.pathname === '/whoami') {
        // The "exit IP" check: whichever socket actually reached this
        // server, surfaced in the page so a test can read it back.
        html(`<h1 role="status" id="addr">${req.socket.remoteAddress}</h1>`);
        return;
      }
      if (url.pathname === '/pointer') {
        // Coordinate-driven surface: a 100x100 box at (200,150) that logs
        // every mouse event it sees, plus a tall page and a focused field.
        html(`
          <style>body{margin:0;height:3000px}#box{position:absolute;left:200px;top:150px;width:100px;height:100px;background:#09f}</style>
          <div id="box"></div><input id="field" style="position:fixed;left:400px;top:10px" autofocus />
          <pre id="log" style="position:fixed;left:10px;top:400px"></pre>
          <script>
            const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
            const box = document.getElementById('box');
            for (const t of ['click','dblclick','contextmenu','mouseenter']) box.addEventListener(t, () => log(t));
            box.addEventListener('mousedown', () => log('down'));
            document.addEventListener('mouseup', (e) => log('up@' + e.clientX + ',' + e.clientY));
            document.addEventListener('scroll', () => log('scrollY=' + Math.round(scrollY)));
          </script>`);
        return;
      }
      if (url.pathname === '/webdriver') {
        html(
          '<h1 role="status" id="wd"></h1><script>document.getElementById("wd").textContent = String(navigator.webdriver);</script>',
        );
        return;
      }
      if (url.pathname === '/upload') {
        html(`
          <input type="file" aria-label="Attachment" id="f" />
          <span id="uploaded-name" role="status"></span>
          <script>
            document.getElementById('f').addEventListener('change', function () {
              document.getElementById('uploaded-name').textContent = this.files[0] ? this.files[0].name : '';
            });
          </script>
        `);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function textOf(snapshot: { role: string; name: string }[], name: string): string | undefined {
  return snapshot.find((n) => n.name === name)?.name;
}

function refFor(
  snapshot: { ref: string; name: string; tag: string; role: string }[],
  predicate: (n: { ref: string; name: string; tag: string; role: string }) => boolean,
): string {
  const node = snapshot.find(predicate);
  if (!node)
    throw new Error(`fixture: no matching element in snapshot: ${JSON.stringify(snapshot)}`);
  return node.ref;
}

describe('BrowserManager — real Chromium against a local fixture server', () => {
  let fixture: { server: Server; baseUrl: string } | undefined;
  let managers: BrowserManager[] = [];
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const m of managers) await m.dispose();
    managers = [];
    if (fixture) {
      const server = fixture.server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fixture = undefined;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  function newManager(virtualDisplay: string): BrowserManager {
    const root = mkdtempSync(join(tmpdir(), 'patch-browser-'));
    tmpDirs.push(root);
    const m = new BrowserManager({ root, logger: silent, virtualDisplay });
    managers.push(m);
    return m;
  }

  it('opens a page and reads its snapshot', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':91');
    const { tabId, title } = await manager.open({ url: `${fixture.baseUrl}/form/step1` });
    expect(title).toBe('');
    const { snapshot } = await manager.read(tabId);
    expect(textOf(snapshot, 'Full name')).toBe('Full name');
  }, 30_000);

  it('honest by design: navigator.webdriver reads undefined, same as a human-driven Chrome', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':90');
    const { tabId } = await manager.open({ url: `${fixture.baseUrl}/webdriver` });
    const { snapshot } = await manager.read(tabId);
    expect(snapshot.find((n) => n.role === 'status')?.name).toBe('undefined');
  }, 30_000);

  it('drives a real multi-step form end-to-end with real clicks and keystrokes', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':92');
    const { tabId } = await manager.open({ url: `${fixture.baseUrl}/form/step1` });

    let snap = (await manager.read(tabId)).snapshot;
    await manager.type(
      tabId,
      refFor(snap, (n) => n.name === 'Full name'),
      'Ada Lovelace',
    );
    await manager.click(
      tabId,
      refFor(snap, (n) => n.tag === 'button'),
    );

    snap = (await manager.read(tabId)).snapshot;
    await manager.fillForm(tabId, [
      { ref: refFor(snap, (n) => n.tag === 'select'), value: 'uk' },
      { ref: refFor(snap, (n) => n.name === 'Subscribe'), value: 'true' },
    ]);
    await manager.click(
      tabId,
      refFor(snap, (n) => n.tag === 'button'),
    );

    snap = (await manager.read(tabId)).snapshot;
    await manager.click(
      tabId,
      refFor(snap, (n) => n.tag === 'a'),
    );

    const final = await manager.read(tabId);
    const thanks = final.snapshot.find((n) => n.role === 'status');
    expect(thanks?.name).toContain('Ada Lovelace');
    expect(thanks?.name).toContain('uk');
    expect(thanks?.name).toContain('subscribed=yes');
  }, 30_000);

  it('uploads a real local file and the page observes its name', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':93');
    const uploadDir = mkdtempSync(join(tmpdir(), 'patch-browser-upload-'));
    tmpDirs.push(uploadDir);
    const filePath = join(uploadDir, 'hello.txt');
    writeFileSync(filePath, 'hello from a test');

    const { tabId } = await manager.open({ url: `${fixture.baseUrl}/upload` });
    const snap = (await manager.read(tabId)).snapshot;
    const fileRef = refFor(snap, (n) => n.type === 'file');
    await manager.upload(tabId, fileRef, [filePath]);

    await new Promise((r) => setTimeout(r, 200)); // let the page's change handler run
    const after = await manager.read(tabId);
    const span = after.snapshot.find((n) => n.role === 'status');
    expect(span?.name).toBe('hello.txt');
  }, 30_000);

  it('takes a real PNG screenshot', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':77');
    const { tabId } = await manager.open({ url: `${fixture.baseUrl}/form/step1` });
    const shot = await manager.screenshot(tabId);
    expect(shot.mimeType).toBe('image/png');
    // PNG magic bytes, base64-encoded, always start with iVBORw0KGgo.
    expect(shot.data.startsWith('iVBORw0KGgo')).toBe(true);
  }, 30_000);

  describe('coordinate pointer + keyboard (computer-use style)', () => {
    // Reaches the live Playwright page to read what the fixture recorded.
    const pageOf = (
      m: BrowserManager,
      tabId: string,
    ): {
      evaluate: (js: string) => Promise<unknown>;
      waitForFunction: (js: string) => Promise<unknown>;
    } => (m as unknown as { requireTab(id: string): { page: never } }).requireTab(tabId).page;
    const logOf = async (m: BrowserManager, tabId: string): Promise<string> =>
      (await pageOf(m, tabId).evaluate("document.getElementById('log').textContent")) as string;

    it('clicks, double-clicks and right-clicks at screenshot coordinates', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':71');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      await manager.pointer(tabId, { action: 'click', x: 250, y: 200 });
      await manager.pointer(tabId, { action: 'double_click', x: 250, y: 200 });
      await manager.pointer(tabId, { action: 'right_click', x: 250, y: 200 });
      const log = await logOf(manager, tabId);
      expect(log).toContain('click');
      expect(log).toContain('dblclick');
      expect(log).toContain('contextmenu');
      expect(log).toContain('up@250,200');
    }, 30_000);

    it('a click outside the box does not hit it', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':72');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      await manager.pointer(tabId, { action: 'click', x: 600, y: 600 });
      expect(await logOf(manager, tabId)).not.toContain('click\n');
    }, 30_000);

    it('moves (hover) and drags between coordinates', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':73');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      await manager.pointer(tabId, { action: 'move', x: 250, y: 200 });
      expect(await logOf(manager, tabId)).toContain('mouseenter');
      await manager.pointer(tabId, { action: 'drag', x: 250, y: 200, toX: 500, toY: 300 });
      expect(await logOf(manager, tabId)).toContain('up@500,300');
    }, 30_000);

    it('scrolls the page by a wheel delta at a point', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':74');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      await manager.pointer(tabId, { action: 'scroll', x: 250, y: 200, scrollY: 400 });
      await pageOf(manager, tabId).waitForFunction('scrollY >= 400');
      expect(await logOf(manager, tabId)).toContain('scrollY=400');
    }, 30_000);

    it('rejects a missing or out-of-viewport coordinate loudly', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':75');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      await expect(manager.pointer(tabId, { action: 'click' })).rejects.toThrow(/x and y/);
      await expect(manager.pointer(tabId, { action: 'click', x: 99999, y: 5 })).rejects.toThrow(
        /outside the viewport/,
      );
      await expect(manager.pointer(tabId, { action: 'drag', x: 5, y: 5 })).rejects.toThrow(
        /toX and toY/,
      );
    }, 30_000);

    it('presses single keys and chords into the focused element', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':76');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      await manager.pointer(tabId, { action: 'click', x: 450, y: 20 });
      await manager.pressKeys(tabId, ['h', 'i', 'Control+a', 'Backspace', 'o', 'k']);
      expect(await pageOf(manager, tabId).evaluate("document.getElementById('field').value")).toBe(
        'ok',
      );
    }, 30_000);

    it('viewport() reports the size the screenshot coordinates live in', async () => {
      fixture = await startFixtureServer();
      const manager = newManager(':78');
      const { tabId } = await manager.open({ url: `${fixture.baseUrl}/pointer` });
      const vp = await manager.viewport(tabId);
      expect(vp.width).toBeGreaterThan(300);
      expect(vp.height).toBeGreaterThan(300);
    }, 30_000);
  });

  it('tabs() lists every open tab, and close() removes it', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':85');
    const a = await manager.open({ url: `${fixture.baseUrl}/form/step1` });
    const b = await manager.open({ url: `${fixture.baseUrl}/login` });

    const tabs = await manager.tabs();
    expect(tabs.map((t) => t.tabId).sort()).toEqual([a.tabId, b.tabId].sort());

    await manager.close(a.tabId);
    expect((await manager.tabs()).map((t) => t.tabId)).toEqual([b.tabId]);
    await expect(manager.read(a.tabId)).rejects.toThrow(TabNotFoundError);
  }, 30_000);

  it('a stale ref fails clearly instead of clicking the wrong thing', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':86');
    const { tabId } = await manager.open({ url: `${fixture.baseUrl}/form/step1` });
    await expect(manager.click(tabId, 'e999')).rejects.toThrow(RefNotFoundError);
  }, 30_000);

  it("'logged-in' profile persists across manager instances (a host restart); 'logged-out' leaves no cookies", async () => {
    fixture = await startFixtureServer();
    const sharedRoot = mkdtempSync(join(tmpdir(), 'patch-browser-profile-'));
    tmpDirs.push(sharedRoot);

    // Manager A logs in on the persistent profile, then goes away entirely
    // (dispose = the host restarting).
    const managerA = new BrowserManager({
      root: sharedRoot,
      logger: silent,
      virtualDisplay: ':87',
    });
    managers.push(managerA);
    const loginTab = await managerA.open({ url: `${fixture!.baseUrl}/login` });
    let snap = (await managerA.read(loginTab.tabId)).snapshot;
    await managerA.type(
      loginTab.tabId,
      refFor(snap, (n) => n.name === 'Username'),
      'ada',
    );
    await managerA.type(
      loginTab.tabId,
      refFor(snap, (n) => n.name === 'Password'),
      'secret123',
    );
    await managerA.click(
      loginTab.tabId,
      refFor(snap, (n) => n.tag === 'button'),
    );
    const afterLogin = await managerA.read(loginTab.tabId);
    expect(afterLogin.snapshot.find((n) => n.role === 'status')?.name).toBe('Welcome back');
    await managerA.dispose();
    // Give the OS a beat to actually release the profile dir's lock file
    // after Chromium's process exit, before a second Chromium opens it.
    await new Promise((r) => setTimeout(r, 500));

    // Manager B, same root, brand-new process-level state: the SAME
    // persistent profile should still carry the session cookie.
    const managerB = new BrowserManager({
      root: sharedRoot,
      logger: silent,
      virtualDisplay: ':88',
    });
    managers.push(managerB);
    const acct = await managerB.open({ url: `${fixture!.baseUrl}/account` });
    const acctSnap = await managerB.read(acct.tabId);
    expect(acctSnap.snapshot.find((n) => n.role === 'status')?.name).toBe('Welcome back');

    // A fresh 'logged-out' tab on the SAME manager carries none of this —
    // the throwaway profile has no cookies at all.
    const out = await managerB.open({ url: `${fixture!.baseUrl}/account`, profile: 'logged-out' });
    const outSnap = await managerB.read(out.tabId);
    expect(outSnap.snapshot.find((n) => n.role === 'status')?.name).toBe('please log in');
  }, 45_000);

  it('fails clearly with no fallback when Chromium is not installed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-browser-missing-'));
    tmpDirs.push(root);
    const manager = new BrowserManager({
      root,
      logger: silent,
      virtualDisplay: ':89',
      loadPlaywright: async () =>
        ({
          chromium: { executablePath: () => '/nonexistent/chrome-binary' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    });
    managers.push(manager);
    await expect(manager.open({ url: 'http://example.invalid/' })).rejects.toThrow(
      BrowserNotInstalledError,
    );
  });
});

describe('BrowserManager — Route through (spec/02 § Browser — Route through)', () => {
  let fixture: { server: Server; baseUrl: string } | undefined;
  let managers: BrowserManager[] = [];
  let tunnels: Array<BrowserTunnelClient | BrowserTunnelRelay> = [];
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const m of managers) await m.dispose();
    managers = [];
    for (const t of tunnels) t.dispose();
    tunnels = [];
    if (fixture) {
      const server = fixture.server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fixture = undefined;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  function newManager(virtualDisplay: string): BrowserManager {
    const root = mkdtempSync(join(tmpdir(), 'patch-browser-route-'));
    tmpDirs.push(root);
    const m = new BrowserManager({ root, logger: silent, virtualDisplay });
    managers.push(m);
    return m;
  }

  /** A client+relay pair wired directly to each other, `relay`'s outbound egress pinned to `localAddress`. */
  function wireTunnel(localAddress: string): { client: BrowserTunnelClient } {
    const relay = new BrowserTunnelRelay({
      logger: silent,
      localAddress,
      sender: (event) => client.handleEvent(event),
    });
    const client = new BrowserTunnelClient({
      logger: silent,
      sender: (_daemonId, event) => {
        if (event.type === 'patch.browser_tunnel.open') relay.handleOpen(event);
        else if (event.type === 'patch.browser_tunnel.data') relay.handleData(event);
        else relay.handleClose(event);
      },
    });
    tunnels.push(client, relay);
    return { client };
  }

  function whoamiAddr(snapshot: { role: string; name: string }[]): string | undefined {
    return snapshot.find((n) => n.role === 'status')?.name;
  }

  it('a page really loads VIA the routing host — the origin sees that host, not this one (exit-IP check)', async () => {
    fixture = await startFixtureServer();
    const { client } = wireTunnel('127.0.0.3');
    const manager = newManager(':94');

    const { tabId, routedVia } = await manager.open({
      url: `${fixture.baseUrl}/whoami`,
      routeThrough: {
        daemonId: 'host-b',
        hostName: 'Tom’s Mac',
        online: true,
        proxyServer: await client.proxyServerFor('host-b'),
      },
    });
    expect(routedVia).toBe('Tom’s Mac');
    const { snapshot } = await manager.read(tabId);
    expect(whoamiAddr(snapshot)).toBe('127.0.0.3');

    const tabs = await manager.tabs();
    expect(tabs.find((t) => t.tabId === tabId)?.routedVia).toBe('Tom’s Mac');
  }, 30_000);

  it('with no routeThrough, the page loads direct — no routedVia, origin sees this host', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':95');
    const { tabId, routedVia } = await manager.open({ url: `${fixture.baseUrl}/whoami` });
    expect(routedVia).toBeUndefined();
    const { snapshot } = await manager.read(tabId);
    expect(whoamiAddr(snapshot)).toBe('127.0.0.1');
  }, 30_000);

  it('routing host OFFLINE fails the open loudly, naming the host — no fallback to direct', async () => {
    fixture = await startFixtureServer();
    const manager = newManager(':96');
    await expect(
      manager.open({
        url: `${fixture.baseUrl}/whoami`,
        routeThrough: { daemonId: 'host-b', hostName: 'Tom’s Mac', online: false },
      }),
    ).rejects.toThrow(RoutingHostOfflineError);
    await expect(
      manager.open({
        url: `${fixture.baseUrl}/whoami`,
        routeThrough: { daemonId: 'host-b', hostName: 'Tom’s Mac', online: false },
      }),
    ).rejects.toThrow(/Tom’s Mac/);
    // NO FALLBACK: not even one tab was opened.
    expect(await manager.tabs()).toEqual([]);
  }, 30_000);

  it('turning routing OFF goes direct again — closing the previously-routed tab', async () => {
    fixture = await startFixtureServer();
    const { client } = wireTunnel('127.0.0.4');
    const manager = newManager(':97');

    const routed = await manager.open({
      url: `${fixture.baseUrl}/whoami`,
      routeThrough: {
        daemonId: 'host-b',
        hostName: 'Tom’s Mac',
        online: true,
        proxyServer: await client.proxyServerFor('host-b'),
      },
    });
    expect((await manager.read(routed.tabId)).snapshot.find((n) => n.role === 'status')?.name).toBe(
      '127.0.0.4',
    );

    // Off: a fresh open with no routeThrough relaunches direct, and the
    // previously-routed tab — on the context that just closed — is gone.
    const direct = await manager.open({ url: `${fixture.baseUrl}/whoami` });
    expect(direct.routedVia).toBeUndefined();
    expect((await manager.read(direct.tabId)).snapshot.find((n) => n.role === 'status')?.name).toBe(
      '127.0.0.1',
    );
    await expect(manager.read(routed.tabId)).rejects.toThrow(TabNotFoundError);
  }, 30_000);
});
