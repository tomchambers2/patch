import { test, expect, type Page } from '@playwright/test';

// Patch Updates: "Patch unclear whether host offline or not. Dot should
// show status, and a bar when something not connected on main screen."
//
// Two bugs, both from the same cause: the sidebar's connection dot read only
// the WS→server link, and the daemon-offline banner rendered inside ChatRoute
// only — so a WS that stayed up while every host dropped looked perfectly
// healthy everywhere except inside a chat you already had open. spec/12
// § Surface connection state model: "There is no window where the UI says
// connected while the agent is actually unreachable."

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

function setDaemonOnline(page: Page, online: boolean): Promise<void> {
  return page.evaluate((isOnline) => {
    const w = window as unknown as {
      __presenceStore: { getState: () => { setHostOnline: (id: string, online: boolean) => void } };
    };
    w.__presenceStore.getState().setHostOnline('d1', isOnline);
  }, online);
}

test.describe('host offline indicator', () => {
  test('the daemon-offline banner appears on a non-chat route (Jobs), not only inside an open chat', async ({
    page,
  }) => {
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('jobs-route')).toBeVisible();
    await expect(page.getByTestId('daemon-offline-banner')).toHaveCount(0);

    await setDaemonOnline(page, false);
    await expect(page.getByTestId('daemon-offline-banner')).toBeVisible();
    await expect(page.getByTestId('daemon-offline-banner')).toContainText('Agent offline');

    // And clears once the host is back, without leaving the Jobs page.
    await setDaemonOnline(page, true);
    await expect(page.getByTestId('daemon-offline-banner')).toHaveCount(0);
    await expect(page.getByTestId('jobs-route')).toBeVisible();
  });

  test('the sidebar connection dot goes offline-styled when the host drops, even though the WS link stays connected', async ({
    page,
  }) => {
    await page.goto(JOBS_ROUTE);
    const dot = page.getByTestId('conn-dot');
    await expect(dot).not.toHaveClass(/offline/);
    await expect(dot).toHaveAttribute('title', 'Connected');

    await setDaemonOnline(page, false);
    await expect(dot).toHaveClass(/offline/);
    await expect(dot).toHaveAttribute('title', 'Agent offline');

    await setDaemonOnline(page, true);
    await expect(dot).not.toHaveClass(/offline/);
    await expect(dot).toHaveAttribute('title', 'Connected');
  });
});
