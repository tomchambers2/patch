import { test, expect } from '@playwright/test';

// spec/14 § Batch mode — opening a chat anywhere reports it to the server
// (POST /api/batch/opened), which is how the batch ends once every ready
// member has been seen. This is a real browser so the ChatRoute mount effect
// actually fires.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('opening a chat reports it to the batch', () => {
  test('opening the chat the harness starts on calls POST /api/batch/opened', async ({ page }) => {
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
            members: ['chat_md'],
            checkedIn: true,
            openedMemberIds: [],
          },
          carryover: [],
        }),
      }),
    );
    let opened: unknown = null;
    await page.route('**/api/batch/opened', async (route) => {
      opened = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ batch: null, carryover: [] }),
      });
    });

    await page.goto(HARNESS);
    await expect.poll(() => opened).toEqual({ chatId: 'chat_md' });
  });
});
