import { test, expect } from '@playwright/test';

// spec/14 § Batch mode — before check-in, members are marked only "waiting"
// (no status badge); `Check in now` moves straight to the checked-in state
// without a notification (spec/09 § Batch check-in — the user is already
// looking at the view).

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

function running() {
  return {
    id: 'b1',
    startedAt: Date.now(),
    checkIn: { type: 'time' as const, minutes: 20 },
    checkInAt: Date.now() + 20 * 60_000,
    members: ['chat_bus'],
    checkedIn: false,
    openedMemberIds: [],
  };
}

test.describe('batch view before and at check-in', () => {
  test('a member reads "waiting" only, with no status badge, before check-in', async ({ page }) => {
    await page.route('**/api/batch', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ batch: running(), carryover: [] }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();

    const row = page.getByTestId('batch-row-chat_bus');
    await expect(row).toContainText('waiting');
    await expect(row.locator('.badge')).toHaveCount(0);
  });

  test('"Check in now" calls the manual endpoint and switches to real status, with no notice', async ({
    page,
  }) => {
    await page.route('**/api/batch', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ batch: running(), carryover: [] }),
      }),
    );
    let checkedInNow = false;
    await page.route('**/api/batch/check-in-now', async (route) => {
      checkedInNow = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ batch: { ...running(), checkedIn: true }, carryover: [] }),
      });
    });
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();

    await page.getByTestId('batch-checkin-now').click();
    expect(checkedInNow).toBe(true);

    const row = page.getByTestId('batch-row-chat_bus');
    await expect(row).not.toContainText('waiting');
    await expect(page.getByTestId('batch-checkin-now')).toHaveCount(0);

    // No toast/notice of any kind fired for the manual check-in.
    await expect(page.getByTestId('error-toasts').getByRole('status')).toHaveCount(0);
  });
});
