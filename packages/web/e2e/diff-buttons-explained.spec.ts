import { test, expect } from '@playwright/test';

// The file browser's two diff toggles, in a real browser (Todoist: "patch vs
// head and vs agent buttons dont work"; spec/14 § File browser).
//
// Redesign: "Git diff" / "Agent's edits" TOGGLE an inline diff in the SAME
// pane the plain editor occupies (the tree stays on screen) instead of
// navigating to a separate diff screen, and are GREYED OUT rather than
// clickable-through to a "nothing changed" notice when there is nothing to
// diff — Tom's own example: "SKILL.md is unchanged since HEAD — instead just
// grey out that button if there's no diff, instead of allowing to open it."
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';

// Opening a file mounts Monaco (a big lazy chunk) and the whole panel suspends
// behind it, so nothing about the open file is observable before then — the
// same headroom browse-redesign.spec.ts gives the mount, for the same reason.
const EDITOR_OPEN = { timeout: 20_000 };

async function openFooTs(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByTestId('tree-row-foo.ts').click();
  await expect(page.getByTestId('browse-meta-name')).toHaveText('foo.ts', EDITOR_OPEN);
}

test.describe('file browser — diff toggles grey out or open inline', () => {
  // AppShell polls these for the sidebar (folder roster, section counts) —
  // unrelated to the file browser, but unstubbed they 500 against the
  // harness's backend-less dev proxy on every retry (lib/sectionCounts.ts
  // says as much: "specs stub `/api/chats/counts` with `page.route`"). Left
  // unstubbed, the repeated failures were intermittently tearing down and
  // remounting the whole tree — wiping `diffToggle`, EditorRail's local
  // toggle state, in the gap between the click and the assertion.
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

  test('"Agent\'s edits" is greyed out for a file this chat never edited', async ({ page }) => {
    await openFooTs(page);

    const agentToggle = page.getByTestId('diff-toggle-agent');
    await expect(agentToggle).toBeDisabled();
    await expect(agentToggle).toHaveAttribute('aria-pressed', 'false');
    // Nothing to click through to — no diff, no notice toast.
    await expect(page.getByTestId('browse-diff-inline')).toHaveCount(0);
  });

  test('"Git diff" opens inline against HEAD, in the same pane, and toggles back to the plain editor', async ({
    page,
  }) => {
    await openFooTs(page);
    const pane = page.getByTestId('browse-editor');
    await expect(pane.locator('.monaco-editor').first()).toBeVisible(EDITOR_OPEN);

    const gitToggle = page.getByTestId('diff-toggle-git');
    // The harness's HEAD blob for foo.ts deliberately diverges by one line, so
    // there is something real to diff.
    await expect(gitToggle).toBeEnabled(EDITOR_OPEN);
    await gitToggle.click();

    await expect(gitToggle).toHaveAttribute('aria-pressed', 'true');
    const diffPane = page.getByTestId('browse-diff-inline');
    await expect(diffPane).toBeVisible(EDITOR_OPEN);
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible(EDITOR_OPEN);
    // Both sides of the divergence are on screen — the unified diff shows the
    // HEAD line it removed and the working-tree line it added. Monaco's diff
    // editor keeps the original/modified sides as two separate sub-editors
    // (each with their own `.view-lines`) even in unified/inline mode, so the
    // removed line has to be looked for on the `original` side specifically —
    // an unscoped `.view-lines` matches both and is a strict-mode violation.
    await expect(diffPane.locator('.original-in-monaco-diff-editor .view-lines')).toContainText(
      'const line0 = -1;',
    );

    await gitToggle.click();
    await expect(gitToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('browse-diff-inline')).toHaveCount(0);
    await expect(pane.locator('.monaco-editor').first()).toBeVisible(EDITOR_OPEN);
  });
});
