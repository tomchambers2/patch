import { test, expect } from '@playwright/test';

// A job that is running carries the most chrome on its row (an "open chat"
// link and a "N queued" count beside the usual buttons). On a narrow screen
// that must not push "run now" out of the row or off the screen.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const RUNNING = {
  id: 'bus',
  name: 'bus-watch-with-a-fairly-long-name',
  enabled: true,
  queued: 2,
  trigger: { type: 'cron', expression: '57 8 * * 1-5' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/nearest-bus', skill: 'bus-watch' },
  latestRun: { ts: Date.now() - 60_000, status: 'ok', chatId: 'chat-1' },
  createdAt: 1,
  updatedAt: 1,
};

for (const width of [390, 600]) {
  test(`run now stays inside the row of a running job at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/api/jobs/*/runs**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"runs":[]}' }),
    );
    await page.route('**/api/jobs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [RUNNING] }),
      }),
    );
    await page.goto(JOBS_ROUTE);
    const row = await page.getByTestId('job-bus').boundingBox();
    const btn = await page.getByTestId('job-run-now-bus').boundingBox();
    expect(row).not.toBeNull();
    expect(btn).not.toBeNull();
    expect(btn!.x).toBeGreaterThanOrEqual(row!.x);
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(row!.x + row!.width + 0.5);
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(width);
  });
}
