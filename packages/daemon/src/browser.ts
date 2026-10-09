// Agent browser (spec/02 § Browser, spec/06 § Browser tools). Step 1 of 3:
// the host component itself — a real, non-headless Chromium the agent can
// drive — and the ten patch_browser_* primitives. Live-view streaming and
// take-over (spec/14, spec/15) are a later step; this module owns no
// screencast and no per-chat "Browsing <site>" status.
//
// HONEST BY DESIGN: a normal Chrome/Chromium with a normal fingerprint, never
// headless (`headless: false`, under a real or virtual display), automation
// flags off (`navigator.webdriver` undefined, `--disable-blink-features=
// AutomationControlled`), real input events with human timing. No stealth
// beyond being a normal browser, no captcha-solving. NO FALLBACK: a host
// missing Chromium or (on Linux) Xvfb gets a clear `BrowserNotInstalledError`
// naming the fix, never a silent switch to headless or another engine.
//
// PROFILES: 'logged-in' (default) is ONE persistent userDataDir shared by
// every chat on this host, so a site logged into once stays logged in across
// chats and restarts. 'logged-out' is a throwaway in-memory context — no
// userDataDir, nothing written to disk, so it leaves no cookies behind.

import { randomUUID } from 'node:crypto';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { signRequestHeaders } from '@patch/wire/web-bot-auth';
import type { WebBotAuthConfig } from './webBotAuth.js';

export class BrowserNotInstalledError extends Error {
  readonly code = 'browser_not_installed' as const;
  constructor(detail: string) {
    super(
      `browser component not installed on this host: ${detail} No fallback to another browser.`,
    );
    this.name = 'BrowserNotInstalledError';
  }
}

export class TabNotFoundError extends Error {
  readonly code = 'tab_not_found' as const;
  constructor(tabId: string) {
    super(`browser tab not found (closed, or never opened): ${tabId}`);
    this.name = 'TabNotFoundError';
  }
}

export class RefNotFoundError extends Error {
  readonly code = 'ref_not_found' as const;
  constructor(ref: string) {
    super(
      `element ref "${ref}" not found on the page — call patch_browser_read again, the page may have changed`,
    );
    this.name = 'RefNotFoundError';
  }
}

/**
 * spec/02 § Browser — Route through. NO FALLBACK: a routing host that is
 * offline fails the open outright, naming the host, rather than silently
 * going direct — that would make routing look like it is on when it is not.
 */
export class RoutingHostOfflineError extends Error {
  readonly code = 'routing_host_offline' as const;
  constructor(hostName: string) {
    super(
      `can't open the browser: the routing host "${hostName}" is offline, and browsing never falls back to going direct. Turn off "Route through" to browse from this host instead, or wait for "${hostName}" to come back online.`,
    );
    this.name = 'RoutingHostOfflineError';
  }
}

export type PointerAction = 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll';

export interface PointerRequest {
  action: PointerAction;
  /** Viewport pixels, the same space `patch_browser_screenshot` is drawn in. */
  x?: number;
  y?: number;
  /** `drag` destination. */
  toX?: number;
  toY?: number;
  /** `scroll` wheel deltas in pixels (positive = down / right). */
  scrollX?: number;
  scrollY?: number;
}

export type BrowserProfile = 'logged-in' | 'logged-out';

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  checked?: boolean;
  options?: string[];
}

export interface OpenResult {
  tabId: string;
  title: string;
  url: string;
  /** The routing host's display name, present iff this tab's traffic goes via one. */
  routedVia?: string;
}

export interface TabInfo {
  tabId: string;
  title: string;
  url: string;
  profile: BrowserProfile;
  /** The routing host's display name, present iff this tab's traffic goes via one. */
  routedVia?: string;
}

interface Tab {
  tabId: string;
  page: Page;
  profile: BrowserProfile;
  /** Set only for a 'logged-out' tab: its own throwaway context, closed with it. */
  ephemeralContext?: BrowserContext;
  /** The chat that opened this tab, for a future "Browsing <site>" status row. */
  ownerChatId?: string;
  /** spec/02 § Browser — Route through: the routing host's display name, this tab's whole life. */
  routedVia?: string;
}

