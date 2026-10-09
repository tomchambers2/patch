import { test, expect, type Page } from '@playwright/test';

// spec/14 § Diff editor: a file with nothing on the original side opens as the
// standard single-pane editor showing the file itself, not as a two-sided diff.
//
// A whole-file Write has no baseline, so rendering it as a diff painted the
// entire file as one block of additions — a diff of nothing against everything.
// The unit tests assert the decision against a mocked `@monaco-editor/react`;
// only a real browser proves the REAL Monaco that mounts is the plain editor
// (`.monaco-editor`, no `.monaco-diff-editor`) and that the file's own text is
// on screen.
//
// Both harness modes seed the rail exactly as the app leaves it:
//   ?editor=write            — a `Write` permission request (api/ws.ts).
//   ?editor=write-changeset  — a change-set entry with no baseline (openDiff).

// Monaco is a big lazy chunk — the same headroom the other editor specs give
// its mount, for the same reason (workers sharing the box).
const MONACO_MOUNT = { timeout: 20_000 };

/**
 * The plain editor is mounted and the two-sided diff is NOT. `.monaco-editor`
 * is present in both cases (the diff editor contains two of them), so the
 * absence of `.monaco-diff-editor` is the load-bearing half.
 */
async function expectPlainEditor(page: Page, panel: ReturnType<Page['getByTestId']>) {
  await expect(panel).toHaveAttribute('data-view', 'file');
  await expect(panel.locator('.monaco-editor').first()).toBeVisible(MONACO_MOUNT);
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0);
  // The file itself is what's on screen. Monaco splits a line into token spans,
  // so match on the rendered text of the view rather than a single element.
  await expect(panel.locator('.view-lines')).toContainText('wholeFileWrite');
}

test.describe('a whole-file write opens as the file, not a diff', () => {
  test('a Write permission request shows the plain editor', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus&editor=write');

    const panel = page.getByTestId('diff-panel');
    await expect(panel).toBeVisible(MONACO_MOUNT);
    await expectPlainEditor(page, panel);

    // Everything else about the rail is unchanged: header, path, and the
    // approve/deny controls the permission request needs.
    await expect(page.getByTestId('diff-panel-tool')).toHaveText('Write');
    await expect(page.getByTestId('diff-panel-path')).toHaveText(
      '/home/tom/projects/bus/src/brandNew.ts',
    );
    await expect(page.getByTestId('diff-approve')).toBeVisible();
    await expect(page.getByTestId('diff-deny')).toBeVisible();
  });

  test('a change-set entry with no baseline shows the plain editor', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus&editor=write-changeset');

    const panel = page.getByTestId('file-diff-panel');
    await expect(panel).toBeVisible(MONACO_MOUNT);
    await expectPlainEditor(page, panel);

    await expect(page.getByTestId('file-diff-path')).toHaveText('src/brandNew.ts');
    await expect(page.getByTestId('file-diff-save')).toBeVisible();
  });

  test('an edit WITH a baseline still opens as a two-sided diff', async ({ page }) => {
    // The control: `?editor=diff` seeds a real original side, and that must go
    // on rendering as a diff — the rule is "the original side is empty", not
    // "the rail is open".
    await page.goto('/app/dev-harness.html?chat=chat_bus&editor=diff');

    const panel = page.getByTestId('file-diff-panel');
    await expect(panel).toBeVisible(MONACO_MOUNT);
    await expect(panel).toHaveAttribute('data-view', 'diff');
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible(MONACO_MOUNT);
  });
});
