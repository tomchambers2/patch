import { test, expect } from '@playwright/test';

// spec/14 § New windows + § Layout (desktop) — the sidebar detached into its
// own window (`/sidebar-window`) fills that window but is never drawn wider
// than the 600px ceiling the docked sidebar drags to. Uncapped it inherited
// the opener's width: at 1000px the `+ New chat` button was a 1000px black
// bar and every row's name sat an arm's length from its time.
//
// Only a real browser can see any of this — jsdom computes no layout at all,
// so the cap, and the fact that a stylesheet `max-width` still beats the
// inline `width: 100%` Sidebar sets in standalone mode, are both invisible to
// the vitest suite.

const SIDEBAR_WINDOW = '/app/dev-harness.html?route=/sidebar-window';
const MAX = 600;

test.describe('detached sidebar window — width', () => {
  test('caps the sidebar at the docked drag ceiling in a wide window', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(SIDEBAR_WINDOW);

    const sb = page.getByTestId('sidebar');
    await expect(sb).toBeVisible();
    const box = (await sb.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(MAX);

    // The controls inside it are what actually looked broken: the full-width
    // `+ New chat` button and the segmented Chats/Batch tabs stretch with the
    // sidebar, so capping it is only real if they came back with it.
    const fab = (await page.getByTestId('new-chat-fab').boundingBox())!;
    expect(fab.width).toBeLessThanOrEqual(MAX);

    // And a row's name is no longer separated from its time by most of the
    // window — the gap is a sidebar's worth, not a document's.
    const row = (await page.locator('.sb-row').first().boundingBox())!;
    expect(row.width).toBeLessThanOrEqual(MAX);
  });

  test('still fills a window narrower than the cap', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(SIDEBAR_WINDOW);
    const box = (await page.getByTestId('sidebar').boundingBox())!;
    expect(box.width).toBeCloseTo(320, 0);
  });

  test('the space past the cap is quiet panel, not a two-tone split', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(SIDEBAR_WINDOW);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const colours = await page.evaluate(() => {
      const wrapper = document.querySelector('[data-testid="sidebar-window"]')!;
      const sb = document.querySelector('[data-testid="sidebar"]')!;
      return {
        wrapper: getComputedStyle(wrapper).backgroundColor,
        sidebar: getComputedStyle(sb).backgroundColor,
        borderRight: getComputedStyle(sb).borderRightWidth,
      };
    });
    expect(colours.wrapper).toBe(colours.sidebar);
    // No hard rule down the middle of the window where the cap bites.
    expect(colours.borderRight).toBe('0px');
  });
});
