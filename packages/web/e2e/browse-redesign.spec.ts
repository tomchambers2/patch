import { test, expect } from '@playwright/test';

// Browse-panel redesign in a REAL browser (todo: "browse is a mess, needs a
// redesign to feel way more usable"; spec/14 § File browser).
//
// The harness serves a nested, deliberately unsorted flat entry list through
// the same stubbed file API the layout specs use — the shape
// `listFilesRecursive` really returns — so the things that make the browser
// usable can be exercised end to end: deterministic ordering, expand/collapse
// at any depth (editor overhaul: replaces one-directory-at-a-time navigation
// and the breadcrumb), and a tree-wide filter.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';

// Opening a FILE mounts Monaco — a big lazy chunk — and the tree is hidden
// behind the loading editor until it lands, so nothing about the opened file is
// observable before then. Give those assertions the same headroom
// editor-browse-layout.spec.ts and editor-writable-while-busy.spec.ts give the
// mount itself, for the same reason (four workers sharing the box). At the
// default 5s this intermittently failed with `aria-current` still absent — not
// because the row never activates, but because the click had not finished
// becoming an open editor yet.
const EDITOR_OPEN = { timeout: 20_000 };

test.describe('file browser — redesigned tree', () => {
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

  test('orders dirs first then files at the root, and expands/collapses a directory inline', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    const rows = page.getByTestId('browse-tree-list').locator('[data-testid^="tree-row-"]');
    // Only TOP-LEVEL rows are visible before anything is expanded.
    await expect(rows).toHaveCount(4);
    // Directories first (assets, src), then files A→Z (foo.ts, zeta.ts) — the
    // stub hands them back scrambled.
    await expect(rows).toHaveText([/assets/, /src/, /foo\.ts/, /zeta\.ts/]);

    // Expand two levels down — nested inline, not a navigation.
    await page.getByTestId('tree-row-src').click();
    await page.getByTestId('tree-row-src/components').click();
    await expect(page.getByTestId('tree-row-src/components/Panel.tsx')).toBeVisible();
    // No breadcrumb — the tree is hierarchical now, there is no "current directory".
    await expect(page.getByTestId('browse-breadcrumb')).toHaveCount(0);
    await expect(page.getByTestId('tree-up')).toHaveCount(0);

    // Collapsing the top-level `src` row hides everything nested under it.
    await page.getByTestId('tree-row-src').click();
    await expect(page.getByTestId('tree-row-src/components/Panel.tsx')).toHaveCount(0);
    await expect(page.getByTestId('tree-row-src/components')).toHaveCount(0);
    // The root rows are unaffected.
    await expect(page.getByTestId('tree-row-foo.ts')).toBeVisible();
  });

  test('filters the whole tree in place', async ({ page }) => {
    await page.goto(HARNESS);

    await page.getByTestId('browse-filter').fill('zet');
    await expect(page.getByTestId('tree-row-zeta.ts')).toBeVisible();
    await expect(page.getByTestId('tree-row-foo.ts')).toHaveCount(0);

    // A filter matching nothing says so rather than showing a blank tree.
    await page.getByTestId('browse-filter').fill('nothinghere');
    await expect(page.getByTestId('browse-tree-empty')).toHaveText('No matches');

    // A filter matching a NESTED file expands its ancestor directories so it
    // is reachable, without the user clicking anything.
    await page.getByTestId('browse-filter').fill('Panel');
    await expect(page.getByTestId('tree-row-src/components/Panel.tsx')).toBeVisible();
  });

  // spec/14 § Panes and tabs: clicking a file opens (or focuses) its own
  // tab — the tree no longer tracks "the open file" itself (several files
  // can be open as tabs at once, not just one).
  test('clicking a file opens its own tab, replacing the Files tab (a plain click, same as any other link)', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await page.getByTestId('tree-row-foo.ts').click();
    await expect(page.getByTestId('browse-meta-name')).toHaveText('foo.ts', EDITOR_OPEN);
    // The tree is gone — this pane's one tab is now the file, same as any
    // other plain-click "replace the active tab" open.
    await expect(page.getByTestId('browse-tree')).toHaveCount(0);
  });
});
