import { test, expect } from '@playwright/test';

// Real-browser check for spec/14 § Messages — Long user messages collapse
// (accordion): a long user turn renders clamped by default with a chevron
// toggle beneath it; clicking expands it in place. `chat_long_user_message`
// seeds one long user turn, one long assistant reply (must NOT collapse) and
// one short user turn (must NOT collapse) — see dev-harness.tsx.
const HARNESS = '/app/dev-harness.html?chat=chat_long_user_message';

test.describe('a long user message collapses behind an accordion toggle', () => {
  test('the long user message renders collapsed with a visibly clamped height', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const bubbles = page.locator('.msg-user');
    await expect(bubbles.first()).toBeVisible();

    const longMsg = bubbles.first();
    await expect(longMsg).toHaveClass(/collapsible/);
    await expect(longMsg).toHaveClass(/collapsed/);

    const content = longMsg.locator('.content').first();
    const scrollH = await content.evaluate((el) => el.scrollHeight);
    const clientH = await content.evaluate((el) => el.clientHeight);
    // Clamped: the real content is taller than the box showing it.
    expect(scrollH).toBeGreaterThan(clientH);
  });

  test('clicking the toggle expands the message to its full height, and collapses it back', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const longMsg = page.locator('.msg-user').first();
    const toggle = longMsg.locator('[data-testid="msg-collapse-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    const content = longMsg.locator('.content').first();
    const collapsedHeight = (await content.boundingBox())!.height;

    await toggle.click();
    await expect(longMsg).not.toHaveClass(/collapsed/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const expandedHeight = (await content.boundingBox())!.height;
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);

    await toggle.click();
    await expect(longMsg).toHaveClass(/collapsed/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('a short user message and a long assistant reply never collapse', async ({ page }) => {
    await page.goto(HARNESS);

    const userBubbles = page.locator('.msg-user');
    await expect(userBubbles).toHaveCount(2);
    const shortMsg = userBubbles.nth(1);
    await expect(shortMsg).not.toHaveClass(/collapsible/);
    await expect(shortMsg.locator('[data-testid="msg-collapse-toggle"]')).toHaveCount(0);

    const assistantMsg = page.locator('.msg-assistant').first();
    await expect(assistantMsg).not.toHaveClass(/collapsible/);
    await expect(assistantMsg.locator('[data-testid="msg-collapse-toggle"]')).toHaveCount(0);
  });
});
