import { test, expect } from '@playwright/test';

// spec/14 § Composer — unsent composer text is OWNED by the chat it was typed
// in: leave that chat and it goes with it, come back and it is exactly as you
// left it. Real browser + the real ChatRoute/Composer (dev harness, no
// backend), so this proves the DOM the user actually types into.
//
// The sibling composer-chat-isolation.spec.ts proves the other half — a chat's
// text is never shown in a DIFFERENT chat.
const HARNESS = '/app/dev-harness.html';

async function chatIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('.sb-folder [data-testid^="chat-row-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
    );
}

test.describe('unsent composer text follows its chat', () => {
  test('type, switch chat, switch back — the text is still there', async ({ page }) => {
    await page.goto(HARNESS);
    const ids = await chatIds(page);
    expect(ids.length).toBeGreaterThan(1);
    const [first, second] = ids as [string, string];

    await page.goto(`${HARNESS}?chat=${first}`);
    const typed = 'half-written question for the first chat';
    await page.getByTestId('composer-input').fill(typed);

    await page.getByTestId(`chat-row-${second}`).click();
    await expect(page.getByTestId(`chat-row-${second}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue('');

    await page.getByTestId(`chat-row-${first}`).click();
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue(typed);
  });

  test('two chats each keep their own text', async ({ page }) => {
    await page.goto(HARNESS);
    const ids = await chatIds(page);
    const [first, second] = ids as [string, string];

    await page.goto(`${HARNESS}?chat=${first}`);
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await page.getByTestId('composer-input').fill('text belonging to the first chat');

    await page.getByTestId(`chat-row-${second}`).click();
    // Wait for the switch to land: filling before it does types into the chat
    // you are LEAVING, which is a test bug that reads like a leak.
    await expect(page.getByTestId(`chat-row-${second}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    await page.getByTestId('composer-input').fill('text belonging to the second chat');

    await page.getByTestId(`chat-row-${first}`).click();
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue(
      'text belonging to the first chat',
    );
    await page.getByTestId(`chat-row-${second}`).click();
    await expect(page.getByTestId(`chat-row-${second}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue(
      'text belonging to the second chat',
    );
  });

  test('the text survives a reload of the same chat', async ({ page }) => {
    // Per-test context isolation already gives this spec an empty localStorage,
    // so nothing clears it here — an addInitScript clear would re-run on the
    // reload and undo the very thing under test.
    await page.goto(HARNESS);
    const [first] = (await chatIds(page)) as [string];

    await page.goto(`${HARNESS}?chat=${first}`);
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await page.getByTestId('composer-input').fill('survives a reload');

    await page.reload();
    await expect(page.getByTestId('composer-input')).toHaveValue('survives a reload');
  });
});
