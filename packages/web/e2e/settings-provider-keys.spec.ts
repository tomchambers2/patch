import { test, expect } from '@playwright/test';
import { NO_SECRETS, reportHost, settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for Settings → Keys (spec/02 § Provider keys, spec/01 §
// Settings). The keys are shared settings, held on the server: each row says
// whether a key is set and its last four characters — never the value — and a
// key only a host's environment supplies names that host and can be adopted.
// The REST writes are answered by the harness's fake server; the dev harness
// seeds host `d1` ("dev-host") with Groq in its environment.
const FAKE_KEY = 'fake-gemini-key-for-e2e-000000-LAST';

const GEMINI_ON_DICTATION = {
  voiceConfig: {
    dictation: { backend: 'gemini' },
    device: { backend: 'local', layer: 'direct', handoff: 'auto' },
    handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
    call: { backend: 'local', layer: 'direct', handoff: 'auto' },
  },
};

test.describe('Settings — Keys', () => {
  test('shows whether each key is set, and names the host whose environment supplies one', async ({
    page,
  }) => {
    await stubSettingsApi(page, { preferences: GEMINI_ON_DICTATION });
    await page.goto(settingsUrl('keys'));
    await expect(page.getByTestId('provider-key-gemini-status')).toHaveText('Not set');
    await expect(page.getByTestId('provider-key-groq-status')).toHaveText(
      'From the environment on dev-host',
    );
    await expect(page.getByTestId('provider-key-groq-revoke')).toHaveCount(0);
    await expect(page.getByTestId('provider-key-groq-adopt')).toBeVisible();
  });

  test('adding a key sends it once, masked, and the answer settles Keys; the host’s report settles Voice', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page, {
      preferences: GEMINI_ON_DICTATION,
      answer: (w, srv) => {
        if (w.method === 'PUT' && w.path === '/api/providers/keys/gemini') {
          srv.secrets = {
            ...srv.secrets,
            providerKeys: srv.secrets.providerKeys.map((k) =>
              k.id === 'gemini' ? { id: 'gemini', set: true, last4: 'LAST' } : k,
            ),
          };
        }
      },
    });
    await page.goto(settingsUrl('voice'));
    await expect(page.getByTestId('voice-dictation-keys')).toContainText(
      'GEMINI_API_KEY is missing',
    );
    await page.getByTestId('settings-nav-keys').click();

    await page.getByTestId('provider-key-gemini-edit').click();
    const input = page.getByTestId('provider-key-gemini-input');
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill(FAKE_KEY);
    await page.getByTestId('provider-key-gemini-save').click();
    await expect(input).toHaveCount(0);
    expect(server.writes).toEqual([
      { method: 'PUT', path: '/api/providers/keys/gemini', body: { value: FAKE_KEY } },
    ]);
    await expect(page.getByTestId('provider-key-gemini-status')).toHaveText('Set · ends LAST');

    // The host applies the snapshot and republishes; Voice follows its report.
    await reportHost(page, {
      voiceKeys: { gemini: true, openai: false },
      providerKeys: [
        { id: 'gemini', source: 'ui', last4: 'LAST', envSet: false },
        { id: 'openai', source: 'none', envSet: false },
        { id: 'groq', source: 'env', last4: 'q9Zk', envSet: true },
      ],
    });
    await page.getByTestId('settings-nav-voice').click();
    await expect(page.getByTestId('settings-voice-config')).toBeVisible();
    await expect(page.getByTestId('voice-dictation-keys')).toHaveCount(0);
    expect(await page.content()).not.toContain(FAKE_KEY);
  });

  test('revoking asks first, then deletes it from every host', async ({ page }) => {
    const server = await stubSettingsApi(page, {
      secrets: {
        providerKeys: NO_SECRETS.providerKeys.map((k) =>
          k.id === 'gemini' ? { id: 'gemini', set: true, last4: 'LAST' } : k,
        ),
      },
    });
    await page.goto(settingsUrl('keys'));
    await expect(page.getByTestId('provider-key-gemini-status')).toHaveText('Set · ends LAST');
    await page.getByTestId('provider-key-gemini-revoke').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('from every host');
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect
      .poll(() => server.writes.map((w) => `${w.method} ${w.path}`))
      .toEqual(['DELETE /api/providers/keys/gemini']);
  });

  test('adopting a host’s environment key sends that host to the server', async ({ page }) => {
    const server = await stubSettingsApi(page);
    await page.goto(settingsUrl('keys'));
    await page.getByTestId('provider-key-groq-adopt').click();
    await expect
      .poll(() => server.writes)
      .toEqual([
        { method: 'POST', path: '/api/providers/keys/groq/adopt', body: { daemonId: 'd1' } },
      ]);
  });

  test('a refusal shows the server’s sentence', async ({ page }) => {
    await stubSettingsApi(page, {
      answer: (w) =>
        w.path === '/api/providers/keys/openai'
          ? {
              status: 400,
              body: {
                error: 'invalid_value',
                message: 'A key must be at least 16 characters with no whitespace',
              },
            }
          : undefined,
    });
    await page.goto(settingsUrl('keys'));
    await page.getByTestId('provider-key-openai-edit').click();
    await page.getByTestId('provider-key-openai-input').fill('short');
    await page.getByTestId('provider-key-openai-save').click();
    await expect(page.getByText('A key must be at least 16 characters')).toBeVisible();
  });
});
