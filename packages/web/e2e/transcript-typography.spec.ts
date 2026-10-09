import { test, expect } from '@playwright/test';

// Real-browser e2e for the design-cleanup pass (spec/14 § Type): the transcript
// reads as ONE prose font — markdown headings use the body font, not Fraunces
// serif — and a model-emitted `---` is a quiet, low-opacity divider. `chat_md`
// is seeded with a heading/rule reply in the harness.
const MD = '/app/dev-harness.html?chat=chat_md';

test.describe('transcript typography', () => {
  test('markdown headings render in the body font, NOT Fraunces serif', async ({ page }) => {
    await page.goto(MD);
    const heading = page.locator('.msg-assistant .content h2').first();
    await expect(heading).toBeVisible();
    const bodyFont = await page
      .locator('.msg-assistant .content p')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    const headingFont = await heading.evaluate((el) => getComputedStyle(el).fontFamily);
    // The heading must not switch to the serif display face mid-message…
    expect(headingFont.toLowerCase()).not.toContain('fraunces');
    // …it uses the SAME family as the surrounding prose.
    expect(headingFont).toBe(bodyFont);
  });

  test('a model-emitted --- renders as a quiet, low-opacity divider', async ({ page }) => {
    await page.goto(MD);
    const hr = page.locator('.msg-assistant .content hr').first();
    await expect(hr).toBeVisible();
    const opacity = await hr.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThanOrEqual(0.6);
  });

  // todo: "Slightly bigger font." — the base body size read a touch small at
  // 15px. It floors at 16px now so the transcript prose is comfortably readable.
  test('the base body font is slightly bigger — at least 16px', async ({ page }) => {
    await page.goto(MD);
    const bodyFontSize = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).fontSize),
    );
    expect(bodyFontSize).toBeGreaterThanOrEqual(16);
    // Assistant prose inherits the base size, so it lifts too.
    const proseFontSize = await page
      .locator('.msg-assistant .content p')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(proseFontSize).toBeGreaterThanOrEqual(16);
  });
});
