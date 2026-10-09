import { test, expect } from '@playwright/test';

// Todoist "triangle is tiny in patch": the failed-summary marker on a
// "Ran N commands" row was the ⚠ text glyph, which rendered as a speck. It is
// now a drawn icon and must be visibly sized next to the summary text.
test('the failed-summary triangle is a drawn icon, not a speck', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_tools_failed');
  await page.waitForFunction(() => '__store' in window);
  await page.evaluate(() => {
    const w = window as unknown as {
      __store: { getState: () => { applyEvent: (e: unknown) => void } };
    };
    w.__store.getState().applyEvent({
      type: 'chat.tool_run_summary',
      chatId: 'chat_tools_failed',
      callIds: ['f1', 'f2'],
      seq: 6,
      summary: null,
      error: 'no credit',
    });
  });
  const marker = page.locator('[data-testid="tool-group-summary-failed"]');
  await expect(marker).toBeVisible();
  const svg = marker.locator('svg');
  await expect(svg).toHaveCount(1);
  const box = await svg.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(16);
  expect(box!.height).toBeGreaterThanOrEqual(16);
});
