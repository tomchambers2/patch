import { test, expect } from '@playwright/test';

// spec/11 § Version reporting. Patch deploys ~20 times a day, and every one of
// those downloads used to raise a "restart to install" button in the version
// panel — ~20 interruptions a day for an answer that was always yes. A
// downloaded update now installs and relaunches itself (desktop main.ts,
// `update-downloaded` → `installUpdateNow`), so this panel REPORTS the shell's
// update state and never asks for a restart.
//
// The Electron shell can't be driven from Linux, so what's pinned here is the
// renderer's half — booted through the real /settings route with the one thing
// the preload hands over (`window.patch`) stubbed, same trick as
// overlay-titlebar.spec.ts.

const SETTINGS = '/app/dev-harness.html?route=/settings/updates';

const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};

const VERSION_REPORT = {
  checkedAt: '2026-09-07T12:00:00.000Z',
  server: {
    version: '0.1.900',
    gitSha: '9b8635f',
    builtAt: '2026-09-07T10:00:00.000Z',
    startedAt: '2026-09-07T11:00:00.000Z',
    serverSha: '9b8635f',
  },
  web: {
    version: '0.1.900',
    gitSha: '9b8635f',
    builtAt: '2026-09-07T10:00:00.000Z',
    bundle: 'assets/index-CtWBatg1.js',
    expectedServerSha: '9b8635f',
    deployedAt: '2026-09-07T10:05:00.000Z',
  },
  daemon: null,
  desktop: null,
  android: null,
  clients: [],
  hosts: [],
  drift: [],
};

/** The updater state the shell would push while a downloaded build installs. */
const SHELL = {
  currentVersion: '0.1.899',
  gitSha: '9b8635f',
  builtAt: '2026-09-07T09:00:00.000Z',
  feedUrl: 'https://patch.tomchambers.me/api/desktop/',
  disabledReason: null,
  lastCheckedAt: '2026-09-07T11:55:00.000Z',
  lastResult: 'downloaded',
  lastError: null,
  availableVersion: '0.1.900',
  downloaded: true,
  checking: false,
  // Behind since yesterday, so the banner is at its middle ("due") level.
  staleSince: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
};

/** Boot the harness as if it were an Electron window whose shell has an update. */
async function asDesktopShell(
  page: import('@playwright/test').Page,
  shell: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript((state) => {
    (window as unknown as { __checks: number }).__checks = 0;
    (window as unknown as { __installs: number }).__installs = 0;
    (window as unknown as { patch: unknown }).patch = {
      getUpdaterState: () => Promise.resolve(state),
      checkForUpdates: () => {
        (window as unknown as { __checks: number }).__checks += 1;
        return Promise.resolve(state);
      },
      onUpdaterState: () => () => {},
      // Counted, never acted on: the point of these tests is that NOTHING
      // reaches this unless a person presses the button.
      installUpdate: () => {
        (window as unknown as { __installs: number }).__installs += 1;
      },
    };
  }, shell);
}

test.describe('version panel — updates wait to be taken', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
    );
    await page.route('**/api/settings', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          account: ME.account,
          devices: [],
          push: { tokenCount: 0 },
          daemon: { registered: false, status: 'offline', lastConnectedAt: null },
          projectFolders: [],
        }),
      }),
    );
    await page.route('**/api/version', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VERSION_REPORT),
      }),
    );
  });

  test('a downloaded update reports itself as ready, not as installing', async ({ page }) => {
    await asDesktopShell(page, SHELL);
    await page.goto(SETTINGS);

    const row = page.getByTestId('version-shell');
    await expect(row).toContainText('Desktop app');
    // It is staged, not underway — saying "installing" would describe something
    // that is not happening.
    await expect(row).toContainText('0.1.900 ready — restart to apply');
    await expect(row).not.toContainText('installing');
  });

  test('the banner offers the restart, and only a click takes it', async ({ page }) => {
    await asDesktopShell(page, SHELL);
    await page.goto(SETTINGS);

    const banner = page.getByTestId('desktop-update-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('0.1.900');
    // Behind since yesterday → the middle of the three levels.
    await expect(banner).toHaveAttribute('data-urgency', 'due');

    // Nothing has restarted the app just by it being here.
    expect(
      await page.evaluate(() => (window as unknown as { __installs: number }).__installs),
    ).toBe(0);

    await page.getByTestId('desktop-update-restart').click();
    expect(
      await page.evaluate(() => (window as unknown as { __installs: number }).__installs),
    ).toBe(1);
  });

  test('the banner escalates by how long the shell has been behind', async ({ page }) => {
    await asDesktopShell(page, {
      ...SHELL,
      staleSince: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.goto(SETTINGS);
    await expect(page.getByTestId('desktop-update-banner')).toHaveAttribute(
      'data-urgency',
      'overdue',
    );
  });

  test('a browser gets no banner — there is no shell to restart', async ({ page }) => {
    // No `window.patch` at all, which is what a real browser looks like.
    await page.goto(SETTINGS);
    await expect(page.getByTestId('desktop-update-banner')).toHaveCount(0);
  });

  test('still reports version, last update and last check, and checks on demand', async ({
    page,
  }) => {
    // House rule: every app has a page saying what it is running, when it last
    // updated and when it last checked, plus a manual check.
    await asDesktopShell(page, { ...SHELL, lastResult: 'up-to-date', downloaded: false });
    await page.goto(SETTINGS);

    // What this window runs and when it was deployed; what the shell runs; when
    // the versions were last read.
    await expect(page.getByTestId('version-app')).toContainText('This app');
    await expect(page.getByTestId('version-app')).toContainText('deployed');
    await expect(page.getByTestId('version-detail-server')).toContainText('0.1.900');
    await expect(page.getByTestId('version-shell')).toContainText('0.1.899');
    await expect(page.getByTestId('version-checked')).toContainText('Last checked');
    await expect(page.getByTestId('version-checked')).not.toContainText('—');

    await page.getByTestId('version-check-now').click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __checks: number }).__checks))
      .toBeGreaterThan(0);
  });

  test('an install the shell refused is surfaced verbatim', async ({ page }) => {
    // Squirrel.Mac refuses to apply an update to an adhoc-signed build. With no
    // prompt left, this error line is the ONLY way that reaches the user — it
    // must never be swallowed or read as "up to date".
    await asDesktopShell(page, {
      ...SHELL,
      lastResult: 'error',
      downloaded: false,
      lastError: 'Could not get code signature for running application',
    });
    await page.goto(SETTINGS);

    await expect(page.getByTestId('version-shell-error')).toContainText(
      'Could not get code signature for running application',
    );
    await expect(page.getByTestId('version-shell')).not.toContainText('up to date');
  });
});
