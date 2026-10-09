import { test, expect } from '@playwright/test';

// spec/02 § Permission mode, spec/14 § Main chat panel — where the user changed
// the chat's permission mode, drawn in the transcript as one quiet rule rather
// than a message. Only a real browser can settle the two things that matter
// about it: that it is a divider spanning the stream, and that it sits between
// the turns it separates.

test.describe('permission-mode change line', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_perm_mode');
    await expect(page.getByTestId('permission-mode-change')).toBeVisible();
  });

  test('names the mode with the agent’s own word for it', async ({ page }) => {
    await expect(page.getByTestId('permission-mode-change')).toHaveText(
      'Permission mode → acceptEdits',
    );
  });

  test('sits between the turn before it and the turn after it', async ({ page }) => {
    const line = await page.getByTestId('permission-mode-change').boundingBox();
    const before = await page.getByText('No UK spares exist for it.').boundingBox();
    const after = await page.getByText('try the repair cafés then').boundingBox();
    expect(before!.y + before!.height).toBeLessThanOrEqual(line!.y);
    expect(line!.y + line!.height).toBeLessThanOrEqual(after!.y);
  });

  test('is a rule across the stream, not a bubble', async ({ page }) => {
    const line = page.getByTestId('permission-mode-change');
    // The rules either side are ::before / ::after, so measure the drawn width
    // against the stream it divides rather than looking for elements.
    const box = (await line.boundingBox())!;
    const stream = (await page.locator('.chat-stream-content').boundingBox())!;
    expect(box.width).toBeGreaterThan(stream.width * 0.8);
    const label = (await line.locator('.mode-change-label').boundingBox())!;
    expect(label.width).toBeLessThan(box.width / 2);
    // Quiet: smaller than body text, and no panel fill behind it.
    const style = await line.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { size: parseFloat(cs.fontSize), bg: cs.backgroundColor };
    });
    expect(style.size).toBeLessThanOrEqual(13);
    expect(style.bg).toBe('rgba(0, 0, 0, 0)');
  });

  test('carries no expandable detail — the line is the whole fact', async ({ page }) => {
    await expect(page.getByTestId('permission-mode-change').locator('button')).toHaveCount(0);
  });
});

// spec/02 § Permission mode's plan-mode exception — Claude Code landing a chat
// on `plan` itself (the mode it was given is unavailable to this host/model)
// is not an error: it gets the SAME quiet rule a person's own switch does,
// just naming who actually made the change.
test.describe('an automatic (Claude Code) permission-mode change', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_perm_mode_auto');
    await expect(page.getByTestId('permission-mode-change')).toBeVisible();
  });

  test('reads as an info line, not an error — and names Claude Code', async ({ page }) => {
    await expect(page.getByTestId('permission-mode-change')).toHaveText(
      'Permission mode → plan (set by Claude Code)',
    );
    await expect(page.locator('.chat-error, [data-testid="chat-error"]')).toHaveCount(0);
  });

  test('is the same quiet furniture row as a person’s own switch — no bubble, no button', async ({
    page,
  }) => {
    const line = page.getByTestId('permission-mode-change');
    await expect(line.locator('button')).toHaveCount(0);
    const style = await line.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(style).toBe('rgba(0, 0, 0, 0)');
  });
});
