import { test, expect } from '@playwright/test';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import type { WireEvent } from '@patch/wire';

// Real-browser e2e (dev harness, real ChatHeader + real CSS, no backend) for
// the provider-switch confirmation (spec/04 § History): picking a model from
// a different provider than the chat's current one shows a modal with Tom's
// exact copy before `chat.model_request` goes out. A same-provider change
// never shows it. "Don't show again" persists as an account setting that
// must survive across surfaces, so it round-trips through `/api/settings`.

const CATALOGUE = {
  models: [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-1', label: 'Opus 4.1' },
    { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
  ],
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};

/** The shared settings (spec/01 § Settings) as the server starts them. */
const BASE_PREFERENCES = { ...DEFAULT_SHARED_SETTINGS };

async function mockSettings(
  page: import('@playwright/test').Page,
  suppressProviderSwitchWarning: boolean,
): Promise<{ getPatches: () => Array<Record<string, unknown>> }> {
  let preferences = { ...BASE_PREFERENCES, suppressProviderSwitchWarning };
  const patches: Array<Record<string, unknown>> = [];
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
  await page.route('**/api/settings', (r) => {
    if (r.request().method() === 'PATCH') {
      const patch = r.request().postDataJSON() as Record<string, unknown>;
      patches.push(patch);
      preferences = { ...preferences, ...patch };
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ preferences }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        account: ME.account,
        devices: [],
        push: { tokenCount: 0 },
        daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
        projectFolders: [],
        preferences,
      }),
    });
  });
  return { getPatches: () => patches };
}

async function sentModelRequests(
  page: import('@playwright/test').Page,
): Promise<Array<{ chatId: string; model: string }>> {
  const sent = await page.evaluate(() => (window as unknown as { __wsSent: WireEvent[] }).__wsSent);
  return sent.filter(
    (e) => (e as { type: string }).type === 'chat.model_request',
  ) as unknown as Array<{
    chatId: string;
    model: string;
  }>;
}

test.describe('model control — provider-switch confirmation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/models*', (route) =>
      route.fulfill({ json: CATALOGUE, contentType: 'application/json' }),
    );
  });

  test('shows the exact confirmation copy on a cross-provider pick, and sends nothing until confirmed', async ({
    page,
  }) => {
    await mockSettings(page, false);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-openai/gpt-5-codex').click();

    const modal = page.getByTestId('provider-switch-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      'Switching provider may cost more due to lack of a cache, are you sure?',
    );
    await expect(page.getByTestId('provider-switch-cancel')).toBeVisible();
    await expect(page.getByTestId('provider-switch-switch')).toBeVisible();
    await expect(page.getByTestId('provider-switch-dont-show-again')).toBeVisible();
    expect(await sentModelRequests(page)).toEqual([]);
  });

  test('never shows the modal for a same-provider model change', async ({ page }) => {
    await mockSettings(page, false);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-claude-opus-4-1').click();

    await expect(page.getByTestId('provider-switch-modal')).toHaveCount(0);
    expect(await sentModelRequests(page)).toEqual([
      { type: 'chat.model_request', chatId: 'chat_bus', model: 'claude-opus-4-1' },
    ]);
  });

  test('Cancel closes the modal and sends nothing', async ({ page }) => {
    await mockSettings(page, false);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-openai/gpt-5-codex').click();
    await page.getByTestId('provider-switch-cancel').click();

    await expect(page.getByTestId('provider-switch-modal')).toHaveCount(0);
    expect(await sentModelRequests(page)).toEqual([]);
  });

  test('Switch sends chat.model_request and closes the modal', async ({ page }) => {
    await mockSettings(page, false);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-openai/gpt-5-codex').click();
    await page.getByTestId('provider-switch-switch').click();

    await expect(page.getByTestId('provider-switch-modal')).toHaveCount(0);
    expect(await sentModelRequests(page)).toEqual([
      { type: 'chat.model_request', chatId: 'chat_bus', model: 'openai/gpt-5-codex' },
    ]);
  });

  test('"Don\'t show again" persists as an account setting via PATCH /api/settings', async ({
    page,
  }) => {
    const { getPatches } = await mockSettings(page, false);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-openai/gpt-5-codex').click();
    await page.getByTestId('provider-switch-dont-show-again').click();
    await page.getByTestId('provider-switch-switch').click();

    expect(getPatches()).toEqual([{ suppressProviderSwitchWarning: true }]);
    expect(await sentModelRequests(page)).toEqual([
      { type: 'chat.model_request', chatId: 'chat_bus', model: 'openai/gpt-5-codex' },
    ]);
  });

  test('never shows the modal once the account setting is already on', async ({ page }) => {
    await mockSettings(page, true);
    const settingsLoaded = page.waitForResponse('**/api/settings');
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    // The boot load of preferences is async (mirrors AppShell); the picker's
    // cross-provider decision reads it at click time, so the click must wait
    // for the real load to land or it bakes in the default (false).
    await settingsLoaded;
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-openai/gpt-5-codex').click();

    await expect(page.getByTestId('provider-switch-modal')).toHaveCount(0);
    expect(await sentModelRequests(page)).toEqual([
      { type: 'chat.model_request', chatId: 'chat_bus', model: 'openai/gpt-5-codex' },
    ]);
  });

  test('Settings has a toggle to bring the warning back', async ({ page }) => {
    const { getPatches } = await mockSettings(page, true);
    // Settings → Agent → Chats.
    await page.goto('/app/dev-harness.html?route=/settings/agent');
    const toggle = page.getByTestId('provider-switch-warning');
    await expect(toggle).toBeVisible();
    // Warning currently suppressed -> the "warn" toggle reads OFF.
    await expect(toggle).not.toBeChecked();
    // The visible control is the track+knob painted over the real (visually
    // hidden) checkbox — same click pattern every other Toggle e2e test here
    // uses (e.g. batch-notify-all-complete.spec.ts).
    await toggle.click({ force: true });
    expect(getPatches()).toEqual([{ suppressProviderSwitchWarning: false }]);
  });
});
