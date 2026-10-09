import { test, expect } from '@playwright/test';

// spec/14 § Batch mode — "a member can be removed with the row's ×, which
// only drops it from the batch — the chat itself is untouched." There is no
// per-row sidebar toggle any more (membership is automatic); this is the one
// removal path left.

const HARNESS = '/app/dev-harness.html';

test.describe('removing a batch member', () => {
  test('the × drops the row from the batch panel, leaving the chat itself alone', async ({
    page,
  }) => {
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
            members: ['chat_bus'],
            checkedIn: false,
            openedMemberIds: [],
          },
          carryover: [],
        }),
      }),
    );
    let removed = false;
    await page.route('**/api/batch/members/chat_bus', async (route) => {
      removed = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ batch: null, carryover: [] }),
      });
    });

    await page.goto(HARNESS);
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();
    await expect(page.getByTestId('batch-row-chat_bus')).toBeVisible();

    await page.getByTestId('batch-remove-chat_bus').click();

    expect(removed).toBe(true);
    await expect(page.getByTestId('batch-row-chat_bus')).toHaveCount(0);
    await expect(page.getByTestId('batch-empty')).toBeVisible();

    // The chat itself is untouched — still a normal row in the regular list.
    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-all').click();
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
  });
});
