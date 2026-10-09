import { test, expect } from '@playwright/test';

// spec/14 § Sidebar → Selecting multiple rows (shift-click) — both bulk actions
// ask first. Bulk archive used to move N chats on a single click while the
// folder header's archive and the bulk delete beside it both confirmed, so one
// mis-aimed click on the selection bar emptied a run of the list with nothing
// to answer. The confirm is the app's own modal, never the OS one, and it names
// the count.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

/** Plain-click one chat row, then shift-click a later one: a range selection. */
async function selectARange(page: import('@playwright/test').Page): Promise<number> {
  const rows = page.locator('[data-testid^="chat-row-chat_"]');
  await expect(rows.first()).toBeVisible();
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  const count = await page.getByTestId('selection-count').textContent();
  return Number.parseInt((count ?? '').trim(), 10);
}

test.describe('bulk archive from the selection bar', () => {
  test('asks first, in the app modal, naming the count', async ({ page }) => {
    // If a NATIVE dialog ever fires, fail loudly — confirmations are the app's
    // own modal.
    let nativeDialogFired = false;
    page.on('dialog', (d) => {
      nativeDialogFired = true;
      void d.dismiss();
    });
    // Without the stub the harness has no backend, the REST archive 500s and
    // the optimistic flip reverts mid-assertion.
    await page.route('**/api/chats/**', (r) => r.fulfill({ status: 200, body: '{"ok":true}' }));
    await page.goto(HARNESS);

    const selected = await selectARange(page);
    expect(selected).toBeGreaterThan(1);
    const firstId = (await page
      .locator('[data-testid^="chat-row-chat_"]')
      .first()
      .getAttribute('data-testid')) as string;

    await page.getByTestId('selection-archive').click();

    const modal = page.getByTestId('confirm-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toContainText(`Archive ${selected} selected chats?`);
    expect(nativeDialogFired).toBe(false);
    // Nothing has moved while the question is on screen.
    await expect(page.getByTestId(firstId)).toBeVisible();

    await page.getByTestId('confirm-ok').click();
    await expect(modal).toHaveCount(0);
    // The selected run leaves the active list, and the bar goes with it.
    await expect(page.getByTestId(firstId)).toHaveCount(0);
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);
  });

  test('cancelling archives nothing and leaves the selection standing', async ({ page }) => {
    await page.route('**/api/chats/**', (r) => r.fulfill({ status: 200, body: '{"ok":true}' }));
    await page.goto(HARNESS);

    const selected = await selectARange(page);
    const firstId = (await page
      .locator('[data-testid^="chat-row-chat_"]')
      .first()
      .getAttribute('data-testid')) as string;

    await page.getByTestId('selection-archive').click();
    await expect(page.getByTestId('confirm-modal')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-modal')).toHaveCount(0);

    await expect(page.getByTestId(firstId)).toBeVisible();
    await expect(page.getByTestId('selection-count')).toHaveText(`${selected} selected`);
  });
});
