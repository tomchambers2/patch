import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatHeader + MoveChatModal + real CSS)
// for spec/04 § Moving a chat to another host: ⋯ → Move to… opens the dialog,
// the other machine is chosen with its same-named folder filled in, and Move
// posts exactly that. The server is stubbed with page.route.

test.describe('move a chat to another host', () => {
  test('moves chat_md to the other machine, into its folder of the same name', async ({ page }) => {
    let posted: unknown = null;
    await page.route('**/api/chats/chat_md/move', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        json: { ok: true, chatId: 'chat_md', daemonId: 'd2', folder: '/Users/dev/portfolio' },
      });
    });
    await page.goto('/app/dev-harness.html?chat=chat_md&hosts=two');
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __presenceStore: {
            getState(): { setHostFolders(d: string, r: string[], x: string[]): void };
          };
        }
      ).__presenceStore;
      store.getState().setHostFolders('d2', ['/Users/dev/code', '/Users/dev/portfolio'], []);
    });

    await page.getByTestId('action-more').click();
    await page.getByTestId('action-move').click();
    const modal = page.getByTestId('move-chat-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('move-chat-from')).toHaveText(
      'dev-host · /home/tom/projects/portfolio',
    );
    await expect(page.getByTestId('move-chat-host-d2')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('move-chat-folder')).toHaveValue('/Users/dev/portfolio');
    await page.screenshot({ path: 'test-results/chat-move-dialog.png' });

    await page.getByTestId('move-chat-confirm').click();
    await expect(modal).toHaveCount(0);
    expect(posted).toEqual({ daemonId: 'd2', folder: '/Users/dev/portfolio' });
  });

  test('a refusal keeps the dialog open with the reason', async ({ page }) => {
    await page.route('**/api/chats/chat_md/move', (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: 'busy',
          message: 'dev-host: this chat is mid-turn; move it once it has finished',
        },
      }),
    );
    await page.goto('/app/dev-harness.html?chat=chat_md&hosts=two');
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-move').click();
    await page.getByTestId('move-chat-folder').fill('/Users/dev/code');
    await page.getByTestId('move-chat-confirm').click();
    await expect(page.getByTestId('move-chat-error')).toHaveText(
      'dev-host: this chat is mid-turn; move it once it has finished',
    );
    await expect(page.getByTestId('move-chat-modal')).toBeVisible();
  });
});
