import { test, expect, type Page } from '@playwright/test';

// spec/10 § Surface in Settings — Usage: when a machine has no credit left on
// ANY account, every chat on it says so.
//
// The per-chat bubble reaches only the chat you happen to have open. It cannot
// tell you that the other twenty are parked too, or that the cron jobs about to
// fire will park as well. On 2026-09-11 that was the whole experience: every
// account spent, every chat silently stuck, and no way to learn it except by
// opening one and reading the bottom of the transcript.
//
// The half worth guarding in a real browser is the SILENCE. A banner that
// appears while an account still has credit trains everyone to ignore it, and
// then it is worth nothing on the day it is right.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

type Acct = { id: string; label: string; connected: boolean; usage?: unknown };

async function report(page: Page, accounts: Acct[]): Promise<void> {
  await page.evaluate((accts) => {
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
      connected: accts.some((a) => a.connected),
      accountEmail: null,
      accounts: accts,
    });
  }, accounts);
}

const spent = (msFromNow: number) => ({
  session: { status: 'rejected', utilization: 1, resetsAt: Date.now() + msFromNow },
  at: Date.now(),
});
const fine = { session: { status: 'allowed', utilization: 0.3 }, at: Date.now() };

test.describe('out-of-usage banner', () => {
  test('names every spent account and the first one back', async ({ page }) => {
    await page.goto(HARNESS);
    await report(page, [
      { id: 'default', label: 'Default', connected: true, usage: spent(3 * 3_600_000) },
      { id: 'work', label: 'work', connected: true, usage: spent(49 * 60_000) },
    ]);

    const banner = page.getByTestId('out-of-usage-banner');
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('out-of-usage-accounts')).toHaveText('Default and work');
    // The soonest, because that is when you can start again — not the first in
    // the list, and not an average of the two.
    await expect(page.getByTestId('out-of-usage-reset')).toContainText('work resets at');
    await expect(page.getByTestId('out-of-usage-reset')).toContainText(/\(\d+ minutes\)/);
    // One line, two facts. No machine name, and no sentence explaining what a
    // limit is — the banner's job is what is out and when it is back.
    await expect(banner).not.toContainText(/nothing can run/i);
  });

  test('says nothing while one account still has credit', async ({ page }) => {
    await page.goto(HARNESS);
    await report(page, [
      { id: 'default', label: 'Default', connected: true, usage: spent(3 * 3_600_000) },
      { id: 'work', label: 'work', connected: true, usage: fine },
    ]);
    await expect(page.getByTestId('out-of-usage-banner')).toHaveCount(0);
  });

  test('says nothing before a reading has landed — unknown is not spent', async ({ page }) => {
    await page.goto(HARNESS);
    // The state every cold start passes through. Warning here would mean
    // warning on every load.
    await report(page, [
      { id: 'default', label: 'Default', connected: true },
      { id: 'work', label: 'work', connected: true },
    ]);
    await expect(page.getByTestId('out-of-usage-banner')).toHaveCount(0);
  });

  test('says nothing when the machine is not signed in — that is the other banner', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await report(page, [{ id: 'default', label: 'Default', connected: false }]);
    await expect(page.getByTestId('out-of-usage-banner')).toHaveCount(0);
  });

  test('appears in a DIFFERENT chat on the same machine, because credit is the machine’s', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await report(page, [
      { id: 'default', label: 'Default', connected: true, usage: spent(49 * 60_000) },
    ]);
    await expect(page.getByTestId('out-of-usage-banner')).toBeVisible();

    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await report(page, [
      { id: 'default', label: 'Default', connected: true, usage: spent(49 * 60_000) },
    ]);
    await expect(page.getByTestId('out-of-usage-banner')).toBeVisible();
  });

  test('an account that stated no reset says so rather than inventing a time', async ({ page }) => {
    await page.goto(HARNESS);
    await report(page, [
      {
        id: 'default',
        label: 'Default',
        connected: true,
        usage: { session: { status: 'rejected', utilization: 1 }, at: Date.now() },
      },
    ]);
    await expect(page.getByTestId('out-of-usage-reset')).toContainText(/no reset time/i);
  });
});
