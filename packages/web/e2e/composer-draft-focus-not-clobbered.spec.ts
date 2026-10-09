import { test, expect } from '@playwright/test';

// spec/14 § Composer — server-owned drafts: a surface whose composer has
// focus is never overwritten under the cursor by an incoming
// `composer_draft.updated`/`.cleared`; it takes the newer text only once the
// composer loses focus. The harness has no live socket, so
// `window.__composerDraftStore` (dev-harness.tsx) simulates the frame the way
// the real WS hub would broadcast it.
const HARNESS = '/app/dev-harness.html';

declare global {
  interface Window {
    __composerDraftStore?: {
      getState(): {
        applyDraftUpdated(chatId: string, text: string, updatedAt: number): void;
        applyDraftCleared(chatId: string, updatedAt: number): void;
      };
    };
  }
}

async function chatIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('.sb-folder [data-testid^="chat-row-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
    );
}

test.describe('a focused composer is never clobbered under the cursor', () => {
  test('an incoming update is held while typing, then applied on blur', async ({ page }) => {
    await page.goto(HARNESS);
    const [chatId] = (await chatIds(page)) as [string];
    await page.goto(`${HARNESS}?chat=${chatId}`);

    const composer = page.getByTestId('composer-input');
    await composer.fill('still typing this');
    await expect(composer).toBeFocused();

    // A newer draft arrives from another surface while this one is focused.
    await page.evaluate(
      ([id, text]) => {
        window.__composerDraftStore!.getState().applyDraftUpdated(id, text, Date.now() + 60_000);
      },
      [chatId, 'typed on the other surface'] as const,
    );

    // Still showing what was typed here — the incoming update must not have
    // touched the DOM while focused.
    await expect(composer).toHaveValue('still typing this');

    // Losing focus resolves it: the newer text takes over.
    await composer.evaluate((el) => (el as HTMLTextAreaElement).blur());
    await expect(composer).toHaveValue('typed on the other surface');
  });

  test('a clear held while focused empties the composer on blur', async ({ page }) => {
    await page.goto(HARNESS);
    const [chatId] = (await chatIds(page)) as [string];
    await page.goto(`${HARNESS}?chat=${chatId}`);

    const composer = page.getByTestId('composer-input');
    await composer.fill('about to be cleared elsewhere');
    await expect(composer).toBeFocused();

    await page.evaluate(
      ([id]) => {
        window.__composerDraftStore!.getState().applyDraftCleared(id, Date.now() + 60_000);
      },
      [chatId] as const,
    );
    await expect(composer).toHaveValue('about to be cleared elsewhere');

    await composer.evaluate((el) => (el as HTMLTextAreaElement).blur());
    await expect(composer).toHaveValue('');
  });

  test('reopening the chat (remount) shows the newer text without needing a blur', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const ids = await chatIds(page);
    const [first, second] = ids as [string, string];
    await page.goto(`${HARNESS}?chat=${first}`);

    const composer = page.getByTestId('composer-input');
    await composer.fill('typing in the first chat');

    await page.evaluate(
      ([id, text]) => {
        window.__composerDraftStore!.getState().applyDraftUpdated(id, text, Date.now() + 60_000);
      },
      [first, 'newer text while away'] as const,
    );

    // Navigate away (unfocuses AND unmounts this chat's composer) and back —
    // the remount reads the store fresh, same as any other reopen.
    await page.getByTestId(`chat-row-${second}`).click();
    await expect(page.getByTestId(`chat-row-${second}`)).toHaveClass(/active/);
    await page.getByTestId(`chat-row-${first}`).click();
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await expect(composer).toHaveValue('newer text while away');
  });
});
