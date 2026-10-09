import { test, expect, type Page } from '@playwright/test';
import { PIXEL_7, stubSettingsApi } from './settingsHarness.js';

// Tom, Todoist: "patch job back page only goes back to jobs instead of where
// you actually were. check all back buttons". A page's own Back control steps
// back through the history the user actually took, and only goes to the page's
// parent when there is nothing earlier to return to (spec/14 § Layout —
// desktop). The job editor's half is in job-editor-back.spec.ts; this covers the
// settings page ←, which always went to the settings list — so a page opened
// from a chat's banner link sent the user to a list they had never seen.

const CHAT = '/app/dev-harness.html?chat=chat_md';

/** A machine whose only account is spent, so the chat carries the Usage link. */
async function spendEveryAccount(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __presenceStore: {
        getState: () => {
          setHostReport: (e: unknown) => void;
          setHostAccount: (e: unknown) => void;
        };
      };
    };
    w.__presenceStore.getState().setHostReport({
      type: 'daemon.host',
      daemonId: 'd1',
      hostName: 'ubuntu-4gb-hel1-1',
      backends: [],
      components: [],
    });
    w.__presenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: 'd1',
      backendId: 'claude-code',
      connected: true,
      accountEmail: null,
      accounts: [
        {
          id: 'default',
          label: 'Default',
          connected: true,
          usage: {
            session: { status: 'rejected', utilization: 1, resetsAt: Date.now() + 3_600_000 },
            at: Date.now(),
          },
        },
      ],
    });
  });
}

test.describe('back controls return to where the user was', () => {
  test.use(PIXEL_7);

  test('a settings page opened from a chat goes back to that chat, not the settings list', async ({
    page,
  }) => {
    await stubSettingsApi(page);
    await page.goto(CHAT);
    await spendEveryAccount(page);
    const banner = page.getByTestId('out-of-usage-banner');
    await expect(banner).toBeVisible();

    await banner.getByRole('link', { name: 'Usage' }).tap();
    await expect(page.getByTestId('settings-usage')).toBeVisible();

    await page.getByTestId('settings-usage').getByTestId('settings-back').tap();

    await expect(page.getByTestId('settings-route')).toHaveCount(0);
    await expect(page.getByTestId('out-of-usage-banner')).toBeVisible();
  });

  test('a settings page loaded directly still goes back to the settings list', async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto('/app/dev-harness.html?route=/settings/usage');
    await expect(page.getByTestId('settings-usage')).toBeVisible();

    await page.getByTestId('settings-usage').getByTestId('settings-back').tap();

    await expect(page.getByTestId('settings-route')).toHaveAttribute('data-page', 'index');
    await expect(page.getByTestId('settings-nav')).toBeVisible();
  });
});
