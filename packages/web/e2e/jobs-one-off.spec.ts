import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Jobs view: the list is grouped into
// recurring / one-off / expired, the expired group is collapsed by default and
// counted on its header, and an expired row's enable switch is dead.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const RECURRING = {
  id: 'bus',
  name: 'bus-watch',
  enabled: true,
  trigger: { type: 'cron', expression: '57 8 * * 1-5' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/nearest-bus', skill: 'bus-watch' },
  createdAt: 1,
  updatedAt: 1,
};

const PENDING_ONE_OFF = {
  id: 'parcel',
  name: 'parcel arrival',
  enabled: true,
  oneOff: true,
  trigger: { type: 'webhook', scheme: 'none' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/portfolio', prompt: 'track it' },
  createdAt: 2,
  updatedAt: 2,
};

const EXPIRED_A = {
  id: 'spent',
  name: 'book the dentist',
  enabled: false,
  oneOff: true,
  expiredAt: 1_700_000_000_000,
  trigger: { type: 'cron', expression: '0 9 * * *' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/portfolio', prompt: 'ring them' },
  createdAt: 3,
  updatedAt: 3,
};

const EXPIRED_B = {
  ...EXPIRED_A,
  id: 'spent2',
  name: 'renew the passport',
  expiredAt: 1_700_000_500_000,
};

async function stubJobs(page: import('@playwright/test').Page, jobs: unknown[]) {
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
      body: JSON.stringify({ jobs }),
    }),
  );
}

test.describe('jobs one-off grouping', () => {
  test('with no one-off jobs the page is one ungrouped list, exactly as before', async ({
    page,
  }) => {
    await stubJobs(page, [RECURRING]);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    await expect(page.getByTestId('jobs-list')).toBeVisible();
    // No section headers at all, and neither one-off section exists.
    await expect(page.getByTestId('jobs-section-one-off')).toHaveCount(0);
    await expect(page.getByTestId('jobs-section-expired')).toHaveCount(0);
    await expect(page.locator('.jobs-section-head')).toHaveCount(0);
  });

  test('expired jobs are collapsed behind a counted header; the others are open', async ({
    page,
  }) => {
    await stubJobs(page, [RECURRING, PENDING_ONE_OFF, EXPIRED_A, EXPIRED_B]);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    // Recurring and pending one-off are expanded.
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await expect(page.getByTestId('job-parcel')).toBeVisible();
    await expect(page.getByTestId('jobs-list-one-off')).toBeVisible();

    // Expired is present, counted, and its rows are NOT rendered.
    const toggle = page.getByTestId('jobs-expired-toggle');
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId('jobs-expired-count')).toHaveText('2');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('jobs-list-expired')).toHaveCount(0);
    await expect(page.getByTestId('job-spent')).toHaveCount(0);
    await expect(page.getByTestId('job-spent2')).toHaveCount(0);
  });

  test('clicking the expired header expands it, and clicking again folds it back', async ({
    page,
  }) => {
    await stubJobs(page, [RECURRING, EXPIRED_A, EXPIRED_B]);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    const toggle = page.getByTestId('jobs-expired-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('job-spent')).toBeVisible();
    await expect(page.getByTestId('job-spent2')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('job-spent')).toHaveCount(0);
  });

  test('an expired row is muted and its enable switch is dead', async ({ page }) => {
    await stubJobs(page, [RECURRING, EXPIRED_A]);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();
    await page.getByTestId('jobs-expired-toggle').click();

    const row = page.getByTestId('job-spent');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/expired/);

    // Dead, not merely off — and a live job's switch is still operable.
    await expect(page.getByTestId('job-toggle-spent')).toBeDisabled();
    await expect(page.getByTestId('job-toggle-bus')).toBeEnabled();

    // Muted relative to a live row.
    const opacity = await row.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThan(1);
  });

  test('the sections are ordered recurring, one-off, then expired', async ({ page }) => {
    await stubJobs(page, [EXPIRED_A, PENDING_ONE_OFF, RECURRING]);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    const heads = page.locator('.jobs-section-head');
    await expect(heads).toHaveCount(3);
    await expect(heads.nth(0)).toHaveText(/Recurring/i);
    await expect(heads.nth(1)).toHaveText(/One-off/i);
    await expect(heads.nth(2)).toHaveText(/Expired/i);
  });

  test('search groups what it matched — a query hitting only expired jobs draws that section alone', async ({
    page,
  }) => {
    await stubJobs(page, [RECURRING, PENDING_ONE_OFF, EXPIRED_A]);
    await page.goto(JOBS_ROUTE);
    await expect(page.getByTestId('job-bus')).toBeVisible();

    await page.getByTestId('jobs-search').fill('dentist');

    await expect(page.getByTestId('jobs-section-recurring')).toHaveCount(0);
    await expect(page.getByTestId('jobs-section-one-off')).toHaveCount(0);
    await expect(page.getByTestId('jobs-expired-count')).toHaveText('1');
    // Still collapsed, and NOT reported as "no matches".
    await expect(page.getByTestId('jobs-no-matches')).toHaveCount(0);
    await expect(page.getByTestId('jobs-expired-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});

/** The editor's own auxiliary fetches — empty is fine, the chips don't read them. */
async function stubEditorAux(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [] }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: [] }),
    }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
}

// The job's END CONDITION, on the editor page itself (spec/08 § One-off jobs).
// Before this, opening a one-off or expired job's editor showed nothing to
// say so — the list's own grouping was the only place either fact was visible
// (Patch Updates — "patch cant see end condition in job ui").
test.describe('job editor — end condition chips', () => {
  test('a pending one-off job shows a One-off chip and no Expired chip', async ({ page }) => {
    await stubJobs(page, [PENDING_ONE_OFF]);
    await stubEditorAux(page);
    // `**/api/jobs**` above answers the list shape; the editor's own
    // `GET /api/jobs/parcel` needs the bare job, so register the specific
    // route AFTER the broad one — Playwright matches in reverse registration
    // order, so this one wins for that exact path.
    await page.route('**/api/jobs/parcel', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PENDING_ONE_OFF),
      }),
    );
    await page.goto(JOBS_ROUTE);
    await page.getByTestId('job-parcel').locator('a.job-link').click();
    await expect(page.getByTestId('job-editor-oneoff')).toHaveText('One-off');
    await expect(page.getByTestId('job-editor-expired')).toHaveCount(0);
  });

  test('an expired job shows both an Expired chip and a One-off chip', async ({ page }) => {
    await stubJobs(page, [EXPIRED_A]);
    await stubEditorAux(page);
    await page.route('**/api/jobs/spent', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(EXPIRED_A),
      }),
    );
    await page.goto(JOBS_ROUTE);
    await page.getByTestId('jobs-expired-toggle').click();
    await page.getByTestId('job-spent').locator('a.job-link').click();
    await expect(page.getByTestId('job-editor-expired')).toHaveText('Expired');
    await expect(page.getByTestId('job-editor-oneoff')).toHaveText('One-off');
  });

  test('an ordinary recurring job shows neither chip', async ({ page }) => {
    await stubJobs(page, [RECURRING]);
    await stubEditorAux(page);
    await page.route('**/api/jobs/bus', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RECURRING),
      }),
    );
    await page.goto(JOBS_ROUTE);
    await page.getByTestId('job-bus').locator('a.job-link').click();
    await expect(page.getByTestId('job-editor')).toBeVisible();
    await expect(page.getByTestId('job-editor-oneoff')).toHaveCount(0);
    await expect(page.getByTestId('job-editor-expired')).toHaveCount(0);
  });
});
