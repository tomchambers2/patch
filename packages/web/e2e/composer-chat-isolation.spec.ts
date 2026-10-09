import { test, expect } from '@playwright/test';

// Todoist: "when archiving, the draft input text is not cleared. dont just
// clear it. needs a proepr fix, the page itself should be isolated to avoid
// leaking?" — unsent composer text must never survive a navigation into a
// DIFFERENT chat, whichever path triggers it (archive's auto-advance, or a
// plain sidebar row click). Real browser + real ChatRoute/Composer (dev
// harness, no backend) so this proves the DOM the user actually types into,
// not just the store.
const HARNESS = '/app/dev-harness.html';

test.describe('composer text is isolated per chat', () => {
  test('switching chats via the sidebar does not leak unsent text into the next chat', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(1);
    const [first, second] = ids as [string, string];

    await page.goto(`${HARNESS}?chat=${first}`);
    const input = page.getByTestId('composer-input');
    await input.fill('unsent text typed in the first chat');
    await expect(input).toHaveValue('unsent text typed in the first chat');

    await page.getByTestId(`chat-row-${second}`).click();
    await expect(page.getByTestId(`chat-row-${second}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue('');
  });

  test('archiving the open chat does not carry its unsent text into the chat it lands on', async ({
    page,
  }) => {
    await page.route('**/api/chats/*/archive', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );

    await page.goto(HARNESS);
    const ids = await page
      .locator('.sb-folder [data-testid^="chat-row-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(1);
    const [open, next] = ids as [string, string];

    await page.goto(`${HARNESS}?chat=${open}`);
    await expect(page.getByTestId(`chat-row-${open}`)).toHaveClass(/active/);

    const input = page.getByTestId('composer-input');
    await input.fill('unsent text left behind on archive');
    await expect(input).toHaveValue('unsent text left behind on archive');

    await page.getByTestId('action-archive').click();

    await expect(page.getByTestId(`chat-row-${next}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue('');
  });
});
