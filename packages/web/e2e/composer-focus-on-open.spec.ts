import { test, expect } from '@playwright/test';

// spec/14 § Composer — opening a chat puts the cursor in the composer, so you
// can start typing straight away without clicking the field (Tom, Todoist:
// "opening a chat should focus the type a message box").
//
// Real-browser only. jsdom has no competition for the cursor: here the sidebar
// row link the user just clicked genuinely holds focus at the moment the
// composer mounts, and Chromium's own focus rules — not React's — decide what
// `document.activeElement` ends up being. The jsdom half (the prop being
// passed, the remount re-firing it, the guards) is in
// src/__tests__/ChatRoute.composerFocus.test.tsx.

const harness = (chat: string): string => `/app/dev-harness.html?chat=${chat}`;

test.describe('opening a chat focuses the composer', () => {
  test('a direct URL load lands the cursor in the composer', async ({ page }) => {
    await page.goto(harness('chat_md'));

    await expect(page.getByTestId('composer-input')).toBeFocused();
    // The claim that matters: typing with no clicking first goes into the box.
    await page.keyboard.type('straight in');
    await expect(page.getByTestId('composer-input')).toHaveValue('straight in');
  });

  test('switching chats from the sidebar re-focuses the new composer', async ({ page }) => {
    await page.goto(harness('chat_md'));
    const input = page.getByTestId('composer-input');
    await expect(input).toBeFocused();
    await page.keyboard.type('first chat text');
    await expect(input).toHaveValue('first chat text');

    // A sidebar row click leaves that link focused — the composer has to take
    // the cursor off it, which is exactly the case a mount-time focus in jsdom
    // cannot prove.
    await page.getByTestId('chat-row-chat_tasks').click();

    // An empty box is the remount: the composer is keyed on the chatId, and the
    // remount is what re-runs the focus.
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await page.keyboard.type('next chat');
    await expect(input).toHaveValue('next chat');
  });

  // A pending question/approval card takes the cursor for its own keys. The
  // composer's auto-focus is a courtesy and must not overwrite that claim.
  test('a chat opened on a pending card leaves the cursor on the card', async ({ page }) => {
    await page.goto(harness('chat_question_styles'));

    const input = page.getByTestId('composer-input');
    await expect(input).toBeAttached();
    await expect(input).not.toBeFocused();
    // The cursor is on the card, not merely off the composer.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.permission') !== null))
      .toBe(true);
  });
});
