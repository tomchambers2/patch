import { test, expect, type Page } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/03 § Answering with content: an empty `editedNewString` is a meaningful
// answer — it is how an edit that DELETES the content is approved. Clearing the
// pending edit down to nothing and pressing "Approve with edits" must therefore
// send `editedNewString: ''`, not raise an error toast.
//
// `?editor=write` seeds the rail exactly as a `Write` permission request leaves
// it (dev-harness.tsx): a pending diff with no baseline, so it opens as the
// plain single-pane editor with the real Approve / Deny controls. The unit test
// asserts this against a mocked `@monaco-editor/react`; only a real browser
// proves the REAL Monaco can be emptied and that the emptied value is what
// reaches the wire.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=write&ws=fake';

// Monaco is a big lazy chunk — the same headroom the other editor specs give
// its mount, for the same reason (workers sharing the box).
const MONACO_MOUNT = { timeout: 20_000 };

async function permissionResponses(
  page: Page,
): Promise<Array<Extract<WireEvent, { type: 'chat.permission_response' }>>> {
  return page.evaluate(() =>
    (window as unknown as { __wsSent: WireEvent[] }).__wsSent.filter(
      (e): e is Extract<WireEvent, { type: 'chat.permission_response' }> =>
        e.type === 'chat.permission_response',
    ),
  );
}

/**
 * What the REAL Monaco model holds. `window.monaco` is the bundled instance the
 * app hands to @monaco-editor/loader (src/lib/monaco-loader.ts), so this reads
 * the editor's own state rather than scraping token spans out of the DOM.
 */
async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: { editor: { getEditors(): Array<{ getValue(): string }> } };
      }
    ).monaco;
    const editor = monaco?.editor.getEditors()[0];
    return editor ? editor.getValue() : '';
  });
}

test.describe('a pending edit can be approved down to nothing', () => {
  test('clearing the editor and approving sends an empty editedNewString', async ({ page }) => {
    await page.goto(HARNESS);

    const panel = page.getByTestId('diff-panel');
    await expect(panel).toBeVisible(MONACO_MOUNT);
    await expect(panel.locator('.monaco-editor').first()).toBeVisible(MONACO_MOUNT);
    // The seeded content is really in the model before anything is deleted —
    // otherwise "the editor is empty" could just mean "it never loaded".
    await expect.poll(() => editorValue(page), { timeout: 20_000 }).toContain('wholeFileWrite');

    // Nothing edited yet: the footer offers a plain Approve.
    await expect(page.getByTestId('diff-approve')).toBeVisible();

    // Empty the file in the real Monaco. Select-all then Delete, so the result
    // does not depend on where the click put the cursor.
    await panel.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await expect.poll(() => editorValue(page), { timeout: 10_000 }).toBe('');

    // An empty document still counts as dirty, so the footer flips.
    const approveWithEdits = page.getByTestId('diff-approve-with-edits');
    await expect(approveWithEdits).toBeVisible();
    await approveWithEdits.click();

    expect(await permissionResponses(page)).toEqual([
      {
        type: 'chat.permission_response',
        requestId: 'req-write-1',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: '',
      },
    ]);

    // The app's one error surface stays empty — the empty edit was accepted.
    await expect(page.getByTestId('error-toasts')).toBeHidden();
  });
});
