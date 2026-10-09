import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real Sidebar + real CSS, no backend) for
// Todoist: "patch ability to snooze a whole workspace" — the folder header's
// third control, alongside its two archive buttons (sidebar.spec.ts).
//
// The wiring (optimistic stamp per chat, POST per chat, revert-on-failure) is
// covered deterministically by the Sidebar.test.tsx jsdom tests — there's no
// backend here. What only a real browser can prove is that the menu opens
// anchored to the folder header's clock icon, lists every preset (the same
// ones the per-chat SnoozeMenu shows), stays on screen, and dismisses.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';
// Seeded folder (see sidebar.spec.ts): /home/tom/projects/bus.
const FOLDER = '/home/tom/projects/bus';

test.describe('project snooze menu', () => {
  test('opens from the folder header with every preset, on screen', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId(`folder-snooze-${FOLDER}`).click({ force: true });
    const menu = page.getByTestId('project-snooze-menu');
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
    const box = (await menu.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  });

  test('dismisses on click-off and on Esc', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId(`folder-snooze-${FOLDER}`).click({ force: true });
    await expect(page.getByTestId('project-snooze-menu')).toBeVisible();
    await page.mouse.click(400, 500);
    await expect(page.getByTestId('project-snooze-menu')).toHaveCount(0);

    await page.getByTestId(`folder-snooze-${FOLDER}`).click({ force: true });
    await expect(page.getByTestId('project-snooze-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('project-snooze-menu')).toHaveCount(0);
  });

  test('Custom… reveals a date/time field', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId(`folder-snooze-${FOLDER}`).click({ force: true });
    await page.getByTestId('project-snooze-preset-custom').click();
    await expect(page.getByTestId('project-snooze-custom-input')).toBeVisible();
    await expect(page.getByTestId('project-snooze-custom-submit')).toBeVisible();
  });
});
