import { test, expect, type Page, type Request } from '@playwright/test';

// Tom, Todoist: "Patch new chat should only save if you type, empty chat
// nothing". A new chat's header action (Editor) creates the chat before
// anything is sent (spec/14 § Sidebar §8, create-then-act). Left without a
// message sent or typed, that chat is deleted rather than staying in the list
// as an empty "New chat" (spec/14 § New chat drafts).

const NEW = '/app/dev-harness.html?chat=new';
const CREATED = 'c-left-empty';

async function stubCreate(page: Page): Promise<Request[]> {
  const deletes: Request[] = [];
  await page.route('**/api/chats', (r) =>
    r.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        chatId: CREATED,
        folder: '/home/tom/projects/portfolio',
        status: 'pending',
      }),
    }),
  );
  await page.route(`**/api/chats/${CREATED}`, (r) => {
    if (r.request().method() === 'DELETE') deletes.push(r.request());
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return deletes;
}

async function openEditorOnNewChat(page: Page): Promise<void> {
  await page.goto(NEW);
  await page.getByTestId('new-chat-action-editor').click();
  await expect(page.getByTestId('new-chat-main')).toHaveCount(0);
  await expect(page.getByTestId(`chat-row-${CREATED}`)).toBeVisible();
}

test.describe('a new chat left without typing leaves nothing behind', () => {
  test('opened via Editor and left with nothing typed, the chat is deleted', async ({ page }) => {
    const deletes = await stubCreate(page);
    await openEditorOnNewChat(page);

    await page.getByTestId('chat-row-chat_md').click();

    await expect(page.getByTestId(`chat-row-${CREATED}`)).toHaveCount(0);
    await expect.poll(() => deletes.length).toBe(1);
  });

  test('typed into and then left, the chat is kept with its words', async ({ page }) => {
    const deletes = await stubCreate(page);
    await openEditorOnNewChat(page);
    // Editor replaced the view with the chat's Files tab (spec/14 § Panes
    // and tabs) — switch to the chat itself before typing into its composer.
    await page.getByTestId(`chat-row-${CREATED}`).click();
    await page.getByTestId('composer-input').fill('look at the router');

    await page.getByTestId('chat-row-chat_md').click();
    await expect(page.getByTestId('chat-row-chat_md')).toHaveClass(/active/);

    await expect(page.getByTestId(`chat-row-${CREATED}`)).toBeVisible();
    expect(deletes).toHaveLength(0);
    await page.getByTestId(`chat-row-${CREATED}`).click();
    await expect(page.getByTestId('composer-input')).toHaveValue('look at the router');
  });

  test('text typed on the new-chat screen before Editor carries into the chat', async ({
    page,
  }) => {
    const deletes = await stubCreate(page);
    await page.goto(NEW);
    await page.getByTestId('composer-input').fill('start here');
    await page.getByTestId('new-chat-action-editor').click();
    await expect(page.getByTestId('new-chat-main')).toHaveCount(0);
    // Editor replaces the view with the new chat's Files tab (spec/14 §
    // Panes and tabs — a plain click replaces the active tab, same as a live
    // chat's own Editor button) — switch back to the chat itself to see its
    // composer carry the draft.
    await expect(page.getByTestId(`chat-row-${CREATED}`)).toBeVisible();
    await page.getByTestId(`chat-row-${CREATED}`).click();
    await expect(page.getByTestId('composer-input')).toHaveValue('start here');

    await page.getByTestId('chat-row-chat_md').click();
    await expect(page.getByTestId(`chat-row-${CREATED}`)).toBeVisible();
    expect(deletes).toHaveLength(0);
  });
});
