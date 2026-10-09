import { test, expect } from '@playwright/test';

// Editor overhaul, in a real browser: inline "untitled" create (spec/14
// § File browser update) and binary/image preview.
//
// `?editor=browse` mounts the real EditorRail against the stubbed file API
// (dev-harness.tsx), which now also answers POST /files (create/rename) by
// mutating its in-memory entries list, and GET /files/raw with real PNG
// bytes — so both features round-trip exactly like the real app would.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';
const EDITOR_OPEN = { timeout: 20_000 };

// AppShell polls these for the sidebar (folder roster, section counts) —
// unrelated to the file browser, but unstubbed they 500 against the
// harness's backend-less dev proxy on every retry (lib/sectionCounts.ts says
// as much: "specs stub `/api/chats/counts` with `page.route`").
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

test.describe('file browser — inline create', () => {
  test('"New file" creates "untitled" immediately (no modal), opens it, and renaming it in place commits the real name', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await page.getByTestId('browse-new-file').click();

    // No modal anywhere — the row appears already in an editable name field.
    const input = page.getByTestId('tree-rename-input-untitled');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    // Opened straight away, same as the point of creating it.
    await expect(page.getByTestId('browse-meta-name')).toHaveText('untitled', EDITOR_OPEN);

    await input.fill('notes.md');
    await input.press('Enter');

    await expect(page.getByTestId('tree-rename-input-untitled')).toHaveCount(0);
    await expect(page.getByTestId('tree-row-notes.md')).toBeVisible();
  });

  test('Escape leaves the entry as "untitled" — not deleted, whatever was typed is discarded', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await page.getByTestId('browse-new-file').click();
    const input = page.getByTestId('tree-rename-input-untitled');
    await expect(input).toBeVisible();
    await input.fill('half-typed');
    await input.press('Escape');

    await expect(page.getByTestId('tree-rename-input-untitled')).toHaveCount(0);
    await expect(page.getByTestId('tree-row-untitled')).toBeVisible();
  });
});

test.describe('file browser — binary preview', () => {
  test('opening an image renders a real <img>, with no Save footer and no diff toggles', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await page.getByTestId('tree-row-assets').click();
    await page.getByTestId('tree-row-assets/logo.png').click();

    const preview = page.getByTestId('browse-binary-preview');
    await expect(preview).toBeVisible(EDITOR_OPEN);
    const img = preview.locator('img');
    await expect(img).toBeVisible(EDITOR_OPEN);
    // A real object URL, and the image actually decodes (proves real bytes
    // round-tripped through GET /files/raw, not a placeholder or a broken src).
    await expect(async () => {
      const ok = await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
      expect(ok).toBe(true);
    }).toPass();

    await expect(page.getByTestId('diff-toggle-git')).toHaveCount(0);
    await expect(page.getByTestId('diff-toggle-agent')).toHaveCount(0);
    await expect(page.getByTestId('browse-save')).toHaveCount(0);
  });
});
