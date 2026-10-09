import { test, expect } from '@playwright/test';
import { reportHost, settingsUrl, stubSettingsApi, wsSent } from './settingsHarness.js';

// Real-browser e2e for the DEFAULT permission mode in Settings → Agent (spec/02
// § Permission mode): a shared setting (spec/01 § Settings), written to the
// server, which sends it to every host. How many of a machine's chats are on a
// mode of their own is that machine's, shown on its Hosts page.
const AGENT = settingsUrl('agent');

test.describe('Settings → Agent → Permission mode', () => {
  test('offers exactly the five SDK mode names and writes the choice to the server', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page);
    await page.goto(AGENT);
    const select = page.getByTestId('permission-default');
    await expect(select).toHaveValue('auto');
    const options = await select.locator('option').allTextContents();
    expect(options).toEqual(['Auto', 'Default', 'Accept edits', 'Bypass permissions', 'Plan']);
    await select.selectOption('acceptEdits');
    await expect
      .poll(() => server.patches)
      .toContainEqual({ permissionModeDefault: 'acceptEdits' });
    await expect(select).toHaveValue('acceptEdits');
    // Nothing went to any one host.
    expect(await wsSent(page)).toEqual([]);
  });

  test('a host’s own count of chats on their own mode shows on its Hosts page', async ({
    page,
  }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('hosts'));
    await expect(page.getByTestId('host-d1-permission-overrides')).toHaveCount(0);
    await reportHost(page, { permissionOverrides: 3 });
    await expect(page.getByTestId('host-d1-permission-overrides')).toHaveText(
      '3 chats on their own mode',
    );
  });
});
