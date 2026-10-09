import { test, expect } from '@playwright/test';

// spec/14 § Batch mode — the "When all done" check-in choice sends
// `{type:'all-done'}` with no minutes; once checked in, members list by real
// status, done first.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('"When all done" and post-check-in ordering', () => {
  test('pressing "When all done" posts the all-done choice', async ({ page }) => {
    let posted: unknown = null;
    await page.route('**/api/batch/start', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          batch: {
            id: 'b1',
            startedAt: 0,
            checkIn: { type: 'all-done' },
            checkInAt: 30 * 60_000,
            members: [],
            checkedIn: false,
            openedMemberIds: [],
          },
          carryover: [],
        }),
      });
    });
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();

    await page.getByTestId('batch-start-all-done').click();

    expect(posted).toEqual({ checkIn: { type: 'all-done' } });
    await expect(page.getByTestId('batch-checkin-time')).toContainText('when all done');
  });

  test('after check-in, a done member sorts before a working one', async ({ page }) => {
    await page.route('**/api/batch', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          batch: {
            id: 'b1',
            startedAt: 0,
            checkIn: { type: 'time', minutes: 20 },
            checkInAt: 20 * 60_000,
            // chat_bus is a working chat in the harness fixtures; chat_md is idle.
            members: ['chat_bus', 'chat_md'],
            checkedIn: true,
            openedMemberIds: [],
          },
          carryover: [],
        }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();

    const rows = page.locator('[data-testid^="batch-row-"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'batch-row-chat_md');
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'batch-row-chat_bus');
  });
});
