import { test, expect } from '@playwright/test';

// Real-browser layout check: a message containing a long unbroken string (a
// URL with no spaces) must wrap inside the message bubble, not overflow its
// right edge (todo item: "long text in a message flows over the edge of the
// message box"). `chat_long_text` seeds one such message on each of the user
// and assistant bubbles (see dev-harness.tsx).
const HARNESS = '/app/dev-harness.html?chat=chat_long_text';

test.describe('long unbroken text stays inside the message bubble', () => {
  test('a long URL in a user message does not overflow its bubble', async ({ page }) => {
    await page.goto(HARNESS);
    const bubble = page.locator('.msg-user .content').first();
    await expect(bubble).toBeVisible();

    const overflow = await bubble.evaluate((el) => el.scrollWidth - el.clientWidth);
    // scrollWidth > clientWidth means content is wider than the box — i.e. it
    // spilled past the bubble edge instead of wrapping.
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('a long URL in an assistant message does not overflow its bubble', async ({ page }) => {
    await page.goto(HARNESS);
    const bubble = page.locator('.msg-assistant .content').first();
    await expect(bubble).toBeVisible();

    const overflow = await bubble.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('the long-URL message never renders wider than the chat stream', async ({ page }) => {
    await page.goto(HARNESS);
    const stream = page.locator('.chat-stream');
    await expect(stream).toBeVisible();
    const streamBox = (await stream.boundingBox())!;

    const bubbles = page.locator('.msg .content');
    const count = await bubbles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = (await bubbles.nth(i).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(streamBox.x + streamBox.width + 1);
    }
  });
});
