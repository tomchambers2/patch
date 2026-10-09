import { test, expect } from '@playwright/test';

// Todoist: "patch new lines are not preserved when user sends a message".
// A user bubble goes through markdown, where a single newline is a soft break
// that renders as a space — so a multi-line message collapsed onto one line.
// Only a real browser can measure this: jsdom applies no layout.
const HARNESS = '/app/dev-harness.html?chat=chat_user_newlines';

test('single newlines in a user message render as separate lines', async ({ page }) => {
  await page.goto(HARNESS);
  const bubble = page.locator('.msg-user .content').first();
  await expect(bubble).toBeVisible();

  const lineHeight = await bubble.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  const height = await bubble
    .locator('p')
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(lineHeight * 3 - 1);
});
