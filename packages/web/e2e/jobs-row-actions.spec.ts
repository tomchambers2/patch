import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Jobs view: every row carries an archive and a
// delete control. Archive is reversible and asks nothing — the job folds into
// the Archived section, collapsed and counted, and the same control brings it
// back. Delete is permanent and goes through the app's confirm modal.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const LIVE = {
  id: 'bus',
  name: 'bus-watch',
  enabled: true,
  trigger: { type: 'cron', expression: '57 8 * * 1-5' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/nearest-bus', skill: 'bus-watch' },
  createdAt: 1,
  updatedAt: 1,
};

const ARCHIVED = {
  ...LIVE,
  id: 'old',
  name: 'old rain watcher',
  archived: true,
  createdAt: 2,
  updatedAt: 2,
};

interface Write {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Serve the list, and record every non-GET call. The list body is read from a
 * mutable holder so a test can change what the refetch after a mutation sees.
 */
async function stubJobs(
  page: import('@playwright/test').Page,
  state: { jobs: unknown[] },
): Promise<Write[]> {
  const writes: Write[] = [];
  await page.route('**/api/jobs/*/runs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route('**/api/jobs**', (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      writes.push({ method: req.method(), url: req.url(), body: req.postDataJSON() ?? null });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: state.jobs }),
    });
  });
  return writes;
}

test.describe('jobs row actions', () => {
  test('archive PATCHes the job and folds it into a counted Archived section', async ({ page }) => {
    const state = { jobs: [LIVE] as unknown[] };
    const writes = await stubJobs(page, state);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();
    // Nothing archived yet, so no section for it.
    await expect(page.getByTestId('jobs-section-archived')).toHaveCount(0);

    // The refetch the mutation triggers sees the archived job.
    state.jobs = [{ ...LIVE, archived: true }];
    await page.getByTestId('job-archive-bus').click();

    await expect(page.getByTestId('jobs-archived-toggle')).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[0]!.body).toEqual({ archived: true });

    // Folded away: counted on the header, rows not rendered, main list gone.
    await expect(page.getByTestId('jobs-archived-count')).toHaveText('1');
    await expect(page.getByTestId('jobs-archived-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByTestId('job-bus')).toHaveCount(0);
  });

  test('an archived row is muted, its switch is dead, and unarchive brings it back', async ({
    page,
  }) => {
    const state = { jobs: [LIVE, ARCHIVED] as unknown[] };
    const writes = await stubJobs(page, state);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await expect(page.getByTestId('job-old')).toHaveCount(0);

    await page.getByTestId('jobs-archived-toggle').click();
    const row = page.getByTestId('job-old');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/archived/);
    await expect(page.getByTestId('job-toggle-old')).toBeDisabled();
    await expect(page.getByTestId('job-toggle-bus')).toBeEnabled();
    const opacity = await row.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThan(1);

    state.jobs = [LIVE, { ...ARCHIVED, archived: false }];
    await page.getByTestId('job-archive-old').click();

    await expect(page.getByTestId('jobs-section-archived')).toHaveCount(0);
    await expect(page.getByTestId('job-old')).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ archived: false });
  });

  test('delete asks first: cancelling writes nothing, confirming DELETEs the job', async ({
    page,
  }) => {
    const state = { jobs: [LIVE] as unknown[] };
    const writes = await stubJobs(page, state);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    await page.getByTestId('job-delete-bus').click();
    await expect(page.getByTestId('confirm-modal')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-modal')).toHaveCount(0);
    expect(writes).toHaveLength(0);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    state.jobs = [];
    await page.getByTestId('job-delete-bus').click();
    await expect(page.getByTestId('confirm-modal')).toBeVisible();
    await page.getByTestId('confirm-ok').click();

    await expect(page.getByTestId('jobs-empty')).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe('DELETE');
    expect(writes[0]!.url).toContain('/api/jobs/bus');
  });

  test('the archived section is drawn last, after recurring and expired', async ({ page }) => {
    const expired = {
      ...LIVE,
      id: 'spent',
      name: 'book the dentist',
      enabled: false,
      oneOff: true,
      expiredAt: 1_700_000_000_000,
    };
    await stubJobs(page, { jobs: [ARCHIVED, expired, LIVE] });
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    const heads = page.locator('.jobs-section-head');
    await expect(heads).toHaveCount(3);
    await expect(heads.nth(0)).toHaveText(/Recurring/i);
    await expect(heads.nth(1)).toHaveText(/Expired/i);
    await expect(heads.nth(2)).toHaveText(/Archived/i);
  });

  test('a delete failure surfaces the error rather than pretending it took', async ({ page }) => {
    await page.route('**/api/jobs/*/runs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runs: [] }),
      }),
    );
    await page.route('**/api/jobs**', (route) => {
      if (route.request().method() !== 'GET') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'db locked' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [LIVE] }),
      });
    });
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    await page.getByTestId('job-delete-bus').click();
    await page.getByTestId('confirm-ok').click();

    await expect(page.getByTestId('error-toasts')).toContainText(/delete failed/i);
    // The job is still there — nothing silently vanished.
    await expect(page.getByTestId('job-bus')).toBeVisible();
  });
});
