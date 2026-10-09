import { test, expect } from '@playwright/test';

// Todoist "dropdown cut off": on a phone-sized window the new-chat model list
// opens upward (the setup row sits low), and its height was capped to the room
// above the ANCHOR rather than the room above the chat header — so the top of
// the list slid under the header and the first rows were cut off.
const NEW = '/app/dev-harness.html?chat=new';

for (const height of [600, 420, 340]) {
  test(`model list opened on a 390x${height} window stays below the header`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height });
    const models = Array.from({ length: 16 }, (_, i) => ({
      id: `model-${i}`,
      label: `Model ${i}`,
    }));
    await page.route('**/api/models*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models, fetchedAt: '2026-10-07T09:00:00.000Z' }),
      }),
    );
    await page.goto(NEW);
    await page.getByTestId('new-chat-model').click();
    const popup = page.getByTestId('model-popup');
    await expect(popup).toBeVisible();

    const head = (await page.getByTestId('chat-head').boundingBox())!;
    const box = (await popup.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(box.y + box.height).toBeLessThanOrEqual(height);

    // Capped, so the list scrolls inside itself rather than being clipped.
    const scrolls = await popup.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls).toBe(true);
  });
}
