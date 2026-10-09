import { test, expect, type Page } from '@playwright/test';

// Document editor — modes, suggestions, comments, history, in a real browser
// (spec/14 § Document editor, step 2 of 3). `?editor=browse` mounts the real
// EditorRail against the stubbed doc API (dev-harness.tsx), which seeds
// `assets/notes.md` in Propose mode with one pending suggestion.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';
const EDITOR_OPEN = { timeout: 20_000 };

// Selects `text` inside the document editor's textarea, then fires the
// mouseup the editor reads the selection on.
async function selectText(page: Page, text: string): Promise<void> {
  await page.getByTestId('document-editor-content').evaluate((el, t) => {
    const area = el as HTMLTextAreaElement;
    const start = area.value.indexOf(t);
    if (start < 0) throw new Error(`"${t}" not in editor`);
    area.focus();
    area.setSelectionRange(start, start + t.length);
    area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 40 }));
  }, text);
}

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

async function openNotes(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByTestId('tree-row-assets').click();
  await page.getByTestId('tree-row-assets/notes.md').click();
  await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);
}

test.describe('document editor — modes and suggestions', () => {
  test('opens in Propose mode (seeded) and switching to Change updates the select', async ({
    page,
  }) => {
    await openNotes(page);

    const select = page.getByTestId('doc-mode-select');
    await expect(select).toHaveValue('propose', EDITOR_OPEN);

    await select.selectOption('change');
    await expect(select).toHaveValue('change');
  });

  test('the Suggestions panel shows the seeded suggestion and accepting it clears it', async ({
    page,
  }) => {
    await openNotes(page);

    await page.getByTestId('doc-toggle-suggestions').click();
    await expect(page.getByTestId('doc-suggestions-panel')).toBeVisible(EDITOR_OPEN);
    await expect(page.getByTestId('doc-suggestion-seed-1')).toBeVisible();
    await expect(page.getByText('1 pending suggestion')).toBeVisible();

    await page.getByTestId('doc-suggestion-accept-seed-1').click();
    await expect(page.getByText('0 pending suggestions')).toBeVisible();
  });

  test('reject all clears every pending suggestion', async ({ page }) => {
    await openNotes(page);

    await page.getByTestId('doc-toggle-suggestions').click();
    await page.getByTestId('doc-suggestions-reject-all').click();
    await expect(page.getByText('0 pending suggestions')).toBeVisible();
  });
});

test.describe('document editor — comments both ways', () => {
  test('selecting a passage and choosing Comment opens a thread, visible in the Comments panel', async ({
    page,
  }) => {
    await openNotes(page);

    await selectText(page, '# Garden notes');
    await page.getByTestId('document-editor-comment-button').click();
    await page.getByTestId('document-editor-comment-input').fill('is this the right tone?');
    await page.getByTestId('document-editor-comment-submit').click();

    await page.getByTestId('doc-toggle-comments').click();
    await expect(page.getByTestId('doc-comments-panel')).toBeVisible(EDITOR_OPEN);
    await expect(page.getByText('is this the right tone?')).toBeVisible();
  });

  test('resolving a thread marks it resolved', async ({ page }) => {
    await openNotes(page);

    await selectText(page, '# Garden notes');
    await page.getByTestId('document-editor-comment-button').click();
    await page.getByTestId('document-editor-comment-input').fill('note');
    await page.getByTestId('document-editor-comment-submit').click();

    await page.getByTestId('doc-toggle-comments').click();
    const resolveButtons = page.getByTestId(/doc-thread-resolve-/);
    await resolveButtons.first().click();
    await expect(resolveButtons.first()).toHaveText('Reopen');
  });
});

test.describe('document editor — history', () => {
  test('the seeded version is listed, previewable and offers Restore', async ({ page }) => {
    await openNotes(page);

    await page.getByTestId('doc-toggle-history').click();
    await expect(page.getByTestId('doc-history-panel')).toBeVisible(EDITOR_OPEN);
    const rows = page.locator('[data-testid^="doc-history-row-"]');
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    await expect(page.getByTestId('doc-history-content')).toContainText('bold');
    await page.getByTestId('doc-history-restore').click();
    // Restoring appends a new version — the list grows to two.
    await expect(rows).toHaveCount(2);
  });
});
