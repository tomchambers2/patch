import { test, expect } from '@playwright/test';
import { PIXEL_7, settingsUrl, stubSettingsApi } from './settingsHarness.js';

// spec/14 § Layout: "The shell is exactly the height of the window and the page
// itself never scrolls, whatever a route holds ... the window can never be
// dragged past the end of a route's content onto empty space."
//
// The reported bug: on /settings the window scrolled several hundred px past a
// shell that is only ever one viewport tall, so the whole app slid up and left
// blank space below content that had already ended. The cause was the real
// <input> behind each switch — `position: absolute`, so contained by its
// nearest POSITIONED ancestor; with none inside the scroll panel it escaped its
// clipping and added its own offset to the document's height. Only a real
// browser lays this out.
//
// design/settings-redesign: on a wide window the page (`.set-main`) and the nav
// (`.set-nav`) scroll separately, so the nav stays put however long a page is;
// on a phone `.settings-route` itself is the one scroller.

// Short enough that the Agent page is taller than its panel.
const DESKTOP = { width: 1280, height: 560 };

test.describe('Settings page scrolling — desktop', () => {
  test.use({ viewport: DESKTOP });

  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('agent'));
    await expect(page.getByTestId('harness-config')).toBeVisible();
  });

  test('the window has nothing to scroll — the shell is exactly one viewport tall', async ({
    page,
  }) => {
    const m = await page.evaluate(() => ({
      docScrollH: document.documentElement.scrollHeight,
      bodyScrollH: document.body.scrollHeight,
      rootScrollH: (document.getElementById('root') as HTMLElement).scrollHeight,
      vh: window.innerHeight,
    }));
    expect(m.docScrollH).toBeLessThanOrEqual(m.vh + 1);
    expect(m.bodyScrollH).toBeLessThanOrEqual(m.vh + 1);
    expect(m.rootScrollH).toBeLessThanOrEqual(m.vh + 1);
  });

  test('scrolling the window does nothing — only the page panel scrolls, the nav stays put', async ({
    page,
  }) => {
    await page.evaluate(() => window.scrollTo(0, 5000));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const navTopBefore = await page
      .getByTestId('settings-nav')
      .evaluate((el) => el.getBoundingClientRect().top);
    // …while the panel that is SUPPOSED to scroll still does, so this is not
    // passing by having frozen the page.
    const panel = await page.evaluate(() => {
      const el = document.querySelector('.set-main') as HTMLElement;
      el.scrollTop = 10_000;
      return { scrollTop: el.scrollTop, scrollH: el.scrollHeight, clientH: el.clientHeight };
    });
    expect(panel.scrollH).toBeGreaterThan(panel.clientH);
    expect(panel.scrollTop).toBeGreaterThan(0);
    // The nav is its own scroller: scrolling the page did not move it.
    const navTopAfter = await page
      .getByTestId('settings-nav')
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(navTopAfter).toBe(navTopBefore);
    await expect(page.getByTestId('settings-nav-usage')).toBeInViewport();
    // The route itself does not scroll on a wide window.
    const routeScroll = await page.evaluate(() => {
      const el = document.querySelector('.settings-route') as HTMLElement;
      return el.scrollHeight - el.clientHeight;
    });
    expect(routeScroll).toBeLessThanOrEqual(1);
  });

  test('the page panel stops scrolling where its content stops', async ({ page }) => {
    const gap = await page.evaluate(() => {
      const el = document.querySelector('.set-main') as HTMLElement;
      const top = el.getBoundingClientRect().top;
      let lastBottom = 0;
      for (const kid of Array.from(el.children)) {
        const b = kid.getBoundingClientRect().bottom + el.scrollTop - top;
        if (b > lastBottom) lastBottom = b;
      }
      const pad = parseFloat(getComputedStyle(el).paddingBottom);
      return { over: el.scrollHeight - lastBottom, pad };
    });
    // Whatever is scrollable past the last group is the panel's own bottom
    // padding and nothing else — no phantom tail.
    expect(gap.over).toBeLessThanOrEqual(gap.pad + 30);
  });

  for (const p of ['usage', 'agent', 'mcp', 'memories', 'manager']) {
    test(`${p}: a switch's hidden input is contained by the switch, not by the shell`, async ({
      page,
    }) => {
      await page.goto(settingsUrl(p));
      await expect(page.locator('.set-page')).toBeVisible();
      const offenders = await page.evaluate(() => {
        const bad: string[] = [];
        document.querySelectorAll('.settings-route .toggle-input').forEach((el) => {
          let p = el.parentElement;
          let containing: Element | null = null;
          while (p) {
            if (getComputedStyle(p).position !== 'static') {
              containing = p;
              break;
            }
            p = p.parentElement;
          }
          if (!containing || !containing.classList.contains('toggle')) {
            bad.push(
              `${el.getAttribute('data-testid') ?? '(no testid)'} -> ${containing?.tagName ?? 'none'}.${containing?.className ?? ''}`,
            );
          }
        });
        return bad;
      });
      expect(offenders).toEqual([]);
      const docH = await page.evaluate(() => document.documentElement.scrollHeight);
      expect(docH).toBeLessThanOrEqual(DESKTOP.height + 1);
    });
  }
});

test.describe('Settings page scrolling — phone', () => {
  test.use(PIXEL_7);

  test('the window never scrolls; the settings route is the one scroller', async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('agent'));
    await expect(page.getByTestId('harness-config')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 5000));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const m = await page.evaluate(() => {
      const el = document.querySelector('.settings-route') as HTMLElement;
      el.scrollTop = 10_000;
      return {
        scrollTop: el.scrollTop,
        docH: document.documentElement.scrollHeight,
        vh: window.innerHeight,
      };
    });
    expect(m.scrollTop).toBeGreaterThan(0);
    expect(m.docH).toBeLessThanOrEqual(m.vh + 1);
  });
});
