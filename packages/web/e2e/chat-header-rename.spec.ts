import { test, expect } from '@playwright/test';

// spec/14 § Chat panel header → the chat name is click-to-rename in place. Real
// browser + real CSS: jsdom can assert the DOM swaps to an input, but not that
// the title is actually a visible, clickable target that stays inside the
// header once it becomes a field. The rename POST is stubbed at the network
// edge — the route itself is covered by the server + e2e suites.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('chat header — rename in place', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/chats/*/rename', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
  });

  test('clicking the name swaps it for a field seeded with the current name', async ({ page }) => {
    await page.goto(HARNESS);
    const title = page.getByTestId('chat-title');
    await expect(title).toBeVisible();
    const before = (await title.textContent())!.trim();

    const titleBox = (await title.boundingBox())!;
    expect(titleBox.height).toBeGreaterThanOrEqual(16);

    await title.click();
    const input = page.getByTestId('chat-title-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // The field stays inside the header — renaming must not reflow the layout.
    const headBox = (await page.getByTestId('chat-head').boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.y).toBeGreaterThanOrEqual(headBox.y - 1);
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(headBox.y + headBox.height + 1);

    // Esc puts the original name back, unchanged.
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.getByTestId('chat-title')).toHaveText(before);
  });

  test('typing a new name and pressing Enter renames the chat in the header', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-title').click();
    const input = page.getByTestId('chat-title-input');
    await input.fill('Bed Planner Rework');
    await page.keyboard.press('Enter');

    await expect(input).toHaveCount(0);
    await expect(page.getByTestId('chat-title')).toHaveText('Bed Planner Rework');
  });
});
