import { test, expect } from '@playwright/test';

// Todoist: "needs attention queue - updated things should be at the bottom
// of the queue." The needs-attention list queues oldest-waiting first; a row
// that updates again while still in the queue must sink to the BACK of it,
// not jump back to the front — real browser + real CSS/render order, so only
// a real browser proves the visible row order actually changes.
const HARNESS = '/app/dev-harness.html';

test.describe('needs-attention queue order', () => {
  test('queues oldest-waiting first, and a row that updates again sinks to the bottom', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('attention-toggle').click();

    // Two seeded chats sharing a folder: chat_long_text (lastUpdated: 0) is
    // older than chat_md (lastUpdated: 5).
    const older = page.getByTestId('chat-row-chat_long_text');
    const newer = page.getByTestId('chat-row-chat_md');
    await expect(older).toBeVisible();
    await expect(newer).toBeVisible();

    const rowOrder = async (): Promise<string[]> =>
      page
        .locator('[data-testid^="chat-row-"]')
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-testid')).filter((id): id is string => id !== null),
        );

    // Oldest-waiting (chat_long_text) queues ahead of the more recently
    // updated one (chat_md).
    const before = await rowOrder();
    expect(before.indexOf('chat-row-chat_long_text')).toBeLessThan(
      before.indexOf('chat-row-chat_md'),
    );

    // chat_long_text gets a fresh update — still unread/`done`, but now the
    // most recently updated of the two. It must sink to the BACK of the
    // queue rather than jump to the front.
    await page.evaluate(() => {
      const w = window as unknown as {
        __store: { getState: () => { mergeChats: (rows: unknown[]) => void } };
      };
      w.__store.getState().mergeChats([
        {
          chatId: 'chat_long_text',
          daemonId: 'd1',
          permissionMode: 'auto',
          name: 'long-text-fixture',
          folder: '/home/tom/projects/portfolio',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: Date.now(),
        },
      ]);
    });

    const after = await rowOrder();
    expect(after.indexOf('chat-row-chat_md')).toBeLessThan(
      after.indexOf('chat-row-chat_long_text'),
    );
  });
});
