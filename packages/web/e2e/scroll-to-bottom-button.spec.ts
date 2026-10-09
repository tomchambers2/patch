import { test, expect } from '@playwright/test';

// Todoist: "patch add a down arrow to get back to bottom of chat"
// (spec/14 § Main chat panel — Scroll position). Mobile already has the
// floating button; the web transcript gets the same one.

const CHAT = 'chat_scroll';

test.use({ viewport: { width: 1000, height: 700 } });

test('a down arrow appears once scrolled up and returns to the latest message', async ({
  page,
}) => {
  await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
      timeout: 4000,
    })
    .toBeLessThan(5);

  const button = page.getByTestId('scroll-to-bottom');
  await expect(button).toHaveCount(0);

  await stream.hover();
  await page.mouse.wheel(0, -600);
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const sbox = (await stream.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(sbox.y + sbox.height);
  expect(box.y).toBeGreaterThanOrEqual(sbox.y);

  await button.click();
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
      timeout: 4000,
    })
    .toBeLessThan(5);
  await expect(button).toHaveCount(0);
});
