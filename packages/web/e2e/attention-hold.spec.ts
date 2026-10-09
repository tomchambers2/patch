import { test, expect } from '@playwright/test';

// Todoist: "needs attention queue - should just grey out the one you click on
// instead of immediately removing it. then once you navigate off it, it
// disappears." Opening a needs-attention row marks it read, which would
// otherwise drop it out of the filtered list the instant you click it — real
// browser + real CSS (spec/14 § Greying rules), so only a real browser proves
// the row visibly greys rather than vanishing, and only navigating to a
// DIFFERENT chat releases it.
const HARNESS = '/app/dev-harness.html';

test.describe('needs-attention hold', () => {
  test('opening a row greys it in place; navigating to another row releases it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('attention-toggle').click();

    // Two seeded chats sharing a folder, both fresh (unread) → both start in
    // the needs-attention list.
    const rowA = page.getByTestId('chat-row-chat_md');
    const rowB = page.getByTestId('chat-row-chat_long_text');
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    await rowA.click();
    await expect(rowA).toHaveClass(/active/);
    // Held: still in the filtered list, now greyed exactly like any other
    // read row — not gone.
    await expect(rowA).toBeVisible();
    await expect(rowA).toHaveClass(/is-read/);
    await expect(rowB).toBeVisible();

    await rowB.click();
    await expect(rowB).toHaveClass(/active/);
    // Navigating off chat_md released it — gone. chat_long_text is now held.
    await expect(rowA).toHaveCount(0);
    await expect(rowB).toBeVisible();
    await expect(rowB).toHaveClass(/is-read/);
  });
});
