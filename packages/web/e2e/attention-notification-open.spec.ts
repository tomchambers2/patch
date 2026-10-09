import { test, expect } from '@playwright/test';

// Todoist: "a chat you are looking at should show in the needs attention view,
// even if you clicked a notification etc." A notification/deep-link tap lands
// straight on `/chats/:id` and marks that chat read as part of activating it —
// all before the sidebar has ever rendered it as needing attention. Real
// browser: the bug was in the render-order-dependent hold logic itself, which
// only a real mount/route sequence (not a store call in a unit test) can prove
// either way.
const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('needs-attention hold survives a cold open', () => {
  test('a chat opened straight from a notification/deep link (never seen needing attention) still shows once attention mode is on', async ({
    page,
  }) => {
    // chat_md starts unread like every fixture (dev-harness.tsx), and
    // `?chat=chat_md` activates it on load the same way a notification tap
    // would — before attention mode is ever switched on, so the sidebar never
    // gets a render where chat_md still needs attention.
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-title')).toHaveText('July Seasonal Food');

    await page.getByTestId('attention-toggle').click();

    const row = page.getByTestId('chat-row-chat_md');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/active/);
    await expect(row).toHaveClass(/is-read/);
  });
});
