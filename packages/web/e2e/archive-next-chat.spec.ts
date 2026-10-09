import { test, expect } from '@playwright/test';

// spec/04 § Lifecycle — archiving the chat you are reading takes it off the
// active list AND moves you on to the next row. Real browser, real Sidebar +
// ChatRoute (dev harness, no backend), so this proves the list the user sees is
// the list the navigation walks. The archive POST is stubbed at the network
// edge; without a 200 the optimistic flip would revert and the row return.
const HARNESS = '/app/dev-harness.html';

test.describe('archiving the open chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/chats/*/archive', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
  });

  test('drops the row and opens the next chat in the list', async ({ page }) => {
    await page.goto(HARNESS);
    // The drawn order of the active list, top to bottom.
    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(1);
    const [open, next] = ids as [string, string];

    await page.goto(`${HARNESS}?chat=${open}`);
    await expect(page.getByTestId(`chat-row-${open}`)).toHaveClass(/active/);

    await page.getByTestId('action-archive').click();

    // Gone from the active list…
    await expect(page.getByTestId(`chat-row-${open}`)).toHaveCount(0);
    // …and the next row down is the one now open.
    await expect(page.getByTestId(`chat-row-${next}`)).toHaveClass(/active/);
  });
});
