import { test, expect } from '@playwright/test';

// Todoist, App Updates: "for chat tools, tools should show in its own sidebar
// on right hand side. the button should be on the normal button rail top
// right." Tools has been in three places: a full-viewport modal, then a
// takeover of the LEFT sidebar body driven from a slim right-hand icon rail,
// then an ordinary chat header action rail icon. It is now its own right-hand
// sidebar column, opened from the header's ⋯ overflow menu (spec/14 § Tools
// panel, § Chat panel header).

const HARNESS = '/app/dev-harness.html?chat=chat_md';

function openTools(page: import('@playwright/test').Page): Promise<void> {
  return (async () => {
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-tools').click();
  })();
}

test.describe('Tools opens in its own right-hand sidebar', () => {
  test('the Tools trigger is in the ⋯ overflow menu, not a separate toolbar', async ({ page }) => {
    await page.goto(HARNESS);

    await expect(page.getByTestId('action-tools')).toHaveCount(0);
    await page.getByTestId('action-more').click();
    await expect(page.getByTestId('head-menu').getByTestId('action-tools')).toBeVisible();

    // The dedicated right-hand icon rail is gone entirely.
    await expect(page.getByTestId('right-toolbar')).toHaveCount(0);
  });

  test('opening Tools renders its own column to the right of the chat', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);

    const panel = page.getByTestId('tools-panel');
    await expect(panel).toBeVisible();

    // Its own column, NOT inside the left sidebar.
    await expect(page.getByTestId('sidebar').getByTestId('tools-panel')).toHaveCount(0);

    // Sits to the right of the chat panel, and the left sidebar keeps its own
    // content (the chat list) rather than being taken over.
    const panelBox = (await panel.boundingBox())!;
    const chatBox = (await page.getByTestId('chat-main').boundingBox())!;
    expect(panelBox.x).toBeGreaterThan(chatBox.x);
    await expect(page.getByTestId('sidebar-view-menu')).toBeVisible();
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();

    // No modal backdrop/overlay — the chat stays visible and interactive.
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
    await expect(page.getByTestId('tools-panel-backdrop')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });

  test('dragging the divider left widens the column', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);

    const panel = page.getByTestId('tools-panel');
    const before = (await panel.boundingBox())!;
    const divider = (await page.getByTestId('tools-divider').boundingBox())!;
    const x = divider.x + divider.width / 2;
    const y = divider.y + divider.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await page.mouse.up();

    const after = (await panel.boundingBox())!;
    expect(Math.round(after.width)).toBe(Math.round(before.width) + 100);
  });

  test('the tool inventory renders inline and a toggle still works', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);

    const bash = page.getByTestId('tool-toggle-Bash');
    await expect(bash).toBeChecked();
    await bash.click({ force: true });
    await expect(bash).not.toBeChecked();
  });

  test('approval mode is not in this panel — it lives in the composer', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);

    await expect(page.getByTestId('tools-panel')).toBeVisible();
    await expect(page.getByTestId('tools-panel').getByTestId('permission-mode')).toHaveCount(0);
    await expect(page.getByTestId('composer').getByTestId('permission-mode')).toBeVisible();
  });

  test('closing (close button, then Escape) removes the column', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);
    await expect(page.getByTestId('tools-panel')).toBeVisible();

    await page.getByTestId('tools-panel-close').click();
    await expect(page.getByTestId('tools-panel')).toHaveCount(0);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();

    await openTools(page);
    await expect(page.getByTestId('tools-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tools-panel')).toHaveCount(0);
  });
});

// spec/14 § Tools panel — the panel belongs to the chat it was opened for, so
// leaving that chat closes it. Left standing, its switches would be writing the
// OFF set of a chat that is no longer on screen.
test.describe('Tools closes when its chat leaves the screen', () => {
  test('opening another chat from the sidebar removes the column', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);
    await expect(page.getByTestId('tools-panel')).toBeVisible();

    await page.getByTestId('chat-row-chat_bus').click();
    await expect(page.getByTestId('tools-panel')).toHaveCount(0);

    // And the chat that IS open can open its own Tools.
    await openTools(page);
    await expect(page.getByTestId('tools-panel')).toBeVisible();
  });

  for (const link of ['Settings', 'Jobs']) {
    test(`going to ${link} removes the column`, async ({ page }) => {
      await page.goto(HARNESS);
      await openTools(page);
      await expect(page.getByTestId('tools-panel')).toBeVisible();

      await page.getByTestId('bottom-nav').getByRole('link', { name: link }).click();
      await expect(page.getByTestId('tools-panel')).toHaveCount(0);
    });
  }

  test('starting a new chat removes the column', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);
    await expect(page.getByTestId('tools-panel')).toBeVisible();

    await page.getByTestId('new-chat-row').click();
    await expect(page.getByTestId('tools-panel')).toHaveCount(0);
  });

  // The left sidebar's view switch (spec/14 § Sidebar §1b) does not change
  // which chat is open, and the spec has the left sidebar keep whichever view
  // it is showing.
  test('switching the left sidebar to Batch and back leaves it open', async ({ page }) => {
    await page.goto(HARNESS);
    await openTools(page);
    await expect(page.getByTestId('tools-panel')).toBeVisible();

    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-batch').click();
    await expect(page.getByTestId('tools-panel')).toBeVisible();

    await page.getByTestId('sidebar-view-trigger').click();
    await page.getByTestId('sidebar-view-option-all').click();
    await expect(page.getByTestId('tools-panel')).toBeVisible();
  });
});
