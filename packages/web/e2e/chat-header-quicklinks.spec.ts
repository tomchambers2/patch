import { test, expect } from '@playwright/test';

// Files and Terminal links sit on a strip directly under the chat header's rule.
test('Files and Terminal links render just below the header', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_md');
  const head = await page.locator('.chat-head').boundingBox();
  const links = page.getByTestId('chat-quicklinks');
  await expect(links).toBeVisible();
  await expect(page.getByTestId('quicklink-files')).toHaveText('Files');
  await expect(page.getByTestId('quicklink-terminal')).toHaveText('Terminal');
  const box = await links.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
  expect(box!.y).toBeLessThan(head!.y + head!.height + 4);
});
