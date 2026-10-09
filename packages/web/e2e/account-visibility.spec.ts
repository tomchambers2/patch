import { test, expect, type Page } from '@playwright/test';
import { stubSettingsApi } from './settingsHarness.js';

// Which account a chat runs on (spec/10 § Backend credentials): a new chat can
// name the account its turns start on; a live chat's header names the account
// its latest turn ran on; and a turn that moved account because the last ran
// out of credit says so in the transcript, with when it comes back in the
// reader's own time.

const TWO_ACCOUNTS = {
  claude: [
    { id: 'a1', label: 'work', connected: true },
    { id: 'a2', label: 'personal', connected: true },
  ],
};

type Store = { getState(): { applyEvent(e: Record<string, unknown>): void } };
async function applyEvent(page: Page, event: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (e) => (window as unknown as { __store: Store }).__store.getState().applyEvent(e),
    event,
  );
}

test('a new chat names the account it starts on, and sends it with the spawn', async ({ page }) => {
  await stubSettingsApi(page, { secrets: TWO_ACCOUNTS });
  let spawn: Record<string, unknown> | null = null;
  await page.route('**/api/chats', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    spawn = r.request().postDataJSON() as Record<string, unknown>;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chatId: 'chat-new-1', folder: spawn['folder'], status: 'pending' }),
    });
  });
  await page.goto('/app/dev-harness.html?chat=new');
  // The harness has not loaded the shared settings on its own; do what the
  // greeting would.
  await page.evaluate(async () => {
    const res = await fetch('/api/settings/shared');
    const state = await res.json();
    (
      window as unknown as { __preferencesStore: { getState(): { apply(s: unknown): void } } }
    ).__preferencesStore
      .getState()
      .apply(state);
  });
  const select = page.getByTestId('new-chat-account');
  await expect(select).toBeVisible();
  // Dressed as the model pill, not native chrome.
  await expect(select).toHaveCSS('appearance', 'none');
  await expect(select).toHaveCSS('border-top-left-radius', /^[1-9]\d*px$/);
  await expect(select.locator('option')).toHaveText([
    'Account: by strategy',
    'Start on work',
    'Start on personal',
  ]);
  await select.selectOption('a2');
  await page.locator('textarea').first().fill('hello');
  await page.locator('textarea').first().press('Enter');
  await expect.poll(() => spawn).toMatchObject({ preferredAccountId: 'a2' });
});

test('a live chat’s header names the account its latest turn ran on', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  await expect(page.getByTestId('chat-account')).toHaveCount(0);
  await applyEvent(page, {
    type: 'chat.state',
    chatId: 'chat_bus',
    activity: 'running',
    lastUpdated: Date.now(),
    permissionMode: 'auto',
    account: { id: 'a2', label: 'personal' },
  });
  await expect(page.getByTestId('chat-account')).toHaveText('personal');
});

test('a turn that moved account because the last ran out says so, in local time', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  const until = new Date('2026-09-29T20:00:00Z').getTime();
  await applyEvent(page, {
    type: 'chat.message',
    chatId: 'chat_bus',
    role: 'system',
    content: 'Switched from work to personal — work is out of credit',
    seq: 9001,
    accountSwitch: { from: 'work', to: 'personal', until },
  });
  const line = page.getByText(/Switched from work to personal — work is out until/);
  await expect(line).toBeVisible();
  // Rendered from the instant, never the raw epoch.
  await expect(line).not.toContainText(String(until));
});