/**
 * What `open()` was asked to route through, resolved by the CALLER (the
 * host knows which hosts are online and what they're called; this module
 * stays ignorant of hosts, the server, and the wire — same discipline as
 * every other BrowserManager option). `online: false` is a deliberate
 * input, not an edge case to guess at: the caller already knows the routing
 * host is down, and `open()` must refuse rather than silently going direct.
 */
export interface RouteThrough {
  daemonId: string;
  hostName: string;
  online: boolean;
  /** `socks5://127.0.0.1:<port>` — the caller's already-running tunnel listener for this host. Required iff `online`. */
  proxyServer?: string;
}

export interface BrowserManagerOptions {
  /** `<patchHome>/browser` — the persistent 'logged-in' profile lives under here. */
  root: string;
  logger: Logger;
  /** Injectable for tests: swap the real `playwright` module for a fake one. */
  loadPlaywright?: () => Promise<typeof import('playwright')>;
  /**
   * The virtual display this manager's own Xvfb opens, when the host has
   * none already. Defaults to `:95` — fine for production (one host, one
   * BrowserManager); tests give each manager instance its own so two can run
   * without racing over the same X socket.
   */
  virtualDisplay?: string;
  /**
   * Web Bot Auth: when set, every http(s) request either profile makes is signed
   * (RFC 9421, tag `web-bot-auth`) so sites that verify agents can recognise
   * Patch. Unset = browse unsigned. See `webBotAuthFromEnv`.
   */
  webBotAuth?: WebBotAuthConfig;
}

function randomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

// The next two run in the PAGE, not this (Node, no DOM lib) process — plain
// source strings handed to Playwright's addInitScript/evaluate rather than
// typed functions, so this file needs no `dom` lib and no `any` escape hatch
// for globals (`document`, `HTMLInputElement`, …) that only exist there.

const PATCH_WEBDRIVER_INIT_SCRIPT = `
Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => undefined,
  configurable: true,
});
`;

/**
 * Tags every currently-visible interactive/landmark element with a stable
 * `data-patch-ref`, replacing whatever a previous read() left, and returns a
 * flat accessible-ish snapshot. Deliberately plain DOM inspection rather than
 * the full accessibility tree: it needs no native bridge, and every node it
 * reports is exactly one a click/type/select/upload call can target by the
 * SAME ref.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a[href], button, input, select, textarea, [role], [onclick], h1, h2, h3, h4, h5, h6';
  document.querySelectorAll('[data-patch-ref]').forEach((el) => el.removeAttribute('data-patch-ref'));
  let counter = 0;
  const nodes = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++counter);
    el.setAttribute('data-patch-ref', ref);
    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute('role');
    const role = explicitRole || (
      tag === 'a' ? 'link' :
      tag === 'button' ? 'button' :
      tag === 'select' ? 'combobox' :
      tag === 'textarea' ? 'textbox' :
      tag === 'input' ? (el.type || 'textbox') :
      /^h[1-6]$/.test(tag) ? 'heading' : 'generic'
    );
    const name = el.getAttribute('aria-label') || el.placeholder ||
      (el.innerText ? el.innerText.trim().slice(0, 200) : '') || el.value || '';
    const node = { ref, role, name, tag };
    if (tag === 'input') {
      node.type = el.type;
      node.value = el.value;
      if (el.type === 'checkbox' || el.type === 'radio') node.checked = el.checked;
    } else if (tag === 'select') {
      node.value = el.value;
      node.options = Array.from(el.options).map((o) => o.value || o.text);
    } else if (tag === 'textarea') {
      node.value = el.value;
    }
    nodes.push(node);
  }
  return nodes;
})()`;

const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--disable-gpu'];

/** `'direct'` or the routing host's daemonId — what a launched context/browser's `proxy` was set from. */
type ProxyKey = 'direct' | string;

export class BrowserManager {
  private readonly tabsById = new Map<string, Tab>();
  private loggedInContext: BrowserContext | null = null;
  private loggedInContextProxyKey: ProxyKey | null = null;
  private ephemeralBrowser: Browser | null = null;
  private ephemeralBrowserProxyKey: ProxyKey | null = null;
  private xvfb: ChildProcess | null = null;
  private display: string | undefined;
  private playwrightMod: typeof import('playwright') | null = null;

  constructor(private readonly opts: BrowserManagerOptions) {}

