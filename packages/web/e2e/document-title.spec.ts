import { test, expect } from '@playwright/test';

// App Updates: "should show which workspace I am in somewhere" — Tom runs
// several Patch windows/tabs at once, each on a different chat in a different
// folder, and switches between them at the OS level (Cmd+` / Mission Control
// / the Dock / browser tabs) where the in-page folder crumb is invisible.
// `document.title` is the one label that surfaces there, so it must track the
// active chat's folder — the same basename ChatHeader's crumb shows — and
// keep tracking it across client-side navigation, not just at load.
//
// `chat_bus` (folder `/home/tom/projects/bus`) and `chat_md` (folder
// `/home/tom/projects/portfolio`) are the harness's two regular seeded chats;
// `thread_manager` is a special thread, which has no folder by definition.

test.describe('document title tracks the active workspace', () => {
  test('reads "<folder> — patch" for a regular chat, updating on navigation', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page).toHaveTitle('bus — patch');

    await page.getByTestId('chat-row-chat_md').click();
    await expect(page).toHaveTitle('portfolio — patch');
  });

  test('falls back to plain "patch" for a special thread', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page).toHaveTitle('bus — patch');

    await page.getByTestId('chat-row-thread_manager').click();
    await expect(page).toHaveTitle('patch');
  });

  test('falls back to plain "patch" on a route with no active chat', async ({ page }) => {
    await page.goto('/app/dev-harness.html?route=/settings');
    await expect(page).toHaveTitle('patch');
  });
});
