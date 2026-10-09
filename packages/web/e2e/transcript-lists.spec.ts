import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Breathing room → "List markers are visible".
// The app imports a CSS reset that sets `list-style: none` on every `ul`/`ol`,
// so a model-written list rendered as unlabelled lines — the markup was right
// and only the marker was missing, which is invisible to jsdom. `chat_md` is
// seeded with a bullet list (with a nested item) and a numbered list.
const MD = '/app/dev-harness.html?chat=chat_md';

test.describe('transcript lists', () => {
  test('a bullet list keeps its bullets', async ({ page }) => {
    await page.goto(MD);
    const ul = page.locator('.msg-assistant .content ul').first();
    await expect(ul).toBeVisible();
    const marker = await ul.evaluate((el) => getComputedStyle(el).listStyleType);
    expect(marker).not.toBe('none');
    expect(marker).toBe('disc');
  });

  test('a nested bullet list is marked differently from its parent', async ({ page }) => {
    await page.goto(MD);
    const nested = page.locator('.msg-assistant .content ul ul').first();
    await expect(nested).toBeVisible();
    const [outer, inner] = await Promise.all([
      page
        .locator('.msg-assistant .content ul')
        .first()
        .evaluate((el) => getComputedStyle(el).listStyleType),
      nested.evaluate((el) => getComputedStyle(el).listStyleType),
    ]);
    expect(inner).not.toBe('none');
    // Depth reads as depth: the browser's own circle/square progression, so a
    // sub-point isn't drawn identically to the point it hangs off.
    expect(inner).not.toBe(outer);
  });

  test('a numbered list keeps its numbers', async ({ page }) => {
    await page.goto(MD);
    const ol = page.locator('.msg-assistant .content ol').first();
    await expect(ol).toBeVisible();
    const marker = await ol.evaluate((el) => getComputedStyle(el).listStyleType);
    expect(marker).not.toBe('none');
    expect(marker).toBe('decimal');
  });

  test('the marker sits in the list indent rather than off the edge', async ({ page }) => {
    await page.goto(MD);
    const ul = page.locator('.msg-assistant .content ul').first();
    const { position, padding } = await ul.evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.listStylePosition, padding: parseFloat(s.paddingLeft) };
    });
    // An `outside` marker is painted in the list's left padding; with no padding
    // it would be clipped by the transcript's edge and read as missing again.
    expect(position).toBe('outside');
    expect(padding).toBeGreaterThanOrEqual(16);
  });
});
