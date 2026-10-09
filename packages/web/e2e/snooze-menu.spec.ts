import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatHeader + real CSS, no backend) for
// patch/todo.md: "ability to snooze a chat for 2, 5, 30, 1 hour, 1 day, next
// week or custom amount of time, like in gmail".
//
// The wiring (optimistic stamp, POST, revert-on-failure) is covered
// deterministically by the ChatHeader.snooze jsdom tests — there's no backend
// here. What only a real browser can prove is that the menu opens anchored to
// the header button, lists every preset, stays on screen, and dismisses.
const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('snooze menu', () => {
  test('opens from the chat header with every preset, on screen', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    const menu = page.getByTestId('snooze-menu');
    await expect(menu).toBeVisible();
    for (const label of [
      '2 minutes',
      '5 minutes',
      '30 minutes',
      '1 hour',
      '1 day',
      'Next week',
      'Custom…',
    ]) {
      await expect(menu.getByText(label, { exact: true })).toBeVisible();
    }
    // Anchored under the button and fully inside the viewport (a menu that
    // spills off-screen is unusable).
    const box = (await menu.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  });

  test('dismisses on click-off and on Esc', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await expect(page.getByTestId('snooze-menu')).toBeVisible();
    await page.mouse.click(400, 500);
    await expect(page.getByTestId('snooze-menu')).toHaveCount(0);

    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await expect(page.getByTestId('snooze-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('snooze-menu')).toHaveCount(0);
  });

  test('Custom… reveals a date/time field', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-snooze').click();
    await page.getByTestId('snooze-preset-custom').click();
    await expect(page.getByTestId('snooze-custom-input')).toBeVisible();
    await expect(page.getByTestId('snooze-custom-submit')).toBeVisible();
  });

  test('replaces the ⋯ menu in place, showing only snooze options', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    const head = page.getByTestId('head-menu');
    await expect(page.getByTestId('action-tools')).toBeVisible();
    const before = (await head.boundingBox())!;
    await page.getByTestId('action-snooze').click();
    await expect(page.getByTestId('snooze-menu')).toBeVisible();
    // Same menu, same anchor: right edge and top do not move.
    const after = (await head.boundingBox())!;
    expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    // Nothing but snooze options is left in it.
    await expect(page.getByTestId('action-tools')).toBeHidden();
    await expect(page.getByTestId('action-snooze')).toBeHidden();
    const snooze = (await page.getByTestId('snooze-menu').boundingBox())!;
    expect(snooze.y).toBeGreaterThanOrEqual(after.y);
    expect(snooze.y + snooze.height).toBeLessThanOrEqual(after.y + after.height);
  });
});
