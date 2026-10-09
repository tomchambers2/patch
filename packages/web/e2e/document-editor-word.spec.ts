import { test, expect } from '@playwright/test';

// Word import/export, in a real browser (spec/14 § Document editor, step 3 of
// 3). `?editor=browse` mounts the real EditorRail against the stubbed doc API
// (dev-harness.tsx), which seeds `assets/update.docx` and stubs
// `/doc/convert` + `/doc/export`.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';
const EDITOR_OPEN = { timeout: 20_000 };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chats/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ folders: [] }),
    }),
  );
  await page.route('**/api/chats/counts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
    }),
  );
});

test.describe('document editor — opening a .docx', () => {
  test('converts it and opens the resulting .md, never rendering the .docx itself', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('tree-row-assets').click();
    await page.getByTestId('tree-row-assets/update.docx').click();

    await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);
    await expect(page.getByTestId('document-editor-content')).toHaveValue(/# Converted From Word/);
    await expect(page.getByTestId('browse-meta-name')).toHaveText('update.md');
    // The file tree now shows the converted .md too, not just the original.
    await expect(page.getByTestId('tree-row-assets/update.md')).toBeVisible();
  });

  test('names what the conversion could not carry over', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('tree-row-assets').click();
    await page.getByTestId('tree-row-assets/update.docx').click();
    await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);

    await expect(page.getByText(/multi-column layout was flattened/)).toBeVisible();
  });
});

test.describe('document editor — export menu', () => {
  test('offers Download as .docx/.pdf/.md for a markdown document', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('tree-row-assets').click();
    await page.getByTestId('tree-row-assets/notes.md').click();
    await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);

    await expect(page.getByTestId('document-editor-export-docx')).toBeVisible();
    await expect(page.getByTestId('document-editor-export-pdf')).toBeVisible();
    await expect(page.getByTestId('document-editor-export-md')).toBeVisible();
  });

  test('clicking a format triggers a real browser download', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('tree-row-assets').click();
    await page.getByTestId('tree-row-assets/notes.md').click();
    await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('document-editor-export-docx').click(),
    ]);
    expect(download.suggestedFilename()).toBe('notes.docx');
  });
});
