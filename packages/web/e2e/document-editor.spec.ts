import { test, expect, type Page } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// Document editor, in a real browser (spec/14 § Document editor, step 1 of
// 3) — rich Markdown editing, "Open as source", and the selection-to-ask
// popover. Only a real browser can prove ProseMirror actually renders the
// elements and a real selection drives the popover.
//
// `?editor=browse` mounts the real EditorRail against the stubbed file API
// (dev-harness.tsx), whose `assets/notes.md` fixture carries one of every
// element FORMAT lists.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse&ws=fake';
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

async function fileWrites(page: Page): Promise<Array<Extract<WireEvent, { type: 'file.write' }>>> {
  return page.evaluate(() =>
    (window as unknown as { __wsSent: WireEvent[] }).__wsSent.filter(
      (e): e is Extract<WireEvent, { type: 'file.write' }> => e.type === 'file.write',
    ),
  );
}

async function openNotes(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByTestId('tree-row-assets').click();
  await page.getByTestId('tree-row-assets/notes.md').click();
  await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);
}

test.describe('document editor', () => {
  test('shows the markdown as plain text, untouched', async ({ page }) => {
    await openNotes(page);

    const area = page.getByTestId('document-editor-content');
    await expect(area).toHaveValue(/^# Garden notes\n\nA paragraph with \*\*bold\*\*, \*italic\*/);
    await expect(area).toHaveValue(/\| tomato \| 2 \|\n$/);
    await expect(page.locator('.document-editor strong, .document-editor table')).toHaveCount(0);
  });

  test('"Open as source" shows the raw markdown, and back again', async ({ page }) => {
    await openNotes(page);

    await page.getByTestId('document-editor-source-toggle').click();
    const source = page.getByTestId('mock-editor').or(page.locator('.monaco-editor'));
    await expect(source.first()).toBeVisible(EDITOR_OPEN);
    await expect(page.getByTestId('document-editor')).toHaveCount(0);

    await page.getByTestId('document-editor-source-toggle').click();
    await expect(page.getByTestId('document-editor')).toBeVisible(EDITOR_OPEN);
    await expect(page.getByTestId('document-editor-content')).toHaveValue(/# Garden notes/);
  });

  test('selecting a passage offers to ask about it', async ({ page }) => {
    await openNotes(page);

    await selectText(page, '# Garden notes');

    const ask = page.getByTestId('document-editor-ask');
    await expect(ask).toBeVisible(EDITOR_OPEN);
    await ask.click();
    await expect(ask).toHaveCount(0);
  });

  test('editing and saving writes the original text with only the typed change', async ({
    page,
  }) => {
    await openNotes(page);

    const area = page.getByTestId('document-editor-content');
    const original = await area.inputValue();
    await area.evaluate((el) => {
      const a = el as HTMLTextAreaElement;
      a.focus();
      a.setSelectionRange(a.value.indexOf('\n'), a.value.indexOf('\n'));
    });
    await page.keyboard.type(' More.');

    const save = page.getByTestId('browse-save');
    await expect(save).toBeEnabled(EDITOR_OPEN);
    await save.click();

    await expect(async () => {
      const writes = await fileWrites(page);
      expect(writes.at(-1)).toMatchObject({ type: 'file.write', path: 'assets/notes.md' });
      expect(writes.at(-1)?.content).toBe(
        original.replace('# Garden notes', '# Garden notes More.'),
      );
    }).toPass();
  });
});
