import { test, expect } from '@playwright/test';

// spec/14 § Batch mode — with no batch running, the Batch view's whole
// content is the empty-state line plus the four check-in choices. A real
// browser (dev harness, no backend): GET /api/batch is unmocked and 404s,
// which the client reads as "no batch running" — the same state a cold
// account starts in.

const HARNESS = '/app/dev-harness.html';

function openBatchView(page: import('@playwright/test').Page) {
  return async (): Promise<void> => {
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();
  };
}

test.describe('empty batch view', () => {
  test('names the way in, and offers the four check-in choices', async ({ page }) => {
    await page.goto(HARNESS);
    await openBatchView(page)();

    const empty = page.getByTestId('batch-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Nothing batched');
    await expect(empty).toContainText('press Batch to start one');

    await expect(page.getByTestId('batch-start-15')).toBeVisible();
    await expect(page.getByTestId('batch-start-20')).toBeVisible();
    await expect(page.getByTestId('batch-start-30')).toBeVisible();
    await expect(page.getByTestId('batch-start-all-done')).toBeVisible();
  });

  test('pressing a check-in choice posts it, and the view switches to the running batch', async ({
    page,
  }) => {
    let posted: unknown = null;
    await page.route('**/api/batch/start', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          batch: {
            id: 'b1',
            startedAt: Date.now(),
            checkIn: { type: 'time', minutes: 20 },
            checkInAt: Date.now() + 20 * 60_000,
            members: [],
            checkedIn: false,
            openedMemberIds: [],
          },
          carryover: [],
        }),
      });
    });
    await page.goto(HARNESS);
    await openBatchView(page)();

    await page.getByTestId('batch-start-20').click();

    expect(posted).toEqual({ checkIn: { type: 'time', minutes: 20 } });
    await expect(page.getByTestId('batch-checkin-time')).toBeVisible();
    await expect(page.getByTestId('batch-empty')).toHaveCount(0);
  });
});
