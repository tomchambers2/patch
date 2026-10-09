import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Main chat panel — a fenced code block carries
// an icon-only copy control that really writes to the system clipboard. jsdom
// can verify the call, but not that the button is reachable (it is hidden with
// `opacity: 0` until the block is hovered), that it sits over the block's
// corner, or that a real Chromium clipboard write lands. `chat_md` is seeded
// with a fenced js block in the harness.
const MD = '/app/dev-harness.html?chat=chat_md';

const CODE = "const pods = harvest('mangetout');\nreturn pods.length;\n";

test.describe('code block copy button', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('clicking it puts the block source on the real clipboard', async ({ page }) => {
    await page.goto(MD);
    const block = page.locator('.msg-assistant .content .md-code').first();
    await expect(block).toBeVisible();
    const button = block.getByTestId('code-copy');

    // Hidden at rest, revealed by hovering the block it belongs to.
    await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await block.hover();
    await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    await button.click();
    await expect(button).toHaveAttribute('data-state', 'copied');
    await expect(button).toHaveAttribute('title', 'Copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // The code alone: no fence, no syntax-highlighting markup.
    expect(clipboard).toBe(CODE);

    // The confirmation is temporary, so the block is copyable again.
    await expect(button).toHaveAttribute('data-state', 'idle', { timeout: 5000 });
  });

  test('sits over the block corner without covering the code', async ({ page }) => {
    await page.goto(MD);
    const block = page.locator('.msg-assistant .content .md-code').first();
    await block.hover();
    const [pre, btn] = await Promise.all([
      block.locator('.md-pre').boundingBox(),
      block.getByTestId('code-copy').boundingBox(),
    ]);
    // Inside the block, hard against its top-right.
    expect(btn!.y).toBeGreaterThanOrEqual(pre!.y);
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(pre!.x + pre!.width);
    expect(pre!.x + pre!.width - (btn!.x + btn!.width)).toBeLessThan(20);
    expect(btn!.y - pre!.y).toBeLessThan(20);
  });

  test('is reachable by keyboard — focus reveals it', async ({ page }) => {
    await page.goto(MD);
    const button = page
      .locator('.msg-assistant .content .md-code')
      .first()
      .getByTestId('code-copy');
    await button.focus();
    await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('data-state', 'copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
  });

  test('inline code gets no copy button', async ({ page }) => {
    await page.goto(MD);
    await expect(page.locator('.msg-assistant .content .md-inline-code').first()).toBeVisible();
    // One fenced block in the seeded reply, one button — the inline `harvest()`
    // span adds none.
    await expect(page.locator('.msg-assistant .content [data-testid="code-copy"]')).toHaveCount(1);
  });
});
