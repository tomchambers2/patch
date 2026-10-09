// Pads — the whole product in a real browser (spec/14 § Pads): the real SPA
// served by the real server, a real credential, a real Pad. Covers what only the
// assembled app can show: the Pads entry and its pending count, the Pads page,
// a Pad opening beside its chat, "Design a change to Chat" photographing the
// live screen into a Pad, and New Pad starting from a live-captured screen.
//
// Needs the SPA built: `pnpm --filter @patch/web build` (or PATCH_WEB_DIST).
// A missing OR STALE build fails loudly — it is never a skip. Staleness is
// checked because nothing in `verify` builds the SPA before the test layer
// runs: on 7 Oct this suite spent four minutes timing out on Pads routes that
// were missing only from a seven-hour-old bundle, which reads as "Pads is
// broken" and failed a deploy of 63 working commits.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const WEB = process.env['PATCH_WEB_DIST'] ?? join(__dirname, '..', '..', 'web', 'dist');
const WEB_SRC = join(__dirname, '..', '..', 'web', 'src');

/** Newest mtime under a directory tree, or 0 if it isn't there. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}
const PAGE = `<!doctype html><html><head><title>Home</title></head><body style="margin:0;font:20px system-ui">
<h1 id="t" style="margin:40px">Credit</h1></body></html>`;

// A real browser against the built SPA: it is the browser layer, and follows the same switch
// as the gate's own (scripts/verify.mjs): off by default on this box, `PATCH_RUN_BROWSER_GATE=1`
// runs it. Left on, it failed every deploy whose server inputs changed, because a clean deploy
// tree has no SPA build, and it put a Chrome on screen.
const BROWSER_LAYER = process.env['PATCH_RUN_BROWSER_GATE'] === '1';

describe.skipIf(!BROWSER_LAYER)('pads in the app', () => {
  let dir: string;
  let browser: Browser;
  let built: Awaited<ReturnType<typeof buildAll>>;
  let link: InProcessDaemonLink;
  let base: string;
  let bearer: string;

  beforeAll(async () => {
    if (!existsSync(join(WEB, 'index.html'))) {
      throw new Error(`no SPA build at ${WEB} — run: pnpm --filter @patch/web build`);
    }
    // Only meaningful for the checkout's own dist; a PATCH_WEB_DIST pointing at
    // an installed release has no source tree to compare against.
    const srcAt = newestMtime(WEB_SRC);
    const distAt = newestMtime(WEB);
    if (srcAt > 0 && distAt < srcAt) {
      throw new Error(
        `the SPA build at ${WEB} is older than packages/web/src ` +
          `(${new Date(distAt).toISOString()} vs ${new Date(srcAt).toISOString()}) — ` +
          'it does not contain the UI this test asserts on. ' +
          'Run: pnpm --filter @patch/web build',
      );
    }
    dir = mkdtempSync(join(tmpdir(), 'patch-pad-app-'));
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    link = new InProcessDaemonLink();
    built = await buildAll({ logger: false, registry, daemonLink: link, webDistDir: WEB });
    link.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    bearer = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-test',
      surfaceKind: 'web',
      label: 'test',
    });
    const pw = await import('playwright');
    browser = await pw.chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await built?.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function openApp(path = '/app/pads') {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript((jwt) => localStorage.setItem('patch.credential.v1', jwt), bearer);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}${path}`);
    return { ctx, page, errors };
  }

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
  };

  it('the Pads page lists a Pad an agent made, with its status; opening it puts it beside its chat', async () => {
    // The agent's tool call, as the host would send it.
    link.emit({
      type: 'patch.pad.request',
      requestId: 'agent-1',
      chatId: 'c1',
      op: 'create',
      name: 'Care screens',
      app: 'Dog Log',
      device: 'phone',
      files: [{ path: 'index.html', base64: Buffer.from(PAGE).toString('base64') }],
    } as WireEvent);
    await expect
      .poll(() =>
        link.sent.some(
          (s) => s.event.type === 'patch.pad.response' && s.event.requestId === 'agent-1',
        ),
      )
      .toBe(true);
    const padId = (
      (link.sent.find((s) => s.event.type === 'patch.pad.response')!.event as any).result as {
        id: string;
      }
    ).id;
    // Tom has a pending change, so the list and the sidebar show a count.
    const { frameUrl } = (await api(`/api/pads/${padId}`)).body;
    await fetch(`${base}${frameUrl}api/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: 'index',
        kind: 'delete',
        target: { selector: 'html > body > h1:nth-of-type(1)', label: 'h1#t "Credit"' },
      }),
    });

    const { ctx, page, errors } = await openApp('/app/pads');
    await page.getByTestId('pads-route').waitFor();
    await page.getByTestId('pads-group-Dog Log').waitFor();
    expect(await page.getByTestId(`pad-badge-${padId}`).textContent()).toBe('1 change');
    await expect.poll(() => page.getByTestId('nav-pads-count').textContent()).toBe('1');
    await expect
      .poll(() => page.locator(`[data-testid=pad-tile-${padId}] img`).count(), { timeout: 20_000 })
      .toBe(1);

    // Search narrows the page.
    await page.getByTestId('pads-search').fill('nothing like this');
    await page.getByTestId('pads-empty').waitFor();
    await page.getByTestId('pads-search').fill('care');
    await page.getByTestId(`pad-tile-${padId}`).click();
    await page.getByTestId('pad-pane').waitFor();
    const frame = page.frameLocator('[data-testid=pad-frame]');
    await frame.locator('#frame').waitFor();
    await frame.frameLocator('#frame').locator('#t').waitFor({ state: 'attached' });
    expect(await page.locator('[data-testid=pad-name]').first().textContent()).toBe('Care screens');
    // The pad sits to the left of its chat, in its own pane.
    await page.locator('[data-testid=pad-pane]').waitFor();
    expect(await page.locator('.pane').count()).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('"Design a change to Chat" photographs the live screen into a Pad and opens it beside the chat', async () => {
    const { ctx, page, errors } = await openApp('/app/chats/c1');
    await page.getByTestId('action-more').waitFor();
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-design').click();
    await page.getByTestId('pad-pane').waitFor({ timeout: 30_000 });
    const pads = (await api('/api/pads')).body.pads as {
      id: string;
      app: string;
      screens: { name: string }[];
      chatId: string;
    }[];
    const made = pads.find((p) => p.app === 'Patch');
    expect(made).toMatchObject({ chatId: 'c1', screens: [{ name: 'Chat', width: 1400 }] });
    // The editor holds the design at that width instead of letting it reflow.
    const design = page.frameLocator('[data-testid=pad-frame]');
    await design.locator('#frame').waitFor();
    await expect
      .poll(() => design.locator('#wrap').evaluate((e) => (e as HTMLElement).style.minWidth))
      .toBe('1400px');
    // The capture is the real Patch UI, styled, with no scripts.
    const { frameUrl } = (await api(`/api/pads/${made!.id}`)).body;
    const html = await (await fetch(`${base}${frameUrl}f/cap-chat.html`)).text();
    expect(html).toContain('data-testid="chat-title"');
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/<style>[^<]*\.three-col/);
    expect(html).toMatch(/url\(["']?data:/); // a font or image was inlined
    expect(html).not.toContain('data-testid="head-menu"'); // the menu we clicked is not in the picture
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('New Pad: Patch screens as they look now are captured, the pad is created and opened', async () => {
    const { ctx, page, errors } = await openApp('/app/pads/new');
    await page.getByTestId('new-pad-route').waitFor();
    await page.getByTestId('new-pad-name').fill('Jobs rethink');
    await page.getByTestId('new-pad-based-Patch').click();
    await page.getByTestId('new-pad-live-jobs').click();
    await page.getByTestId('new-pad-chat').selectOption('c1');
    await page.getByTestId('new-pad-create').click();
    await page.getByTestId('pad-pane').waitFor({ timeout: 60_000 });
    const pads = (await api('/api/pads')).body.pads as {
      id: string;
      name: string;
      screens: { name: string }[];
    }[];
    const made = pads.find((p) => p.name === 'Jobs rethink');
    expect(made?.screens.map((s) => s.name)).toEqual(['Jobs']);
    const { frameUrl } = (await api(`/api/pads/${made!.id}`)).body;
    const html = await (await fetch(`${base}${frameUrl}f/cap-jobs.html`)).text();
    expect(html).toContain('data-testid="jobs-route"');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('a Pad starts blank, and a later Pad can start from the screens an earlier one captured', async () => {
    const blank = await api('/api/pads', {
      method: 'POST',
      body: JSON.stringify({ name: 'Scratch', chatId: 'c1' }),
    });
    expect(blank.body.screens).toHaveLength(1);
    const lib = (await api('/api/pads/library')).body.apps as {
      app: string;
      screens: { padId: string; screenId: string }[];
    }[];
    const patch = lib.find((a) => a.app === 'Patch')!;
    expect(patch.screens.length).toBeGreaterThan(0);
    const { ctx, page } = await openApp('/app/pads/new');
    await page.getByTestId('new-pad-based-Patch').click();
    await page.getByTestId('new-pad-library').waitFor();
    expect(await page.locator('[data-testid=new-pad-library] button').count()).toBe(
      patch.screens.length,
    );
    await ctx.close();
  }, 60_000);
});
