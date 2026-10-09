import { test, expect } from '@playwright/test';

// spec/14 § Main chat panel — Unknown chat. Opening a chatId this surface has
// no row for used to render one line of unstyled text in the top-left of an
// otherwise blank panel, with nothing to click and nothing that ever changed.
// It is now a centred state inside the chat panel with a way back and a retry.
//
// The harness hydrates its roster at boot, so `?chat=<unseeded id>` is exactly
// the "roster landed, chat not in it" case. The by-id lookup behind it is
// stubbed here — the harness has no backend.
const MISSING = 'chat_never_seeded';
const HARNESS = `/app/dev-harness.html?chat=${MISSING}`;

test.describe('unknown chat', () => {
  test('renders centred in the chat panel with the sidebar still there', async ({ page }) => {
    await page.route(`**/api/chats/${MISSING}`, (route) =>
      route.fulfill({ status: 404, json: { error: `chat not found: ${MISSING}` } }),
    );
    await page.goto(HARNESS);

    const panel = page.getByTestId('chat-main-empty');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Chat not found')).toBeVisible();

    // The app chrome is intact: the sidebar is still beside it, so there is
    // always a route to another chat.
    await expect(page.locator('.sb')).toBeVisible();

    // Centred in the panel, not pinned to its top-left corner — the actual
    // complaint. Compare the block's centre against the panel's.
    const block = panel.locator('.chat-missing');
    const [panelBox, blockBox] = await Promise.all([panel.boundingBox(), block.boundingBox()]);
    if (!panelBox || !blockBox) throw new Error('missing layout box');
    const panelMidY = panelBox.y + panelBox.height / 2;
    const blockMidY = blockBox.y + blockBox.height / 2;
    const panelMidX = panelBox.x + panelBox.width / 2;
    const blockMidX = blockBox.x + blockBox.width / 2;
    expect(Math.abs(blockMidY - panelMidY)).toBeLessThan(4);
    expect(Math.abs(blockMidX - panelMidX)).toBeLessThan(4);
  });

  test('Back to Manager lands on the Manager thread', async ({ page }) => {
    await page.route(`**/api/chats/${MISSING}`, (route) =>
      route.fulfill({ status: 404, json: { error: `chat not found: ${MISSING}` } }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('chat-missing-manager').click();
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.locator('.chat-head-title')).toContainText('Manager');
  });

  test('Retry re-asks the server and opens the chat when it turns up', async ({ page }) => {
    // Flipped by the test, not counted: the harness runs under StrictMode, so
    // the lookup effect fires twice per attempt and a request COUNT would
    // "succeed" on the second half of the very first attempt.
    let found = false;
    let attempts = 0;
    await page.route(`**/api/chats/${MISSING}`, (route) => {
      attempts += 1;
      if (!found) {
        return route.fulfill({ status: 404, json: { error: `chat not found: ${MISSING}` } });
      }
      return route.fulfill({
        status: 200,
        json: {
          chatId: MISSING,
          name: 'found-on-retry',
          preview: null,
          goal: null,
          reminder: null,
          pendingWake: null,
          todos: [],
          daemonId: 'd1',
          folder: '/home/tom/projects/old',
          activity: 'idle',
          permissionMode: 'auto',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
          jobId: null,
        },
      });
    });
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-missing-retry')).toBeVisible();
    const before = attempts;
    found = true;
    await page.getByTestId('chat-missing-retry').click();
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.locator('.chat-head-title')).toContainText('found-on-retry');
    expect(attempts).toBeGreaterThan(before);
  });

  test('a lookup failure that is not a 404 reports itself, and stays retryable', async ({
    page,
  }) => {
    await page.route(`**/api/chats/${MISSING}`, (route) =>
      route.fulfill({ status: 503, json: { error: 'daemon_timeout' } }),
    );
    await page.goto(HARNESS);
    const panel = page.getByTestId('chat-main-empty');
    await expect(panel.getByText('Could not load this chat')).toBeVisible();
    await expect(page.getByTestId('chat-missing-detail')).toHaveText('daemon_timeout');
    await expect(panel.getByText('Chat not found')).toHaveCount(0);
    await expect(page.getByTestId('chat-missing-retry')).toBeVisible();
    await expect(page.getByTestId('chat-missing-manager')).toBeVisible();
  });
});
