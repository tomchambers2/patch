import { test, expect } from '@playwright/test';

// spec/08 § Cron + spec/14 § Jobs view — a cron row reads as English.
//
// The bug this pins: the Jobs list had its own describer that only understood
// a fixed minute + hour, so 5 of the 16 distinct crons in Tom's live fleet
// rendered as raw cron ("cron · 0,30 7-22 * * *"). Every expression below is
// one of his live ones, read from `patch jobs list --json` on 15 Sep 2026.
// Tested in a real browser because the list cell is what he reads — a unit
// test on the describer can't tell you the row is wired to it.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const REAL_SCHEDULES: ReadonlyArray<[id: string, name: string, cron: string, label: string]> = [
  // The five that used to fall through to raw cron.
  ['photos', 'new photos', '*/5 * * * *', 'every 5 minutes'],
  ['deploy', 'deploy pending apps', '0 */4 * * *', 'every 4 hours'],
  ['foreman', 'foreman coach tick', '0 9-22 * * *', 'every hour between 9am and 10pm'],
  ['dygol', 'dygol watch', '0,30 7-22 * * *', 'every 30 minutes between 7am and 10pm'],
  [
    'catchup',
    'app updates catchup',
    '17 7,11,15,19 * * *',
    'at 7:17am, 11:17am, 3:17pm and 7:17pm',
  ],
  // And the fixed-time shapes, which must keep reading the way they always did.
  ['email', 'daily email update', '0 9 * * *', 'every day at 9am'],
  ['timesheet', 'weekly timesheet', '0 9 * * 5', 'Fridays at 9am'],
  ['meals', 'meal plan', '15 8 * * 1', 'Mondays at 8:15am'],
  // Two fire times a day, as the New-job form's "at 9am and 10pm" now produces.
  ['twice', 'twice daily', '0 9,22 * * *', 'at 9am and 10pm'],
];

const JOBS = [
  ...REAL_SCHEDULES.map(([id, name, cron], i) => ({
    id,
    name,
    enabled: true,
    trigger: { type: 'cron', expression: cron, timezone: 'Europe/London' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: name },
    createdAt: i + 1,
    updatedAt: i + 1,
  })),
  {
    // A shape the describer refuses to phrase still shows the raw expression,
    // clearly tagged — never a blank cell and never a guess.
    id: 'weird',
    name: 'hand-typed cron',
    enabled: true,
    trigger: { type: 'cron', expression: '*/5 9-17/2 * * *', timezone: 'Europe/London' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'x' },
    createdAt: 99,
    updatedAt: 99,
  },
];

async function stubJobs(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/jobs/*/runs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: JOBS }),
    }),
  );
}

test.describe('jobs list — cron schedules read as natural language', () => {
  test.use({ timezoneId: 'Europe/London' });

  test('every one of Tom’s real cron jobs shows a phrase, not an expression', async ({ page }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);

    for (const [id, , , label] of REAL_SCHEDULES) {
      await expect(page.getByTestId(`job-trigger-${id}`)).toHaveText(label);
    }

    // Not one of them leaks the raw-cron fallback.
    await expect(page.getByText('cron ·')).toHaveCount(1);
  });

  test('an unphraseable expression falls back to tagged raw cron, not a blank', async ({
    page,
  }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-trigger-weird')).toHaveText('cron · */5 9-17/2 * * *');
  });

  test('the phrase is searchable, because search matches what the row shows', async ({ page }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);
    await page.getByTestId('jobs-search').fill('between 7am and 10pm');
    await expect(page.getByTestId('job-dygol')).toBeVisible();
    await expect(page.getByTestId('job-foreman')).toHaveCount(0);
    await expect(page.getByTestId('job-photos')).toHaveCount(0);
  });
});
