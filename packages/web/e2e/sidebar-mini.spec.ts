import { test, expect } from '@playwright/test';

// Mini sidebar (Todoist, Patch Updates): narrowing the sidebar past its
// minimum turns it into a rail of status dots, so the user can move up and
// down the chats while the rest of the screen is something else.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('mini sidebar', () => {
  test('dragging the divider narrow shows a dot rail; dragging out restores the full sidebar', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();
    const box = (await page.getByTestId('sidebar-divider').boundingBox())!;
    const y = box.y + box.height / 2;

    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(60, y, { steps: 8 });
    await page.mouse.up();

    await expect(sidebar).toHaveCount(0);
    const mini = page.getByTestId('mini-sidebar');
    await expect(mini).toBeVisible();
    expect((await mini.boundingBox())!.width).toBeLessThan(80);
    const rows = page.locator('[data-testid^="mini-row-"]');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(page.getByTestId('mini-row-chat_bus')).toHaveClass(/active/);

    await page.getByTestId('mini-expand').click();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(mini).toHaveCount(0);
  });

  test('clicking a dot opens that chat', async ({ page }) => {
    await page.goto(HARNESS);
    await page.evaluate(() => localStorage.setItem('patch.layout.sidebarMini', 'true'));
    await page.reload();
    const rows = page.locator('[data-testid^="mini-row-"]:not(.active)');
    const first = rows.first();
    const id = (await first.getAttribute('data-testid'))!.replace('mini-row-', '');
    await first.click();
    await expect(page.getByTestId(`mini-row-${id}`)).toHaveClass(/active/);
  });
});
