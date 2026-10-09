import { test, expect } from '@playwright/test';

// Real-browser e2e for Settings → Hosts → This Mac (spec/02 § Desktop app and
// the local host): the desktop shell's bridge is stubbed the way the shell's
// preload exposes it, since the harness runs in a plain browser.
const HOSTS = '/app/dev-harness.html?route=/settings/hosts';

test.describe('this Mac as a host', () => {
  test('installs the host with a code minted for it, and says when it fails', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { patch?: Record<string, unknown>; __installs: string[] };
      w.__installs = [];
      w.patch = {
        ...(w.patch ?? {}),
        localDaemon: {
          status: async () => ({ installed: false, daemonId: null }),
          install: async (code: string) => {
            w.__installs.push(code);
            return { ok: false, exitCode: 75, output: 'patch install: the code expired' };
          },
        },
      };
    });
    await page.route('**/api/auth/daemon/pair/start', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ nonce: 'e2e-code-0123456789', expiresAt: Date.now() + 60_000 }),
      }),
    );
    await page.goto(HOSTS);

    await page.getByTestId('this-mac-install').click();
    await expect(page.getByTestId('this-mac-error')).toHaveText('patch install: the code expired');
    expect(
      await page.evaluate(() => (window as unknown as { __installs: string[] }).__installs),
    ).toEqual(['e2e-code-0123456789']);
  });

  test('is not offered in a plain browser', async ({ page }) => {
    await page.goto(HOSTS);
    await expect(page.getByTestId('settings-hosts')).toBeVisible();
    await expect(page.getByTestId('this-mac')).toHaveCount(0);
  });
});
