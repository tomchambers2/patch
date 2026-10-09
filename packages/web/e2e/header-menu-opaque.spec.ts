import { test, expect } from '@playwright/test';

// Todoist: "delete button has wrong z index." What Tom saw was the header's
// own bottom border (and the chat behind it) painting straight through the
// `⋯` overflow menu and the snooze menu — both used the CSS custom property
// `--bg`, which isn't a token this app defines (`--bg-app` / `--bg-panel` /
// `--bg-elevated` / `--bg-soft` are), so `var(--bg)` was invalid at computed-
// value time and silently fell back to a transparent background. It read as
// a stacking bug because content behind the menu showed through it, but the
// menu was always topmost — it just had nothing opaque painted behind its
// text. jsdom applies no stylesheet, so only a real browser can prove the
// actual painted (non-transparent) background color.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('header dropdown menus paint an opaque background', () => {
  test('the ⋯ overflow menu (Delete) is opaque, not transparent', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    const menu = page.getByTestId('head-menu');
    await expect(menu).toBeVisible();
    const bg = await menu.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');

    // The header's own bottom border must not show through: sample the pixel
    // row at the header's bottom edge, inside the menu's x-range — it should
    // read as the menu's own background colour, not the border colour.
    const sample = await page.evaluate(() => {
      const head = document.querySelector('.chat-head') as HTMLElement;
      const m = document.querySelector('[data-testid="head-menu"]') as HTMLElement;
      const headRect = head.getBoundingClientRect();
      const menuRect = m.getBoundingClientRect();
      const el = document.elementFromPoint(menuRect.x + menuRect.width / 2, headRect.bottom - 0.5);
      return el === m || (el != null && m.contains(el));
    });
    expect(sample).toBe(true);
  });

  test('the snooze menu is opaque, not transparent', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    const menu = page.getByTestId('snooze-menu');
    await expect(menu).toBeVisible();
    const bg = await menu.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });
});
