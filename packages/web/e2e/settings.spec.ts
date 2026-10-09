import { test, expect } from '@playwright/test';
import { SETTINGS_PAYLOAD, settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for the de-cluttered Settings pages (spec/14 § /settings,
// design/settings-redesign): titled groups of rows with live values and
// controls, and NO explainer prose. Account and Devices are the account-wide
// pages this file covers; the per-host pages have their own specs.

test.describe('settings pages — titles + values only, no explainer prose', () => {
  test('Account shows the account id and the server build', async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('account'));
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
    await expect(page.getByTestId('account-id')).toHaveText('acct-123');
    await expect(page.getByTestId('build-sha')).toHaveText('abc1234');
    await expect(page.getByTestId('build-origin')).toContainText('localhost');
  });

  test('Devices keeps its groups and live values', async ({ page }) => {
    await stubSettingsApi(page, {
      payload: {
        devices: [
          ...SETTINGS_PAYLOAD.devices,
          {
            surfaceId: 'phone-1',
            surfaceKind: 'mobile',
            label: 'Pixel',
            status: 'offline',
            isCurrent: false,
          },
        ],
      },
    });
    await page.goto(settingsUrl('devices'));
    await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Linked', exact: true })).toBeVisible();
    // The registered-push count is a value on the phone it is about, not a
    // heading of its own stating a bare number.
    await expect(page.getByTestId('device-phone-1')).toContainText('2 registered for push');
    await expect(page.getByTestId('device-web-1')).toContainText('This device');
    await expect(page.getByTestId('device-revoke-web-1')).toHaveCount(0);
    await expect(page.getByTestId('device-revoke-phone-1')).toBeVisible();
  });

  test('removes the explainer prose (hints) entirely', async ({ page }) => {
    await stubSettingsApi(page);
    for (const p of ['devices', 'account']) {
      await page.goto(settingsUrl(p));
      await expect(page.getByTestId('settings-main').locator('.set-page')).toBeVisible();
      await expect(page.getByTestId('push-desktop-note')).toHaveCount(0);
      await expect(page.getByTestId('google-not-configured')).toHaveCount(0);
      expect(await page.locator('.settings-route .hint').count()).toBe(0);
      await expect(page.locator('.settings-route')).not.toContainText('claude login');
    }
  });
});

// spec/14 § /settings details → "This surface": the destructive un-link action is
// named after what it does (deactivate THIS surface), never "log out", and is
// confirmed in the app's own dialog before anything is revoked.
test.describe('deactivate surface', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
  });

  test('the control is "Deactivate" — no log out / sign out wording', async ({ page }) => {
    await page.goto(settingsUrl('account'));
    await expect(page.getByTestId('deactivate-surface')).toHaveText('Deactivate');
    await expect(page.locator('.settings-route')).not.toContainText(/log ?out/i);
    await expect(page.locator('.settings-route')).not.toContainText(/sign ?out/i);
  });

  test('warns before deactivating, and cancelling revokes nothing', async ({ page }) => {
    const revokes: string[] = [];
    await page.route('**/api/auth/revoke', (r) => {
      revokes.push(r.request().postData() ?? '');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(settingsUrl('account'));
    await page.getByTestId('deactivate-surface').click();

    const dialog = page.getByTestId('confirm-modal');
    await expect(dialog).toBeVisible();
    // The warning has to say what is actually lost: this surface is revoked and
    // has to be paired again.
    await expect(dialog).toContainText(/pair/i);
    await expect(page.getByTestId('confirm-ok')).toHaveText('Deactivate');

    await page.getByTestId('confirm-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(revokes).toEqual([]);
    await expect(page.getByTestId('deactivate-surface')).toBeVisible();
  });

  test('confirming self-revokes this surface', async ({ page }) => {
    const revokes: string[] = [];
    await page.route('**/api/auth/revoke', (r) => {
      revokes.push(r.request().postData() ?? '');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(settingsUrl('account'));
    await expect(page.getByTestId('account-id')).toHaveText('acct-123'); // `me` loaded
    await page.getByTestId('deactivate-surface').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => revokes.join('|')).toContain('web-1');
  });
});
