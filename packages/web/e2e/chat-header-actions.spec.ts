import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatHeader + real CSS, no backend) for
// spec/14 § Chat panel header: Archive is the direct, default header action and
// Delete is tucked into the ⋯ overflow menu.
//
// The optimistic archive flip + revert-on-failure is covered deterministically
// by the ChatHeader unit tests (there is no backend to hit here), so these
// tests cover what only a browser can show: which control is actually on the
// rail, and that the anchored menu opens, reveals Delete, and dismisses.

test.describe('chat header actions', () => {
  test('Archive is a direct icon and Delete is hidden until the ⋯ menu opens', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.locator('.chat-head')).toBeVisible();

    const archive = page.getByTestId('action-archive');
    await expect(archive).toBeVisible();
    await expect(archive).toHaveAttribute('aria-label', 'Archive chat');
    // Tooltip carries the chord (spec/14 § Discoverability), named for the
    // keyboard reading it: this Chromium runs on Linux, so the modifiers are the
    // words a PC keyboard prints rather than Apple's glyphs.
    await expect(archive).toHaveAttribute('title', 'Archive (Ctrl+Alt+A)');

    // Delete is not on the rail at all until the menu is opened.
    await expect(page.getByTestId('action-delete')).toHaveCount(0);
    await page.getByTestId('action-more').click();
    await expect(page.getByTestId('head-menu')).toBeVisible();
    await expect(page.getByTestId('action-delete')).toBeVisible();
  });

  test('the ⋯ menu dismisses on Escape and on a click off it', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    const more = page.getByTestId('action-more');

    await more.click();
    await expect(page.getByTestId('head-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('head-menu')).toHaveCount(0);

    await more.click();
    await expect(page.getByTestId('head-menu')).toBeVisible();
    await page.getByTestId('chat-title').click();
    await expect(page.getByTestId('head-menu')).toHaveCount(0);
  });

  test('the archive icon offers the way back on an archived chat', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_archived');
    const archive = page.getByTestId('action-archive');
    await expect(archive).toBeVisible();
    await expect(archive).toHaveAttribute('aria-label', 'Unarchive chat');
    await expect(archive).toHaveAttribute('aria-pressed', 'true');
  });

  // A special thread has no Archive and no Move/Snooze/Delete, but it still
  // gets the ⋯ menu — that's the only door to Tools, Disable and Clear
  // context now that Tools is no longer a direct rail icon.
  test('a special thread gets no archive, but keeps the ⋯ menu for Tools/Disable/Clear context', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=thread_manager');
    await expect(page.locator('.chat-head')).toBeVisible();
    await expect(page.getByTestId('action-archive')).toHaveCount(0);
    await page.getByTestId('action-more').click();
    await expect(page.getByTestId('action-delete')).toHaveCount(0);
    await expect(page.getByTestId('action-tools')).toBeVisible();
    await expect(page.getByTestId('action-disable')).toBeVisible();
    await expect(page.getByTestId('action-clear-context')).toBeVisible();
  });

  // spec/06 § Session rotation — the manual Clear context control only makes
  // sense for a special thread's ever-growing context; an ordinary chat's
  // equivalent is starting a new chat.
  test('Clear context is offered on a special thread but not an ordinary chat', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=thread_manager');
    await expect(page.locator('.chat-head')).toBeVisible();
    await page.getByTestId('action-more').click();
    await expect(page.getByTestId('action-clear-context')).toBeVisible();

    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.locator('.chat-head')).toBeVisible();
    await page.getByTestId('action-more').click();
    await expect(page.getByTestId('action-clear-context')).toHaveCount(0);
  });
});