  private async playwright(): Promise<typeof import('playwright')> {
    if (this.playwrightMod) return this.playwrightMod;
    const load = this.opts.loadPlaywright ?? (() => import('playwright'));
    this.playwrightMod = await load();
    return this.playwrightMod;
  }

  /**
   * Signs every http(s) request this context makes. Per request, not per
   * context, because `@authority` changes with the target and each signature
   * carries its own created/expires/nonce. A signing failure aborts the
   * request loudly rather than sending it unsigned.
   */
  private async installSigning(context: BrowserContext): Promise<void> {
    const cfg = this.opts.webBotAuth;
    if (!cfg) return;
    await context.route(/^https?:/, async (route) => {
      const request = route.request();
      try {
        const signed = signRequestHeaders(request.url(), cfg.key, cfg.directoryUrl);
        await route.continue({ headers: { ...request.headers(), ...signed } });
      } catch (err) {
        this.opts.logger.error({ err, url: request.url() }, 'browser: web-bot-auth signing failed');
        await route.abort('failed');
      }
    });
  }

  /**
   * Throws BrowserNotInstalledError with NO side effect when Chromium is
   * missing. Checked before every launch so a missing component always fails
   * the same clear way, never half-launches.
   */
  private async checkChromiumInstalled(): Promise<void> {
    const { chromium } = await this.playwright();
    const execPath = chromium.executablePath();
    if (!existsSync(execPath)) {
      throw new BrowserNotInstalledError(
        `Playwright's Chromium is not installed on this host (expected ${execPath}). ` +
          'Run `npx playwright install chromium` on this host, or install it from Settings → Hosts → Browser.',
      );
    }
  }

  /**
   * A real display to launch into. Reuses one already present (a desktop
   * host); on a headless Linux host it starts its own Xvfb — once, lazily —
   * and refuses clearly if Xvfb isn't installed, rather than falling back to
   * `headless: true`, which is the one thing "honest by design" forbids.
   */
  private async ensureDisplay(): Promise<string | undefined> {
    if (process.env['DISPLAY']) return process.env['DISPLAY'];
    if (this.display) return this.display;
    if (process.platform !== 'linux') return undefined;
    const probe = spawnSync('which', ['Xvfb']);
    if (probe.status !== 0) {
      throw new BrowserNotInstalledError(
        'this is a headless Linux host with no DISPLAY and no Xvfb to make one. ' +
          'Install it (e.g. `apt install xvfb`) and try again.',
      );
    }
    const display = this.opts.virtualDisplay ?? ':95';
    this.xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    this.xvfb.on('exit', (code) => {
      this.opts.logger.warn({ code }, 'browser: Xvfb exited');
      this.display = undefined;
      this.xvfb = null;
    });
    // The socket file alone races Chromium's own connect — Xvfb can create it
    // a beat before it actually accepts X11 protocol connections, which reads
    // to a launched browser as "Missing X server". `xdpyinfo` round-trips a
    // real protocol request, so it only succeeds once the server truly will.
    const deadline = Date.now() + 5000;
    for (;;) {
      if (spawnSync('xdpyinfo', ['-display', display]).status === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`browser: Xvfb on ${display} never answered xdpyinfo in time`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    this.display = display;
    return display;
  }

  private async launchEnv(): Promise<Record<string, string> | undefined> {
    const display = await this.ensureDisplay();
    return display ? { ...process.env, DISPLAY: display } : undefined;
  }

  /**
   * spec/02 § Browser — Route through. A launched context/browser's `proxy`
   * is fixed for its whole life — Playwright has no way to re-point a
   * running one — so a `routeThrough` that differs from whichever key the
   * current one launched with closes it first. Closing takes every open tab
   * on that profile with it: there is no way to keep one running while its
   * network changes underneath it.
   */
  private async proxyFor(routeThrough?: RouteThrough): Promise<{
    key: ProxyKey;
    launchOpt: { server: string } | undefined;
  }> {
    if (!routeThrough) return { key: 'direct', launchOpt: undefined };
    if (!routeThrough.online) throw new RoutingHostOfflineError(routeThrough.hostName);
    return { key: routeThrough.daemonId, launchOpt: { server: routeThrough.proxyServer! } };
  }

  /**
   * Closes every currently-tracked tab on `profile` (so `tabsById` and
   * reality agree — a bare `context.close()`/`browser.close()` leaves a
   * dangling entry whose `read`/`click`/etc. then throws Playwright's own
   * "Target closed" instead of `TabNotFoundError`) before closing the
   * context/browser itself.
   */
  private async closeTabsFor(profile: BrowserProfile): Promise<void> {
    for (const [tabId, tab] of [...this.tabsById]) {
      if (tab.profile !== profile) continue;
      await this.close(tabId).catch((err: unknown) => {
        this.opts.logger.warn(
          { tabId, err },
          'browser: error closing tab while re-launching for Route through',
        );
      });
    }
  }

  private async getLoggedInContext(routeThrough?: RouteThrough): Promise<BrowserContext> {
    const { key, launchOpt } = await this.proxyFor(routeThrough);
    if (this.loggedInContext && this.loggedInContextProxyKey !== key) {
      await this.closeTabsFor('logged-in');
      await this.loggedInContext.close();
      this.loggedInContext = null;
    }
    if (this.loggedInContext) return this.loggedInContext;
    await this.checkChromiumInstalled();
    const { chromium } = await this.playwright();
    const userDataDir = join(this.opts.root, 'profile');
    mkdirSync(userDataDir, { recursive: true });
    const env = await this.launchEnv();
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: LAUNCH_ARGS,
      ...(env ? { env } : {}),
      ...(launchOpt ? { proxy: launchOpt } : {}),
    });
    await context.addInitScript(PATCH_WEBDRIVER_INIT_SCRIPT);
    await this.installSigning(context);
    context.on('close', () => {
      this.loggedInContext = null;
      this.loggedInContextProxyKey = null;
    });
    this.loggedInContext = context;
    this.loggedInContextProxyKey = key;
    return context;
  }

