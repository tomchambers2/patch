import { test, expect } from '@playwright/test';

// The file browser reopens where it was left (spec/14 § File browser,
// § Panes and tabs). Todoist: "patch the file editor should maintin state
// when closed nd reopened, keep that file open. its also super slow".
//
// Split across two surfaces now:
//   - The TREE's position (expanded dirs, filter) lives in the ui store,
//     keyed per chat — unchanged by the pane/tab rework, and survives the
//     Files tab closing and reopening.
//   - An OPEN FILE is its own pane tab (`layoutStore`), and the WHOLE layout
//     persists across a reload — proven here by reloading and finding the
//     same file tab still open, without needing a Files tab at all.
//   - A file's unsaved draft is `FileEditorTab`'s own in-memory state (same
//     convention the old rail's draft used): it does NOT survive that tab
//     closing — there is no slow-remount problem left to prove, because
//     there is no more single rail to keep mounted-but-hidden; each tab's
//     own Monaco widget lives exactly as long as that tab does.
//
// `?editor=browse` mounts the real EditorRail's successor — `FilesPage` —
// against the stubbed file API (dev-harness.tsx).
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';

// Monaco is a big lazy chunk — see editor-browse-layout.spec.ts. Only the first
// mount needs the headroom; everything after it is the point of this file.
const MONACO_MOUNT = { timeout: 20_000 };

test.describe('the file browser reopens where it was left', () => {
  test('closing and reopening the Files tab keeps the tree’s expanded directory and filter', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    // Expand a directory and set a filter, so both have somewhere to be lost
    // from.
    await page.getByTestId('tree-row-src').click();
    await expect(page.getByTestId('tree-row-src/index.ts')).toBeVisible(MONACO_MOUNT);
    await page.getByTestId('browse-filter').fill('ind');

    // Close the Files tab (⌘W — there is no visible close control for a
    // single tab in a single pane, per the hide-when-trivial tab bar rule).
    // It was the pane's only tab, so the pane is empty now, same as closing
    // any surface's last tab — back to the chat (a reload restores it: the
    // pane is empty, so `ChatPaneRoute` opens it, same as a fresh visit)
    // and reopen Files from its header.
    await page.keyboard.press('ControlOrMeta+w');
    await expect(page.getByTestId('files-page')).toHaveCount(0);
    await page.reload();
    await page.getByTestId('action-editor').click();

    // Same expanded directory, same filter.
    await expect(page.getByTestId('browse-filter')).toHaveValue('ind');
    await expect(page.getByTestId('tree-row-src/index.ts')).toBeVisible();
  });

  // spec/14 § Panes and tabs: a file's draft is in-memory only, by design —
  // lost once its tab unmounts, the same convention the old rail's draft
  // used while the rail stayed mounted-but-hidden. There is no more rail to
  // keep it alive behind; each tab's Monaco widget is disposed with the tab.
  test('an unsaved edit does NOT survive closing the tab — reopening shows the saved content', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await page.getByTestId('tree-row-foo.ts').click();
    const monaco = page.getByTestId('browse-editor').locator('.monaco-editor').first();
    await expect(monaco).toBeVisible(MONACO_MOUNT);
    await expect(page.getByTestId('browse-editor').getByText('const line0 = 0;')).toBeVisible();

    await monaco.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('const unsaved = 1;', { delay: 30 });
    await expect(page.getByTestId('browse-save')).toBeEnabled();

    await page.keyboard.press('ControlOrMeta+w');
    await expect(page.getByTestId('browse-editor')).toHaveCount(0);

    // It was the pane's only tab, so the pane is empty now — back to the
    // chat (same restore-on-reload path as the test above), then reopen the
    // same file through the tree.
    await page.reload();
    await page.getByTestId('action-editor').click();
    await page.getByTestId('tree-row-foo.ts').click();
    await expect(page.getByTestId('browse-meta-name')).toHaveText('foo.ts', MONACO_MOUNT);
    await expect(page.getByTestId('browse-save')).toBeDisabled();
  });

  test('a reload comes back to the same open file — the whole pane/tab layout persists', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await page.getByTestId('tree-row-src').click();
    await page.getByTestId('tree-row-src/index.ts').click();
    // Opening the FIRST file of the session suspends behind the Monaco chunk —
    // same headroom as the first mount above.
    await expect(page.getByTestId('browse-meta-name')).toHaveText('index.ts', MONACO_MOUNT);

    await page.reload();

    // The reload restores the WHOLE layout (spec/14 § Panes and tabs), so the
    // file tab that was open is open again directly — no Files tab needed.
    await expect(page.getByTestId('browse-meta-name')).toHaveText('index.ts', MONACO_MOUNT);
  });
});
