import { test, expect } from '@playwright/test';

// `Monitor` and `TaskStop` are disallowed native tools now (sdkBackend.ts's
// `DISALLOWED_NATIVE_TOOLS`, spec/14 § Monitors (historical)) — no chat can
// arm a new one, and there is no longer a background-task-bar row for one.
// `chat_bus` predates the change: its `Monitor` call must still replay as an
// ordinary tool-call row, real CSS included.
const BUS = '/app/dev-harness.html?chat=chat_bus';

test('a replayed Monitor call reads as a tool call naming what it watched, with no bar row', async ({
  page,
}) => {
  await page.goto(BUS);
  const row = page.locator('[data-testid="tool-call"][data-monitor="true"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Monitor · departures on the 36');
  await expect(row).toContainText('tail -f /var/log/bus.log');
  await expect(page.getByTestId('background-task-bar')).toHaveCount(0);
});