  private async getEphemeralBrowser(routeThrough?: RouteThrough): Promise<Browser> {
    const { key, launchOpt } = await this.proxyFor(routeThrough);
    if (this.ephemeralBrowser && this.ephemeralBrowserProxyKey !== key) {
      await this.closeTabsFor('logged-out');
      await this.ephemeralBrowser.close();
      this.ephemeralBrowser = null;
    }
    if (this.ephemeralBrowser) return this.ephemeralBrowser;
    await this.checkChromiumInstalled();
    const { chromium } = await this.playwright();
    const env = await this.launchEnv();
    const browser = await chromium.launch({
      headless: false,
      args: LAUNCH_ARGS,
      ...(env ? { env } : {}),
      ...(launchOpt ? { proxy: launchOpt } : {}),
    });
    browser.on('disconnected', () => {
      this.ephemeralBrowser = null;
      this.ephemeralBrowserProxyKey = null;
    });
    this.ephemeralBrowser = browser;
    this.ephemeralBrowserProxyKey = key;
    return browser;
  }

  private requireTab(tabId: string): Tab {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new TabNotFoundError(tabId);
    return tab;
  }

  private locatorFor(tab: Tab, ref: string): Locator {
    return tab.page.locator(`[data-patch-ref="${ref}"]`);
  }

  private async requireLocator(tab: Tab, ref: string): Promise<Locator> {
    const locator = this.locatorFor(tab, ref);
    if ((await locator.count()) === 0) throw new RefNotFoundError(ref);
    return locator;
  }

  /** `patch_browser_open`. */
  async open(opts: {
    url: string;
    profile?: BrowserProfile;
    chatId?: string;
    /** spec/02 § Browser — Route through. Omitted = direct, as always. */
    routeThrough?: RouteThrough;
  }): Promise<OpenResult> {
    const profile = opts.profile ?? 'logged-in';
    let page: Page;
    let ephemeralContext: BrowserContext | undefined;
    if (profile === 'logged-in') {
      const context = await this.getLoggedInContext(opts.routeThrough);
      page = await context.newPage();
    } else {
      const browser = await this.getEphemeralBrowser(opts.routeThrough);
      ephemeralContext = await browser.newContext();
      await ephemeralContext.addInitScript(PATCH_WEBDRIVER_INIT_SCRIPT);
      await this.installSigning(ephemeralContext);
      page = await ephemeralContext.newPage();
    }
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    const tabId = randomUUID();
    const routedVia = opts.routeThrough?.hostName;
    this.tabsById.set(tabId, {
      tabId,
      page,
      profile,
      ...(ephemeralContext ? { ephemeralContext } : {}),
      ...(opts.chatId ? { ownerChatId: opts.chatId } : {}),
      ...(routedVia ? { routedVia } : {}),
    });
    return {
      tabId,
      title: await page.title(),
      url: page.url(),
      ...(routedVia ? { routedVia } : {}),
    };
  }

