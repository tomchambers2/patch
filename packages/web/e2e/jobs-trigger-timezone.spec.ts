import { test, expect } from '@playwright/test';

// spec/14 § Jobs view — a cron row names the zone it runs in whenever that is
// not the reader's own.
//
// The bug this pins: Tom's jobs carried no `timezone`, so they evaluated as
// UTC (spec/08 § Cron) while the row read "weekdays at 9am" — and they fired
// at 10:00 BST. The row has to be unambiguous about which 9am it means, while
// staying silent for the ordinary case where the job runs where you are.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const JOBS = [
  {
    // Pre-timezone: no zone at all, so it runs in UTC.
    id: 'utc',
    name: 'weekly timesheet',
    enabled: true,
    trigger: { type: 'cron', expression: '0 9 * * 5' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'weekly-timesheet' },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    // Migrated: runs in the viewer's own zone, so the row says nothing extra.
    id: 'london',
    name: 'daily email update',
    enabled: true,
    trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'daily-email' },
    createdAt: 2,
    updatedAt: 2,
  },
  {
    // Somewhere else entirely.
    id: 'ny',
    name: 'new york standup',
    enabled: true,
    trigger: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'standup' },
    createdAt: 3,
    updatedAt: 3,
  },
  {
    // Not a cron trigger — no zone to name, and none must appear.
    id: 'hook',
    name: 'github merge alerts',
    enabled: true,
    trigger: { type: 'webhook', scheme: 'github' },
    filter: null,
    action: { type: 'message', chatId: 'thread_manager', prompt: 'summarise' },
    createdAt: 4,
    updatedAt: 4,
  },
];

async function stubJobs(page: import('@playwright/test').Page): Promise<void> {
  // Row-level runs lookups first — they are also under /api/jobs.
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

// The reader is in London — the zone Tom's jobs were authored in.
test.describe('jobs list — cron zone labelling, read from Europe/London', () => {
  test.use({ timezoneId: 'Europe/London' });

  test('a UTC job is labelled, a London job is not, and elsewhere is named', async ({ page }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);

    // The pre-timezone job runs in UTC, which is NOT this reader's zone in
    // BST — so "9am" must be qualified rather than read as local 9am.
    await expect(page.getByTestId('job-trigger-utc')).toHaveText('Fridays at 9am · UTC');

    // The migrated job runs where the reader is: no label, no noise.
    await expect(page.getByTestId('job-trigger-london')).toHaveText('every day at 9am');

    // A genuinely foreign zone is named in full.
    await expect(page.getByTestId('job-trigger-ny')).toHaveText(
      'weekdays at 9am · America/New_York',
    );

    // A non-cron trigger has no schedule and gains nothing.
    await expect(page.getByTestId('job-trigger-hook')).toHaveText('github webhook');
  });

  test('the zone label is searchable, because search matches what the row shows', async ({
    page,
  }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);
    await page.getByTestId('jobs-search').fill('America/New_York');
    await expect(page.getByTestId('job-ny')).toBeVisible();
    await expect(page.getByTestId('job-utc')).toHaveCount(0);
  });
});

// The mirror image: read from UTC, the UTC job is the unlabelled one.
test.describe('jobs list — cron zone labelling, read from UTC', () => {
  test.use({ timezoneId: 'UTC' });

  test('a UTC job needs no label to a UTC reader, but a London job does', async ({ page }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-trigger-utc')).toHaveText('Fridays at 9am');
    await expect(page.getByTestId('job-trigger-london')).toHaveText(
      'every day at 9am · Europe/London',
    );
  });
});
