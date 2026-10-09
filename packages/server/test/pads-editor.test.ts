// Pads — the editor in a REAL browser (spec/14 § Pads): Playwright drives the
// editor the server serves, desktop with a mouse and a phone-sized touch
// context, against a real listening server. Edits land in the shared store, the
// Send button delivers the batch into the owning chat, and a second browser
// looking at the same Pad sees the same pending changes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, devices as devicesT } from 'playwright';
import { generateUserKeypair } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const home = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;font:20px system-ui">
<h1 id="t" style="margin:40px 40px 20px">Credit</h1>
<p id="p" style="margin:0 40px">Some body text</p>
<button id="b" style="margin:40px;padding:12px 24px">Go</button></body></html>`;

describe('pad editor in a browser', () => {
  let dir: string;
  let browser: Browser;
  let pw: { devices: typeof devicesT };
  let built: Awaited<ReturnType<typeof buildAll>>;
  let link: InProcessDaemonLink;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-pad-e2e-'));
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    link = new InProcessDaemonLink();
    built = await buildAll({ logger: false, registry, daemonLink: link });
    link.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    pw = await import('playwright');
    browser = await pw.chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await built?.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  /** A fresh Pad (two screens) — each test owns one, so a retry never inherits state. */
  const newPad = async (): Promise<string> => {
    const requestId = `create-${++n}`;
    link.emit({
      type: 'patch.pad.request',
      requestId,
      chatId: 'c1',
      op: 'create',
      name: `Care screens ${n}`,
      files: [
        { path: 'index.html', base64: Buffer.from(home('Home')).toString('base64') },
        { path: 'other.html', base64: Buffer.from(home('Other')).toString('base64') },
      ],
    } as WireEvent);
    for (let i = 0; i < 200; i++) {
      const hit = link.sent.find(
        (x) => x.event.type === 'patch.pad.response' && x.event.requestId === requestId,
      );
      const res = hit?.event as Extract<WireEvent, { type: 'patch.pad.response' }> | undefined;
      if (res) {
        expect(res.ok).toBe(true);
        return `${base}${(res.result as { frameUrl: string }).frameUrl}`;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no pad created');
  };

  const pending = async (
    frameUrl: string,
  ): Promise<{ id: string; kind: string; status: string }[]> => {
    const r = await fetch(`${frameUrl}api`);
    return ((await r.json()) as { changes: { id: string; kind: string; status: string }[] })
      .changes;
  };

  it('desktop: dragging a box with the mouse selects what it encloses', async () => {
    const frameUrl = await newPad();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(frameUrl);
    const design = page.frameLocator('#frame');
    await design.locator('#t').waitFor();
    const box = (await design.locator('#t').boundingBox())!;
    await page.mouse.move(box.x - 30, box.y - 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await expect.poll(() => page.locator('.marquee').isVisible()).toBe(true);
    await page.mouse.move(box.x + box.width + 10, box.y + box.height + 4, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.locator('.marquee').isVisible()).toBe(false);
    await expect.poll(() => page.locator('.sel-label').textContent()).toContain('Credit');
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await pending(frameUrl)).map((c) => c.kind)).toEqual(['delete']);
    await ctx.close();
  });

  it('desktop: + adds a blank screen, opens it, and every device sees it', async () => {
    const frameUrl = await newPad();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(frameUrl);
    await page.frameLocator('#frame').locator('#t').waitFor();
    await expect.poll(() => page.locator('#screens button:not(.add-screen)').count()).toBe(2);
    await page.locator('#addScreen').click();
    await expect.poll(() => page.locator('#screens button:not(.add-screen)').count()).toBe(3);
    await expect.poll(() => page.locator('#screens button.on').textContent()).toContain('Screen 3');
    const api = (await (await fetch(`${frameUrl}api`)).json()) as { screens: { name: string }[] };
    expect(api.screens.map((x) => x.name)).toEqual(['Home', 'Other', 'Screen 3']);
    // The blank screen is editable: a note lands on it, not on another screen.
    await page.keyboard.press('n');
    await page.mouse.click(400, 300);
    await page.keyboard.type('Start here');
    await page.keyboard.press('Enter');
    const changes = (await (await fetch(`${frameUrl}api`)).json()) as {
      changes: { screen: string }[];
    };
    expect(changes.changes.map((c) => c.screen)).toEqual(['screen-3']);
    await ctx.close();
  });

  it('phone: the screen bar has a + that adds a screen', async () => {
    const frameUrl = await newPad();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(frameUrl);
    await page.frameLocator('#frame').locator('#t').waitFor();
    await page.locator('#addScreenBar').tap();
    await expect.poll(() => page.locator('#screenName').textContent()).toBe('Screen 3');
    await ctx.close();
  });

  it('desktop: select + delete, retype, note; undo; every device sees the same pending changes; Send delivers', async () => {
    const frameUrl = await newPad();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(frameUrl);
    const design = page.frameLocator('#frame');
    await design.locator('#t').waitFor();
    // The screen list is there for a two-screen pad.
    await expect.poll(() => page.locator('#screens button:not(.add-screen)').count()).toBe(2);

    // Select tool: click the heading, delete it.
    const box = (await design.locator('#t').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await pending(frameUrl)).map((c) => c.kind)).toEqual(['delete']);
    await expect.poll(() => page.locator('#count').textContent()).toBe('1');

    // Note tool: tap anywhere and type.
    await page.keyboard.press('n');
    const pbox = (await design.locator('#p').boundingBox())!;
    await page.mouse.click(pbox.x + 40, pbox.y + 5);
    await page.keyboard.type('Make this bigger');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await pending(frameUrl)).map((c) => c.kind))
      .toEqual(['delete', 'note']);

    // A second browser on the same Pad sees both, without any reload of ours.
    const other = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    await other.goto(frameUrl);
    await expect.poll(() => other.locator('#count').textContent()).toBe('2');

    // Undo from the changes list.
    await page.locator('#pending li:last-child button').click();
    await expect.poll(async () => (await pending(frameUrl)).length).toBe(1);

    // Send: the batch lands in the owning chat with a picture for the change.
    await page.locator('#send').click();
    await expect.poll(() => page.locator('#history li').count(), { timeout: 30_000 }).toBe(1);
    const input = link.sent.filter((s) => s.event.type === 'chat.input').at(-1)!.event as Extract<
      WireEvent,
      { type: 'chat.input' }
    >;
    expect(input.chatId).toBe('c1');
    expect(input.message).toContain('Deleted h1#t "Credit"');
    expect(input.message).toMatch(/picture: http:\/\/127\.0\.0\.1:\d+\/api\/padx\/.+\.png/);
    await expect
      .poll(() => page.locator('#history .waiting').textContent())
      .toBe('Waiting for the chat');
    await ctx.close();
    await other.context().close();
  }, 90_000);

  it('phone: a touch context drives the same editor, with the ‹ › screen bar', async () => {
    const frameUrl = await newPad();
    const ctx = await browser.newContext({ ...pw.devices['Pixel 7'] });
    const page = await ctx.newPage();
    await page.goto(frameUrl);
    await page.frameLocator('#frame').locator('#t').waitFor();
    await expect.poll(() => page.locator('#screenBar').isVisible()).toBe(true);
    await expect.poll(() => page.locator('#screenName').textContent()).toBe('Home');
    await page.locator('#nextScreen').tap();
    await expect.poll(() => page.locator('#screenName').textContent()).toBe('Other');
    // The new-screen dot is for screens not yet visited.
    await expect.poll(() => page.locator('#screens button.on').count(), { timeout: 5000 }).toBe(1);
    await ctx.close();
  }, 60_000);

  it('View mode lets the design behave as itself; Edit puts the tools over it', async () => {
    const frameUrl = await newPad();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(frameUrl);
    await page.frameLocator('#frame').locator('#t').waitFor();
    await page.locator('[data-mode=view]').click();
    await expect.poll(() => page.locator('#editTools').isVisible()).toBe(false);
    await page.locator('[data-mode=edit]').click();
    await expect.poll(() => page.locator('#editTools').isVisible()).toBe(true);
    await ctx.close();
  }, 30_000);
});
