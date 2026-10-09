import { test, expect } from '@playwright/test';

// File browser loading states in a REAL browser (spec/14 § File browser —
// "Loading is drawn, not implied"; Todoist: "patch file viewer has no loading
// state just lookes empty").
//
// The harness's file stub normally answers in the same microtask, which is
// exactly why this went unnoticed: with an instant backend there is no moment
// to look at. `&filesDelay=<ms>` holds every /files response open, so the three
// in-flight states are observable for real — the tree skeleton, the cover over
// the editor, and the ⌘P picker's placeholder.
const harness = (delayMs: number): string =>
  `/app/dev-harness.html?chat=chat_bus&editor=browse&filesDelay=${delayMs}`;

// Opening a file mounts Monaco, a big lazy chunk, on a box with four workers
// sharing it — the same headroom browse-redesign.spec.ts gives its post-click
// assertions, for the same reason.
const SETTLED = { timeout: 20_000 };

test.describe('file browser — loading states', () => {
  // AppShell polls these for the sidebar (folder roster, section counts) —
  // unrelated to the file browser, but unstubbed they 500 against the
  // harness's backend-less dev proxy on every retry (lib/sectionCounts.ts
  // says as much: "specs stub `/api/chats/counts` with `page.route`").
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

  test('draws a tree skeleton while the first listing loads, never `Empty folder`', async ({
    page,
  }) => {
    await page.goto(harness(6000));

    await expect(page.getByTestId('browse-tree-loading')).toBeVisible();
    // The fault: the resolved-empty fallback claimed the folder was empty while
    // it was still being read.
    await expect(page.getByTestId('browse-tree-empty')).toHaveCount(0);
    // Bars, not a sentence.
    await expect(page.getByTestId('browse-tree-loading')).toHaveText('');

    // It is a first-load state only: it clears the moment the listing lands.
    await expect(page.getByTestId('browse-tree-loading')).toHaveCount(0, SETTLED);
    await expect(page.getByTestId('tree-row-foo.ts')).toBeVisible();
  });

  test('covers the editor while a file’s content loads, still naming the file', async ({
    page,
  }) => {
    await page.goto(harness(2500));

    await page.getByTestId('tree-row-foo.ts').click(SETTLED);

    const cover = page.getByTestId('browse-content-loading');
    await expect(cover).toBeVisible();
    // The meta strip is deliberately left above the cover: a covered editor
    // with no filename is the same blank pane the fault was about.
    await expect(page.getByTestId('browse-meta-name')).toHaveText('foo.ts');
    // It genuinely obscures the editor pane rather than sitting in a corner.
    const pane = await page.getByTestId('browse-editor').boundingBox();
    const box = await cover.boundingBox();
    expect(box?.width).toBeGreaterThan((pane?.width ?? 0) * 0.9);

    await expect(cover).toHaveCount(0, SETTLED);
    // The content that was behind it is the real file, not an empty document.
    await expect(page.getByTestId('browse-editor')).toContainText('const line0 = 0;', SETTLED);
  });

  test('⌘P shows its own skeleton while the recursive index loads', async ({ page }) => {
    await page.goto(harness(2500));
    // Editor overhaul: the picker and the tree now share the ONE recursive
    // fetch (EditorRail.tsx: "its own `treePending` IS the picker's loading
    // state") — opening the picker after waiting for the tree to settle would
    // leave nothing still in flight to observe. Open it immediately instead,
    // while that shared fetch is still pending.
    await page.evaluate(() => {
      (
        window as unknown as {
          __uiStore: { getState: () => { setFilePickerOpen(v: boolean): void } };
        }
      ).__uiStore
        .getState()
        .setFilePickerOpen(true);
    });

    await expect(page.getByTestId('file-search-loading')).toBeVisible();
    // The fault here was a stand-in, not a blank: the CURRENT directory's rows
    // were ranked as if they were the project-wide index.
    await expect(page.getByTestId('file-search-foo.ts')).toHaveCount(0);

    await expect(page.getByTestId('file-search-loading')).toHaveCount(0, SETTLED);
    // The real index is recursive — a file two directories down is now rankable.
    await page.getByTestId('file-search-input').fill('Panel');
    await expect(page.getByTestId('file-search-Panel.tsx')).toBeVisible();
  });
});
