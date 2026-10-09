import { test, expect } from '@playwright/test';

// spec/14 § Batch mode — "the option carries a count badge of the current
// membership when non-zero". The batch is server-owned, so the count is
// whatever `GET /api/batch` last reported — polled live (spec/14 § Batch
// mode), not derived from anything persisted client-side.

const HARNESS = '/app/dev-harness.html';

function batchResponse(members: string[], over: Record<string, unknown> = {}) {
  return {
    batch: {
      id: 'b1',
      startedAt: 0,
      checkIn: { type: 'time', minutes: 20 },
      checkInAt: 20 * 60_000,
      members,
      checkedIn: false,
      openedMemberIds: [],
      ...over,
    },
    carryover: [],
  };
}

test.describe('Batch option count', () => {
  test('shows no badge with no batch running', async ({ page }) => {
    await page.route('**/api/batch', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ batch: null, carryover: [] }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await expect(page.getByTestId('sidebar-view-batch-count')).toHaveCount(0);
  });

  test('reflects the server membership count, and updates on the next poll', async ({ page }) => {
    let members = ['a'];
    await page.route('**/api/batch', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(batchResponse(members)),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await expect(page.getByTestId('sidebar-view-batch-count')).toHaveText('1');

    // A later poll tick sees a second member.
    members = ['a', 'b'];
    await page.evaluate(() => {
      (
        window as unknown as { __batchStore: { getState: () => { refresh(): Promise<void> } } }
      ).__batchStore
        .getState()
        .refresh();
    });
    await expect(page.getByTestId('sidebar-view-batch-count')).toHaveText('2');
  });
});
