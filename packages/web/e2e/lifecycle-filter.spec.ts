import { test, expect } from '@playwright/test';

// The Archived panel's filter box in a real browser, against the dev harness with `/api/chats?archived=only` stubbed.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

function row(chatId: string, name: string, lastUpdated: number): unknown {
  return {
    chatId,
    name,
    preview: null,
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'archived',
    pinned: false,
    pinnedAt: null,
    snoozedUntil: null,
    hidden: false,
    lastUpdated,
    daemonId: 'd1',
    permissionMode: 'auto',
    jobId: null,
    statusSummary: null,
    statusKind: null,
  };
}

// Desktop only: a phone-width web viewport has no sidebar, and the native
// phone app's Chats tab already filters every section (spec/15 § Chats tab).
{
  test('archived panel filter narrows rows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/api/chats/counts**', (route) =>
      route.fulfill({
        json: { hidden: 0, archived: 2, snoozed: 0, deleted: 0, automations: 0 },
      }),
    );
    await page.route('**/api/chats?archived=only*', (route) =>
      route.fulfill({
        json: {
          chats: [row('arch1', 'Weekly Timesheet', 2), row('arch2', 'Process Teams', 1)],
          nextOffset: null,
        },
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('archived-toggle').click();
    await expect(page.getByTestId('chat-row-arch1')).toBeVisible();
    await page.getByTestId('archived-filter').fill('teams');
    await expect(page.getByTestId('chat-row-arch2')).toBeVisible();
    await expect(page.getByTestId('chat-row-arch1')).toHaveCount(0);
    await page.getByTestId('archived-filter').fill('');
    await expect(page.getByTestId('chat-row-arch1')).toBeVisible();
  });
}