  /** `patch_browser_read`. */
  async read(tabId: string): Promise<{ title: string; url: string; snapshot: SnapshotNode[] }> {
    const tab = this.requireTab(tabId);
    const snapshot = (await tab.page.evaluate(SNAPSHOT_SCRIPT)) as SnapshotNode[];
    return { title: await tab.page.title(), url: tab.page.url(), snapshot };
  }

  /** `patch_browser_click`. */
  async click(tabId: string, ref: string): Promise<void> {
    const tab = this.requireTab(tabId);
    const locator = await this.requireLocator(tab, ref);
    await tab.page.waitForTimeout(randomDelay(50, 150));
    await locator.click({ delay: randomDelay(30, 90) });
  }

  /** `patch_browser_type`. */
  async type(tabId: string, ref: string, text: string, opts?: { submit?: boolean }): Promise<void> {
    const tab = this.requireTab(tabId);
    const locator = await this.requireLocator(tab, ref);
    await tab.page.waitForTimeout(randomDelay(50, 150));
    await locator.click();
    await locator.pressSequentially(text, { delay: randomDelay(40, 120) });
    if (opts?.submit) await locator.press('Enter');
  }

  /** `patch_browser_fill_form`. */
  async fillForm(tabId: string, fields: { ref: string; value: string }[]): Promise<void> {
    const tab = this.requireTab(tabId);
    for (const field of fields) {
      const locator = await this.requireLocator(tab, field.ref);
      const tag = await locator.evaluate((el) => (el as { tagName: string }).tagName.toLowerCase());
      if (tag === 'select') {
        await locator.selectOption(field.value);
      } else {
        const type = await locator.evaluate((el) => (el as { type?: string }).type ?? '');
        if (type === 'checkbox' || type === 'radio') {
          const want = field.value === 'true' || field.value === 'checked';
          if ((await locator.isChecked()) !== want) await locator.click();
        } else {
          await locator.click();
          await locator.fill('');
          await locator.pressSequentially(field.value, { delay: randomDelay(30, 90) });
        }
      }
      await tab.page.waitForTimeout(randomDelay(50, 120));
    }
  }

  /** `patch_browser_select`. */
  async select(tabId: string, ref: string, value: string): Promise<void> {
    const tab = this.requireTab(tabId);
    const locator = await this.requireLocator(tab, ref);
    await locator.selectOption(value);
  }

  /** `patch_browser_upload`. */
  async upload(tabId: string, ref: string, filePaths: string[]): Promise<void> {
    const tab = this.requireTab(tabId);
    const locator = await this.requireLocator(tab, ref);
    await locator.setInputFiles(filePaths);
  }

  /** `patch_browser_screenshot`. */
  async screenshot(tabId: string): Promise<{ data: string; mimeType: string }> {
    const tab = this.requireTab(tabId);
    const buf = await tab.page.screenshot({ type: 'png' });
    return { data: buf.toString('base64'), mimeType: 'image/png' };
  }

  /** The size of the tab's viewport, i.e. the coordinate space of its screenshots. */
  async viewport(tabId: string): Promise<{ width: number; height: number }> {
    const tab = this.requireTab(tabId);
    const size = tab.page.viewportSize();
    if (size) return size;
    return tab.page.evaluate<{ width: number; height: number }>(
      '({ width: innerWidth, height: innerHeight })',
    );
  }

