import { test, expect } from '@playwright/test';

// patch/todo.md — "shift click is refreshing the window" (spec/14 § Links and
// the web panel). Only a real browser can prove this one: jsdom never performs
// the browser's own link handling. Unguarded, a shift-click on a router <Link>
// escapes React Router and Chromium loads the app's URL fresh — a second window
// here, and in the desktop shell a full reload of the single Patch window. The
// marker below is wiped by any document load, so it survives only if THIS page
// never navigated.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

test.describe('shift-click', () => {
  test('shift-clicking a sidebar chat row loads the app nowhere — no new window, no reload', async ({
    page,
    context,
  }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();

    const urlBefore = page.url();
    await page.evaluate(() => {
      (window as unknown as { __alive?: number }).__alive = 1;
    });

    await row.click({ modifiers: ['Shift'] });
    // Give the browser's own link handling the chance to fire before asserting
    // that it did not.
    await page.waitForTimeout(800);

    expect(context.pages()).toHaveLength(1);
    expect(await page.evaluate(() => (window as unknown as { __alive?: number }).__alive)).toBe(1);
    expect(page.url()).toBe(urlBefore);
    await expect(row).toBeVisible();
  });

  test('a plain click on the same row still opens the chat', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-row-chat_bus').click();
    await expect(page.getByTestId('chat-row-chat_bus')).toHaveClass(/active/);
  });
});
