import { test, expect } from '@playwright/test';

// Sidebar ordering is chosen from the view menu and sticks across reloads.
const HARNESS = '/app/dev-harness.html';

test('sort choice is offered in the view menu and persists', async ({ page }) => {
  await page.goto(HARNESS);
  await page.getByTestId('sidebar-view-trigger').click();
  await expect(page.getByTestId('sidebar-chat-sort-last-action')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('sidebar-chat-sort-name').click();
  await page.getByTestId('sidebar-group-sort-last-update').click();
  await page.reload();
  await page.getByTestId('sidebar-view-trigger').click();
  await expect(page.getByTestId('sidebar-chat-sort-name')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sidebar-group-sort-last-update')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
