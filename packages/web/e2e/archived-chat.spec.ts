import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for
// patch/todo.md: "Archived state does not show in chat. Need a way to show it
// and unarchive it (archive should still allow sending messages)."
//
// `?chat=chat_archived` is seeded with status:'archived' in dev-harness.tsx.
// We verify the panel now SHOWS the archived state (a banner with an Unarchive
// control) and STILL offers the composer so the user can send — the optimistic
// unarchive flip + revert-on-failure is covered deterministically by the
// ChatRoute.archived integration tests (no backend to hit here).
const HARNESS = '/app/dev-harness.html?chat=chat_archived';

test.describe('archived chat panel', () => {
  test('shows an Archived banner with an Unarchive control', async ({ page }) => {
    await page.goto(HARNESS);
    const banner = page.getByTestId('archived-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Archived');
    await expect(page.getByTestId('unarchive-btn')).toBeVisible();
  });

  test('keeps the composer so an archived chat can still send', async ({ page }) => {
    await page.goto(HARNESS);
    // The composer is present (archived is NOT a read-only mirror). Sending
    // un-archives the chat (spec/04 § Lifecycle); the banner's Unarchive
    // control does the same without sending anything.
    await expect(page.getByTestId('composer')).toBeVisible();
    await expect(page.getByTestId('composer-readonly')).toHaveCount(0);
  });

  test('an ACTIVE chat shows no archived banner', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('archived-banner')).toHaveCount(0);
  });
});
