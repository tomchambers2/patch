import { test, expect } from '@playwright/test';

// spec/14 § New windows — real-browser e2e (dev harness, no backend) for the
// three "open in new window" entry points. The dev harness has no Electron
// bridge, so every action here falls through to the ordinary browser
// `window.open` path (lib/newWindow.ts) — exactly what a plain browser tab
// user gets. `window.open('...', '_blank', ...)` is only genuinely
// exercisable in a real browser (jsdom's `window.open` is a no-op), which is
// why this lives in e2e rather than the vitest unit suite: we capture the
// real `popup` Page Playwright hands back and assert its URL.

const CHAT = '/app/dev-harness.html?chat=chat_bus';
const SPECIAL = '/app/dev-harness.html?chat=thread_manager';

test.describe('chat header — Open chat in new window', () => {
  test('sits beside the title and opens a popup at /app/chats/<id>?sidebar=hidden', async ({
    page,
  }) => {
    await page.goto(CHAT);
    const btn = page.getByTestId('action-open-window');
    await expect(btn).toBeVisible();
    // A real, tappable target.
    const box = (await btn.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(20);
    expect(box.height).toBeGreaterThanOrEqual(20);

    const [popup] = await Promise.all([page.waitForEvent('popup'), btn.click()]);
    expect(new URL(popup.url()).pathname).toBe('/app/chats/chat_bus');
    expect(new URL(popup.url()).searchParams.get('sidebar')).toBe('hidden');
    await popup.close();

    // The window that opened it stays put — same chat, same URL.
    await expect(page.locator('.chat-head')).toBeVisible();
  });

  test('is also shown, and works, for a special thread (Manager)', async ({ page }) => {
    await page.goto(SPECIAL);
    const btn = page.getByTestId('action-open-window');
    await expect(btn).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), btn.click()]);
    expect(new URL(popup.url()).pathname).toBe('/app/chats/thread_manager');
    await popup.close();
  });

  // spec/14 § Chat panel header — it sits beside the title, not in the
  // collapsible action rail, so it stays directly clickable even once the
  // rail itself has collapsed into the hamburger at narrow widths.
  test('stays directly clickable at narrow widths, even once the rail collapses into the hamburger', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(CHAT);
    await expect(page.getByTestId('head-action-rail')).not.toBeVisible();
    await expect(page.getByTestId('action-hamburger')).toBeVisible();
    const btn = page.getByTestId('action-open-window');
    await expect(btn).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), btn.click()]);
    expect(new URL(popup.url()).pathname).toBe('/app/chats/chat_bus');
    await popup.close();
  });
});

test.describe('sidebar — New chat in new window (split button)', () => {
  test('caret opens a dropdown; its item pops a new window and leaves this one on the same view', async ({
    page,
  }) => {
    await page.goto(CHAT);
    const fab = page.getByTestId('new-chat-fab');
    const toggle = page.getByTestId('new-chat-split-toggle');
    await expect(fab).toBeVisible();
    await expect(toggle).toBeVisible();
    // One segmented control: the caret abuts the main segment (hairline seam),
    // on the same line and at the same height.
    const fabBox = (await fab.boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    expect(toggleBox.x - (fabBox.x + fabBox.width)).toBeLessThanOrEqual(2);
    expect(toggleBox.y).toBeCloseTo(fabBox.y, 0);
    expect(toggleBox.height).toBeCloseTo(fabBox.height, 0);

    await expect(page.getByTestId('new-chat-split-menu')).toHaveCount(0);
    await toggle.click();
    const item = page.getByTestId('new-chat-in-new-window');
    await expect(item).toBeVisible();

    const beforeUrl = page.url();
    const [popup] = await Promise.all([page.waitForEvent('popup'), item.click()]);
    const popupUrl = new URL(popup.url());
    expect(popupUrl.pathname).toBe('/app/chats/new');
    expect(popupUrl.searchParams.get('draft')).toBeTruthy();
    expect(popupUrl.searchParams.get('sidebar')).toBe('hidden');
    await popup.close();

    expect(page.url()).toBe(beforeUrl);
    await expect(page.getByTestId('new-chat-split-menu')).toHaveCount(0);
  });

  test('the dropdown dismisses on click-off and Escape', async ({ page }) => {
    await page.goto(CHAT);
    const toggle = page.getByTestId('new-chat-split-toggle');
    await toggle.click();
    await expect(page.getByTestId('new-chat-split-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('new-chat-split-menu')).toHaveCount(0);
    await toggle.click();
    await page.mouse.click(600, 400);
    await expect(page.getByTestId('new-chat-split-menu')).toHaveCount(0);
  });

  test('the + New chat button still starts a chat directly in THIS window (unchanged behaviour)', async ({
    page,
  }) => {
    await page.goto(CHAT);
    await page.getByTestId('new-chat-fab').click();
    await expect(page.getByTestId('new-chat-main')).toBeVisible();
  });
});

test.describe('sidebar — Open sidebar in new window', () => {
  test('the brand-row icon is visible and opens /app/sidebar-window in a new window', async ({
    page,
  }) => {
    await page.goto(CHAT);
    const btn = page.getByTestId('sidebar-open-window');
    await expect(btn).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), btn.click()]);
    expect(new URL(popup.url()).pathname).toBe('/app/sidebar-window');
    await popup.close();
  });

  // spec/14 § New windows — it opens at a sidebar's width, not the opener's.
  // The size travels in `window.open`'s features string, which only a real
  // browser acts on; the resulting window is what this measures.
  test('the new window opens at a sidebar width, not the opener\u2019s', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(CHAT);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByTestId('sidebar-open-window').click(),
    ]);
    const width = await popup.evaluate(() => window.outerWidth);
    expect(width).toBeLessThan(700);
    await popup.close();
  });
});