  /**
   * `patch_browser_mouse`. Real mouse events at screenshot coordinates, for
   * what the ref-based tools cannot reach (canvases, maps, custom widgets,
   * drag and drop, wheel scrolling). Out-of-viewport coordinates fail loudly
   * rather than being clamped onto some other element.
   */
  async pointer(tabId: string, req: PointerRequest): Promise<void> {
    const tab = this.requireTab(tabId);
    const { x, y } = req;
    if (x === undefined || y === undefined) {
      throw new Error(`${req.action} needs both x and y (pixels in the screenshot)`);
    }
    const vp = await this.viewport(tabId);
    const inside = (px: number, py: number): boolean =>
      px >= 0 && py >= 0 && px < vp.width && py < vp.height;
    if (!inside(x, y)) {
      throw new Error(
        `(${x}, ${y}) is outside the viewport (${vp.width}x${vp.height}); take a fresh screenshot`,
      );
    }
    const mouse = tab.page.mouse;
    await mouse.move(x, y, { steps: 8 });
    await tab.page.waitForTimeout(randomDelay(50, 150));
    switch (req.action) {
      case 'move':
        return;
      case 'click':
        await mouse.click(x, y, { delay: randomDelay(30, 90) });
        return;
      case 'double_click':
        await mouse.dblclick(x, y, { delay: randomDelay(30, 90) });
        return;
      case 'right_click':
        await mouse.click(x, y, { button: 'right', delay: randomDelay(30, 90) });
        return;
      case 'drag': {
        const { toX, toY } = req;
        if (toX === undefined || toY === undefined) throw new Error('drag needs toX and toY');
        if (!inside(toX, toY)) {
          throw new Error(
            `(${toX}, ${toY}) is outside the viewport (${vp.width}x${vp.height}); take a fresh screenshot`,
          );
        }
        await mouse.down();
        await mouse.move(toX, toY, { steps: 15 });
        await mouse.up();
        return;
      }
      case 'scroll': {
        const dx = req.scrollX ?? 0;
        const dy = req.scrollY ?? 0;
        if (dx === 0 && dy === 0) throw new Error('scroll needs a non-zero scrollX or scrollY');
        await mouse.wheel(dx, dy);
        return;
      }
    }
  }

  /**
   * `patch_browser_key`. Presses each entry in order into whatever has focus:
   * a key name ("Enter", "Tab", "ArrowDown", "a") or a chord ("Control+a",
   * "Shift+Tab"). Playwright rejects an unknown key name, which surfaces as is.
   */
  async pressKeys(tabId: string, keys: string[]): Promise<void> {
    const tab = this.requireTab(tabId);
    if (keys.length === 0) throw new Error('press at least one key');
    for (const key of keys) {
      await tab.page.keyboard.press(key, { delay: randomDelay(30, 90) });
      await tab.page.waitForTimeout(randomDelay(30, 90));
    }
  }

  /** `patch_browser_tabs`. */
  async tabs(): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    for (const tab of this.tabsById.values()) {
      out.push({
        tabId: tab.tabId,
        title: await tab.page.title(),
        url: tab.page.url(),
        profile: tab.profile,
        ...(tab.routedVia ? { routedVia: tab.routedVia } : {}),
      });
    }
    return out;
  }

  /** `patch_browser_close`. */
  async close(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    await tab.page.close();
    if (tab.ephemeralContext) await tab.ephemeralContext.close();
    this.tabsById.delete(tabId);
  }

  /**
   * Wipe the shared 'logged-in' profile — every saved session on this host,
   * gone. Groundwork for Settings → Hosts → Browser → "clear all" (a later
   * step); not wired to a tool yet.
   */
  async clearLoggedInProfile(): Promise<void> {
    if (this.loggedInContext) {
      await this.loggedInContext.close();
      this.loggedInContext = null;
    }
    rmSync(join(this.opts.root, 'profile'), { recursive: true, force: true });
  }

  /** Close every tab/context/browser and stop this manager's own Xvfb. */
  async dispose(): Promise<void> {
    for (const tabId of [...this.tabsById.keys()]) {
      await this.close(tabId).catch((err: unknown) => {
        this.opts.logger.warn({ tabId, err }, 'browser: error closing tab on dispose');
      });
    }
    if (this.loggedInContext) {
      await this.loggedInContext.close().catch(() => undefined);
      this.loggedInContext = null;
      this.loggedInContextProxyKey = null;
    }
    if (this.ephemeralBrowser) {
      await this.ephemeralBrowser.close().catch(() => undefined);
      this.ephemeralBrowser = null;
      this.ephemeralBrowserProxyKey = null;
    }
    if (this.xvfb) {
      this.xvfb.kill();
      this.xvfb = null;
    }
  }
}
