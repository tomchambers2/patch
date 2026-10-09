import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Context compression: the compaction boundary
// is one quiet line of transcript furniture that expands to its figures.
// `chat_md` is seeded with an auto compaction in the harness.
const MD = '/app/dev-harness.html?chat=chat_md';

test.describe('context compression', () => {
  test('collapsed, it is one quiet line — not a message bubble', async ({ page }) => {
    await page.goto(MD);
    const line = page.getByTestId('compaction');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-open', 'false');
    await expect(line).toContainText('Context compressed · 168k → 42k');

    // Furniture, not prose: smaller and quieter than the assistant text it sits under.
    const proseSize = await page
      .locator('.msg-assistant .content p')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const lineSize = await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(lineSize).toBeLessThan(proseSize);

    // No bubble behind it.
    const bg = await line.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');

    // It is a single line high.
    const box = await line.boundingBox();
    expect(box!.height).toBeLessThan(2 * lineSize + 12);

    // Nothing of the detail is on screen yet.
    await expect(line.locator('.tool-detail')).toHaveCount(0);
  });

  test('expanding reveals the figures behind the compression', async ({ page }) => {
    await page.goto(MD);
    const line = page.getByTestId('compaction');
    await line.locator('.tool-summary').click();

    await expect(line).toHaveAttribute('data-open', 'true');
    const detail = line.locator('.tool-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Automatic');
    await expect(detail).toContainText('168,165');
    await expect(detail).toContainText('42,118');
    await expect(detail).toContainText('3.2s');

    // And it closes again.
    await line.locator('.tool-summary').click();
    await expect(line).toHaveAttribute('data-open', 'false');
    await expect(line.locator('.tool-detail')).toHaveCount(0);
  });
});
