import { test, expect } from '@playwright/test';

// spec/14 § Composer / § New chat drafts — the OTHER half of drafts.
//
// The sibling composer-draft-per-chat.spec.ts proves unsent text is remembered.
// This proves the rule that bounds it: a draft is only a draft while it has
// text. Type something and delete it again — whitespace counts as deleted —
// and there is nothing left to restore and no row in the sidebar claiming
// there is. Real browser + the real components (dev harness, no backend).
const HARNESS = '/app/dev-harness.html';

async function chatIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('.sb-folder [data-testid^="chat-row-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!.replace('chat-row-', '')),
    );
}

test.describe('an emptied composer is not a draft', () => {
  test('type, delete, switch away and back — the composer is empty', async ({ page }) => {
    await page.goto(HARNESS);
    const ids = await chatIds(page);
    expect(ids.length).toBeGreaterThan(1);
    const [first, second] = ids as [string, string];

    await page.goto(`${HARNESS}?chat=${first}`);
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await page.getByTestId('composer-input').fill('changed my mind about this');
    await page.getByTestId('composer-input').fill('');

    await page.getByTestId(`chat-row-${second}`).click();
    await expect(page.getByTestId(`chat-row-${second}`)).toHaveClass(/active/);
    await page.getByTestId(`chat-row-${first}`).click();
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await expect(page.getByTestId('composer-input')).toHaveValue('');
  });

  test('whitespace-only text is not remembered across a reload', async ({ page }) => {
    await page.goto(HARNESS);
    const [first] = (await chatIds(page)) as [string];

    await page.goto(`${HARNESS}?chat=${first}`);
    await expect(page.getByTestId(`chat-row-${first}`)).toHaveClass(/active/);
    await page.getByTestId('composer-input').fill('   ');

    await page.reload();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
  });

  test('a new chat typed into and emptied loses its sidebar row', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('new-chat-fab').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();

    await page.getByTestId('composer-input').fill('a new chat I am not going to send');
    await expect(page.getByTestId('drafts-section')).toBeVisible();

    await page.getByTestId('composer-input').fill('');
    await expect(page.getByTestId('drafts-section')).toHaveCount(0);
  });
});
