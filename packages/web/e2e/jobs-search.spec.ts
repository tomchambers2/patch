import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Jobs view: one search field in the Jobs head
// narrows the list as you type, over the job name, the natural-language
// trigger label and the action verb + target.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const JOBS = [
  {
    id: 'bus',
    name: 'bus-watch',
    enabled: true,
    trigger: { type: 'cron', expression: '57 8 * * 1-5' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/nearest-bus', skill: 'bus-watch' },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'gh',
    name: 'github merge alerts',
    enabled: false,
    trigger: { type: 'webhook', scheme: 'github' },
    filter: null,
    action: { type: 'message', chatId: 'thread_manager', prompt: 'summarise the merge' },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'td',
    name: 'app updates',
    enabled: true,
    trigger: { type: 'todoist', filter: null },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/portfolio', skill: 'app-update' },
    createdAt: 1,
    updatedAt: 1,
  },
];

async function stubJobs(page: import('@playwright/test').Page) {
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

test.describe('jobs search', () => {
  test.beforeEach(async ({ page }) => {
    await stubJobs(page);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();
  });

  test('the field sits on the head row beside New job, and is a real text field', async ({
    page,
  }) => {
    const search = page.getByTestId('jobs-search');
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', 'Search jobs');

    // One row: the title, the field and the primary action share a centre-line.
    const head = page.locator('.route-head');
    const headBox = (await head.boundingBox())!;
    const searchBox = (await search.boundingBox())!;
    const newBox = (await page.getByTestId('jobs-new').boundingBox())!;
    expect(searchBox.y).toBeGreaterThanOrEqual(headBox.y);
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(headBox.y + headBox.height + 1);
    // It reads as an editable field, not as paper: white fill and a border.
    const border = await search.evaluate((el) => getComputedStyle(el).borderBottomWidth);
    expect(parseFloat(border)).toBeGreaterThan(0);
    // Sits left of the New job button, not overlapping it.
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(newBox.x + 1);
  });

  test('typing narrows the list by name, by trigger and by action target', async ({ page }) => {
    const search = page.getByTestId('jobs-search');

    await search.fill('github');
    await expect(page.getByTestId('job-gh')).toBeVisible();
    await expect(page.getByTestId('job-bus')).toHaveCount(0);
    await expect(page.getByTestId('job-td')).toHaveCount(0);

    // Trigger type, via its natural-language label.
    await search.fill('todoist');
    await expect(page.getByTestId('job-td')).toBeVisible();
    await expect(page.getByTestId('job-gh')).toHaveCount(0);

    // Action target: the skill a job runs.
    await search.fill('bus-watch');
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await expect(page.getByTestId('job-td')).toHaveCount(0);

    // Verb axis — both spawns, not the message job.
    await search.fill('spawn');
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await expect(page.getByTestId('job-td')).toBeVisible();
    await expect(page.getByTestId('job-gh')).toHaveCount(0);
  });

  test('a query matching nothing says so and keeps the field, without the empty-jobs graphic', async ({
    page,
  }) => {
    const search = page.getByTestId('jobs-search');
    await search.fill('zzzz-no-such-job');

    const none = page.getByTestId('jobs-no-matches');
    await expect(none).toBeVisible();
    await expect(none).toContainText('zzzz-no-such-job');
    await expect(page.getByTestId('jobs-empty')).toHaveCount(0);
    await expect(page.getByTestId('jobs-list')).toHaveCount(0);
    // The query survives so it can be corrected in place.
    await expect(search).toHaveValue('zzzz-no-such-job');
    await expect(search).toBeVisible();
  });

  test('clearing the query brings every job back', async ({ page }) => {
    const search = page.getByTestId('jobs-search');
    await search.fill('github');
    await expect(page.getByTestId('job-bus')).toHaveCount(0);
    await search.fill('');
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await expect(page.getByTestId('job-gh')).toBeVisible();
    await expect(page.getByTestId('job-td')).toBeVisible();
  });

  test('a folder-addressed row reads its host name and folder together, and search finds it by host name (spec/14 § Jobs view)', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __presenceStore: { getState: () => { setHostReport: (e: unknown) => void } };
      };
      w.__presenceStore.getState().setHostReport({
        type: 'daemon.host',
        daemonId: 'd1',
        hostName: 'laptop',
        backends: [],
        components: [],
      });
    });

    await expect(page.getByTestId('job-action-bus')).toContainText('laptop');

    const search = page.getByTestId('jobs-search');
    await search.fill('laptop');
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await expect(page.getByTestId('job-td')).toBeVisible();
    await expect(page.getByTestId('job-gh')).toHaveCount(0);
  });

  test('there is no field to search when there are no jobs', async ({ page }) => {
    await page.route('**/api/jobs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('jobs-empty')).toBeVisible();
    await expect(page.getByTestId('jobs-search')).toHaveCount(0);
  });
});
