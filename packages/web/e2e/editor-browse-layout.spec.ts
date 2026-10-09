import { test, expect } from '@playwright/test';

// Real-browser layout check for the file-browser editor. todo: "File browser:
// editor does not fill pane."
//
// The Monaco editor mounted in the browse pane must keep filling the editor
// column when that column's size changes AFTER mount — e.g. when the directory
// tree is collapsed and the editor pane grows to take the freed width. Without
// Monaco's `automaticLayout`, the editor measures its container once at mount
// and keeps that stale size, leaving empty space in the pane on any later
// resize. This test collapses the tree and asserts Monaco re-fits to fill the
// now-wider pane.
//
// `?editor=browse` mounts the real EditorRail in browse mode against a stubbed
// file API (see dev-harness.tsx).
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';

// Monaco is a big lazy chunk: ~2s to first paint on an idle box, against the 5s
// default expect timeout. That 2.4x margin does not survive four Playwright
// workers sharing a machine that is also running a host, so this assertion
// failed under the full suite while passing every time on its own. Waiting for
// the chunk is not what either test is about — the layout assertions below keep
// the default timeout, and only the mount gets the headroom.
const MONACO_MOUNT = { timeout: 20_000 };

test.describe('file-browser editor fills the pane', () => {
  test('opening a file gives Monaco the full width of the editor pane', async ({ page }) => {
    await page.goto(HARNESS);

    await page.getByTestId('tree-row-foo.ts').click();
    const editorPane = page.getByTestId('browse-editor');
    const monaco = editorPane.locator('.monaco-editor').first();
    await expect(monaco).toBeVisible(MONACO_MOUNT);

    const pane = (await editorPane.boundingBox())!;
    const ed = (await monaco.boundingBox())!;
    // Monaco fills the pane width at mount (allow scrollbar/border slack).
    expect(ed.width).toBeGreaterThan(pane.width - 4);
  });

  // spec/14 § Panes and tabs: the file now opens as its own tab, replacing
  // the tree's tab rather than sitting beside it — so this drives the same
  // "container resized after mount, with no window resize" case via the
  // SIDEBAR collapsing instead (it grows the pane area by the same
  // mechanism: a flex sibling's width changing, not a window resize).
  test('editor re-fits to fill the pane after the sidebar is collapsed', async ({ page }) => {
    await page.goto(HARNESS);

    await page.getByTestId('tree-row-foo.ts').click();
    const editorPane = page.getByTestId('browse-editor');
    const monaco = editorPane.locator('.monaco-editor').first();
    await expect(monaco).toBeVisible(MONACO_MOUNT);

    const beforePane = (await editorPane.boundingBox())!;

    // Collapse the sidebar → the pane area grows to take the freed width.
    // (This is a container-only resize; there is no window resize, so an
    // editor without automaticLayout will NOT re-measure.)
    await page.getByTestId('sidebar-collapse').click();
    await page.waitForTimeout(150); // allow a relayout frame

    const afterPane = (await editorPane.boundingBox())!;
    // Sanity: collapsing the sidebar really did widen the pane.
    expect(afterPane.width).toBeGreaterThan(beforePane.width + 100);

    const ed = (await monaco.boundingBox())!;
    // Monaco must have grown to fill the wider pane — not kept its stale
    // mount-time width, which would leave a large empty gap on the right.
    expect(ed.width).toBeGreaterThan(afterPane.width - 4);
  });
});
