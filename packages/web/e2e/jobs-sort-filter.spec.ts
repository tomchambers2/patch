import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Jobs view: a sort control and two filter
// controls sit beside the search in the Jobs head. Sort orders the rows within
// each section, the filters narrow on status and trigger type, and all of them
// compose with the search.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const JOBS = [
  {
    id: 'alpha',
    name: 'alpha watcher',
    enabled: true,
    trigger: { type: 'cron', expression: '0 9 * * *' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/alpha', skill: 'alpha' },
    createdAt: 100,
    updatedAt: 100,
    latestRun: { ts: 1_700_000_001_000, status: 'ok' },
  },
  {
    id: 'zulu',
    name: 'zulu hook',
    enabled: false,
    trigger: { type: 'webhook', scheme: 'github' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/zulu', skill: 'zulu' },
    createdAt: 300,
    updatedAt: 300,
    latestRun: { ts: 1_700_000_003_000, status: 'ok' },
  },
  {
    id: 'mike',
    name: 'mike todoist',
    enabled: true,
    trigger: { type: 'todoist', filter: null },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/mike', skill: 'mike' },
    createdAt: 200,
    updatedAt: 200,
    // Never fired.
    latestRun: null,
  },
];

async function stubJobs(page: import('@playwright/test').Page, jobs: unknown[] = JOBS) {
  // Broad handler first, per-job ones after: Playwright matches in REVERSE
  // registration order, so the narrower route must be registered last.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs }),
    }),
  );
  await page.route('**/api/jobs/*/runs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
}

/** The rows as drawn, top to bottom, by job id. */
async function rowOrder(
  page: import('@playwright/test').Page,
  testid = 'jobs-list',
): Promise<string[]> {
  return page
    .getByTestId(testid)
    .locator('li.job-row')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute('data-testid') ?? '').replace(/^job-/, '')),
    );
}

