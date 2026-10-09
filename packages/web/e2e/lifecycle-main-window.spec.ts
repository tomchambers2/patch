import { test, expect } from '@playwright/test';

// App Updates: "can also open in main window" — a non-empty, opened
// cold-storage section (Hidden / Archived / Snoozed / Deleted / Automations)
// grows a small head with a link into the same section at `/lifecycle/:kind`
// (spec/14 § Sidebar item 6, § Routes). Real-browser: the head's presence
// depends on the server count, which only a real fetch stub can drive end to
// end through the sidebar's own render path.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

async function stubArchived(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/chats/counts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hidden: 0, archived: 2, snoozed: 0, deleted: 0, automations: 0 }),
    }),
  );
  await page.route('**/api/chats?archived=include', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        chats: [
          {
            chatId: 'arch_1',
            name: 'archived one',
            preview: 'preview one',
            folder: '/home/tom/projects/portfolio',
            activity: 'idle',
            status: 'archived',
            pinned: false,
            pinnedAt: null,
            lastUpdated: 2,
          },
          {
            chatId: 'arch_2',
            name: 'archived two',
            preview: 'preview two',
            folder: '/home/tom/projects/portfolio',
            activity: 'idle',
            status: 'archived',
            pinned: false,
            pinnedAt: null,
            lastUpdated: 1,
          },
        ],
      }),
    }),
  );
}

test.describe('Open a cold-storage section in the main window', () => {
  test('an opened, non-empty section grows an "open in main window" link', async ({ page }) => {
    await stubArchived(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('archived-open-main')).toHaveCount(0);
    await page.getByTestId('archived-toggle').click();
    const openMain = page.getByTestId('archived-open-main');
    await expect(openMain).toBeVisible();
    await expect(openMain).toHaveAttribute('title', 'Open in main window');
  });

  test('clicking it opens /lifecycle/archived in the main panel, with the same rows', async ({
    page,
  }) => {
    await stubArchived(page);
    await page.goto(HARNESS);
    await page.getByTestId('archived-toggle').click();
    await page.getByTestId('archived-open-main').click();

    const route = page.getByTestId('lifecycle-route');
    await expect(route).toBeVisible();
    await expect(route.locator('h1')).toHaveText('Archived');
    await expect(route.getByTestId('chat-row-arch_1')).toBeVisible();
    await expect(route.getByTestId('chat-row-arch_2')).toBeVisible();
  });

  test('the main-window route is reachable directly by URL too', async ({ page }) => {
    await stubArchived(page);
    await page.goto('/app/dev-harness.html?chat=chat_bus&route=/lifecycle/archived');
    const route = page.getByTestId('lifecycle-route');
    await expect(route).toBeVisible();
    await expect(route.locator('h1')).toHaveText('Archived');
    await expect(route.getByTestId('chat-row-arch_1')).toBeVisible();
  });

  test('an empty section grows no "open in main window" link', async ({ page }) => {
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
      }),
    );
    await page.route('**/api/chats?archived=include', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [] }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('archived-toggle').click();
    await expect(page.getByTestId('archived-section')).toBeAttached();
    await expect(page.getByTestId('archived-open-main')).toHaveCount(0);
  });
});
