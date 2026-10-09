import { test, expect } from '@playwright/test';

// The sidebar row's right-click menu in a REAL browser (todo: "patch add a
// right click context menu on a sidebar chat, for things like archive";
// spec/14 § Row context menu).
//
// jsdom cannot answer the questions that matter here: whether a real
// `contextmenu` gesture opens it, whether the menu is actually ON SCREEN (it is
// portalled out of a scrolling, clipping sidebar), whether a left-click still
// selects the row, and whether the keyboard alone can work it.
const HARNESS = '/app/dev-harness.html';

test.describe('sidebar row context menu', () => {
  test.beforeEach(async ({ page }) => {
    // Both actions the menu fires are optimistic and revert on a failed POST,
    // so without a 200 the row would flip back and read as a dead menu item.
    await page.route('**/api/chats/*/archive', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
    await page.route('**/api/chats/*/pin', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
    await page.goto(HARNESS);
  });

  async function firstRowId(page: import('@playwright/test').Page): Promise<string> {
    const id = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .first()
      .getAttribute('data-testid');
    return id!.replace('chat-row-', '');
  }

  test('right-click opens it over the sidebar, and Archive removes the row', async ({ page }) => {
    const id = await firstRowId(page);
    const row = page.getByTestId(`chat-row-${id}`);

    await row.click({ button: 'right' });
    const menu = page.getByTestId(`chat-context-menu-${id}`);
    await expect(menu).toBeVisible();

    // Portalled to the body so the scrolling, clipping sidebar cannot cut it
    // off: the menu's box has to be whole and inside the window.
    const box = (await menu.boundingBox())!;
    expect(box.width).toBeGreaterThan(100);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    const size = page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);

    await page.getByTestId(`chat-context-menu-${id}-archive`).click();
    await expect(menu).toHaveCount(0);
    await expect(row).toHaveCount(0);
    // Archiving from the menu must not ALSO follow the row's link into a chat
    // that is no longer in the list.
    expect(page.url()).not.toContain(id);
  });

  test('a plain left-click still just opens the chat', async ({ page }) => {
    const id = await firstRowId(page);
    await page.getByTestId(`chat-row-${id}`).click();
    await expect(page.getByTestId(`chat-row-${id}`)).toHaveClass(/active/);
    await expect(page.getByTestId(`chat-context-menu-${id}`)).toHaveCount(0);
  });

  test('closes on a click outside and on scrolling the list underneath', async ({ page }) => {
    const id = await firstRowId(page);
    const menu = page.getByTestId(`chat-context-menu-${id}`);

    await page.getByTestId(`chat-row-${id}`).click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);

    await page.getByTestId(`chat-row-${id}`).click({ button: 'right' });
    await expect(menu).toBeVisible();
    // Anchored to a point, not to the row — a list moving under it would leave
    // it pointing at a different chat.
    await page.locator('.sb-scroll').evaluate((el) => el.dispatchEvent(new Event('scroll')));
    await expect(menu).toHaveCount(0);
  });

  test('is operable from the keyboard alone: arrows walk it, Esc closes it and focus comes back', async ({
    page,
  }) => {
    const id = await firstRowId(page);
    const row = page.getByTestId(`chat-row-${id}`);
    await row.click({ button: 'right' });
    const menu = page.getByTestId(`chat-context-menu-${id}`);
    await expect(menu).toBeVisible();

    // Opening moves focus into the menu, at the first item.
    await expect(page.getByTestId(`chat-context-menu-${id}-open-new-tab`)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`chat-context-menu-${id}-open-to-the-side`)).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId(`chat-context-menu-${id}-delete`)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByTestId(`chat-context-menu-${id}-open-new-tab`)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test('⏎ on a focused item runs it, so the menu never needs a mouse', async ({ page }) => {
    const id = await firstRowId(page);
    await page.getByTestId(`chat-row-${id}`).click({ button: 'right' });
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`chat-context-menu-${id}-pin`)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId(`chat-context-menu-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`name-pin-${id}`)).toBeVisible();
  });
});