test.describe('jobs sort and filter', () => {
  test.beforeEach(async ({ page }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-alpha')).toBeVisible();
  });

  test('the three controls share the head row with the search and New job', async ({ page }) => {
    const sort = page.getByTestId('jobs-sort');
    const status = page.getByTestId('jobs-filter-status');
    const trigger = page.getByTestId('jobs-filter-trigger');
    await expect(sort).toBeVisible();
    await expect(status).toBeVisible();
    await expect(trigger).toBeVisible();

    const headBox = (await page.locator('.route-head').boundingBox())!;
    const newBox = (await page.getByTestId('jobs-new').boundingBox())!;
    let left = (await page.getByTestId('jobs-search').boundingBox())!.x;
    for (const control of [sort, status, trigger]) {
      const box = (await control.boundingBox())!;
      // On the head's own row, in order, and clear of the primary action.
      expect(box.y).toBeGreaterThanOrEqual(headBox.y);
      expect(box.y + box.height).toBeLessThanOrEqual(headBox.y + headBox.height + 1);
      expect(box.x).toBeGreaterThan(left);
      expect(box.x + box.width).toBeLessThanOrEqual(newBox.x + 1);
      left = box.x;
    }
    // No caption or helper text anywhere in the head.
    await expect(page.locator('.route-head')).not.toContainText('Sort by');
    await expect(page.locator('.route-head')).not.toContainText('Filter');
  });

  test('the list opens on last fired — newest fire first, never-fired last', async ({ page }) => {
    await expect(page.getByTestId('jobs-sort')).toHaveValue('last-fired');
    expect(await rowOrder(page)).toEqual(['zulu', 'alpha', 'mike']);
    await expect(page.getByTestId('job-last-fired-mike')).toHaveText('never');
  });

  test('choosing a sort re-orders the rows', async ({ page }) => {
    const sort = page.getByTestId('jobs-sort');
    await sort.selectOption('name');
    expect(await rowOrder(page)).toEqual(['alpha', 'mike', 'zulu']);
    await sort.selectOption('created');
    expect(await rowOrder(page)).toEqual(['zulu', 'mike', 'alpha']);
    await sort.selectOption('last-fired');
    expect(await rowOrder(page)).toEqual(['zulu', 'alpha', 'mike']);
  });

  test('the filters narrow on status and on trigger type, and compose', async ({ page }) => {
    const status = page.getByTestId('jobs-filter-status');
    const trigger = page.getByTestId('jobs-filter-trigger');

    await status.selectOption('disabled');
    expect(await rowOrder(page)).toEqual(['zulu']);

    await status.selectOption('enabled');
    expect(await rowOrder(page)).toEqual(['alpha', 'mike']);

    await trigger.selectOption('todoist');
    expect(await rowOrder(page)).toEqual(['mike']);

    await status.selectOption('all');
    await trigger.selectOption('webhook');
    expect(await rowOrder(page)).toEqual(['zulu']);
  });

  test('a filter composes with the search field by AND', async ({ page }) => {
    const search = page.getByTestId('jobs-search');
    await search.fill('spawn');
    expect(await rowOrder(page)).toEqual(['zulu', 'alpha', 'mike']);
    await page.getByTestId('jobs-filter-trigger').selectOption('cron');
    expect(await rowOrder(page)).toEqual(['alpha']);
    await search.fill('zulu');
    await expect(page.getByTestId('jobs-no-matches')).toBeVisible();
  });

  test('a filter that matches nothing says so, keeping the controls and not the empty graphic', async ({
    page,
  }) => {
    await page.getByTestId('jobs-filter-status').selectOption('disabled');
    await page.getByTestId('jobs-filter-trigger').selectOption('todoist');
    const none = page.getByTestId('jobs-no-matches');
    await expect(none).toBeVisible();
    await expect(none).toHaveText('No jobs match the filter');
    await expect(page.getByTestId('jobs-empty')).toHaveCount(0);
    await expect(page.getByTestId('jobs-list')).toHaveCount(0);
    // The controls survive so the narrowing can be undone in place.
    await expect(page.getByTestId('jobs-filter-status')).toHaveValue('disabled');
    await page.getByTestId('jobs-filter-trigger').selectOption('all');
    expect(await rowOrder(page)).toEqual(['zulu']);
  });

  test('sort and filter survive navigating away and back', async ({ page }) => {
    await page.route('**/api/folders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hosts: [] }),
      }),
    );
    // The editor reads the SINGLE-job route, which answers with a bare job.
    // Registered last so it wins over the broad list handler.
    await page.route('**/api/jobs/alpha', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(JOBS[0]),
      }),
    );
    await page.getByTestId('jobs-sort').selectOption('name');
    await page.getByTestId('jobs-filter-status').selectOption('enabled');
    // Into the editor for a job, then back out of it by its own back control.
    await page.getByTestId('job-alpha').locator('a.job-link').click();
    await expect(page.getByTestId('jobs-route')).toHaveCount(0);
    // Wait for the editor to finish loading the job before leaving it: it
    // re-renders as the fetch lands, detaching the back button mid-click.
    await expect(page.getByTestId('job-name')).toHaveValue('alpha watcher');
    await page.getByTestId('job-editor-back').click();
    await expect(page.getByTestId('jobs-sort')).toHaveValue('name');
    await expect(page.getByTestId('jobs-filter-status')).toHaveValue('enabled');
    expect(await rowOrder(page)).toEqual(['alpha', 'mike']);
  });

  test('there are no sort or filter controls when there are no jobs', async ({ page }) => {
    await stubJobs(page, []);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('jobs-empty')).toBeVisible();
    await expect(page.getByTestId('jobs-sort')).toHaveCount(0);
    await expect(page.getByTestId('jobs-filter-status')).toHaveCount(0);
    await expect(page.getByTestId('jobs-filter-trigger')).toHaveCount(0);
  });
});
