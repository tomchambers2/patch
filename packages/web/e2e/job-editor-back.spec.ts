import { test, expect } from '@playwright/test';

// Task 2: "no back button on edit schedule"
// The job editor (new-job and edit-job) must have a back/cancel button
// that navigates to /jobs without requiring a save.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

// Bug report 23 Sep 2026: "patch job back page only goes back to jobs
// instead of where you actually where". Opened via a chat's "Open job" row
// (chat_job_open_link fixture — dev-harness.tsx), Back must return to that
// chat rather than always landing on the jobs list (spec/14 § Jobs view).
const CHAT_WITH_JOB_LINK = '/app/dev-harness.html?chat=chat_job_open_link';
const CHAT_FIXTURE_MESSAGE = 'watch the 36 bus and tell me when it leaves';

const LINKED_JOB = {
  id: 'job_bus_watch',
  name: 'Bus watch',
  enabled: true,
  filter: null,
  trigger: { type: 'cron', expression: '*/5 7-22 * * *', timezone: 'Europe/London' },
  action: {
    type: 'spawn',
    daemonId: 'd1',
    folder: '/home/tom/projects/bus',
    prompt: 'watch the bus',
  },
};

async function stubJobEditorApis(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hosts: [{ daemonId: 'd1', roots: ['/home/tom/projects/bus'], recent: [] }],
      }),
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
  // Reverse registration order (Playwright): the broad list stub goes first
  // or it swallows the single-job GET below.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [LINKED_JOB] }),
    }),
  );
  await page.route(`**/api/jobs/${LINKED_JOB.id}/runs**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route(`**/api/jobs/${LINKED_JOB.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(LINKED_JOB),
    }),
  );
}

test.describe('job editor — back button', () => {
  test('back button is present on the new-job form', async ({ page }) => {
    // Stub the API calls the editor makes (folders, skills).
    await page.route('**/api/folders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hosts: [] }),
      }),
    );
    await page.route('**/api/jobs**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jobs: [] }),
        });
      }
      return route.continue();
    });
    await page.goto(NEW_JOB);
    const back = page.getByTestId('job-editor-back');
    await expect(back).toBeVisible();
  });

  test('clicking back on new-job navigates to /jobs', async ({ page }) => {
    await page.route('**/api/folders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hosts: [] }),
      }),
    );
    await page.route('**/api/jobs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.goto(NEW_JOB);
    await expect(page.getByTestId('job-editor-back')).toBeVisible();
    await page.getByTestId('job-editor-back').click();
    // After clicking back, the jobs list route must render.
    await expect(page.getByTestId('jobs-route')).toBeVisible();
  });

  test('opened from a chat, back returns to that chat rather than the jobs list', async ({
    page,
  }) => {
    await stubJobEditorApis(page);
    await page.goto(CHAT_WITH_JOB_LINK);
    await expect(page.getByText(CHAT_FIXTURE_MESSAGE)).toBeVisible();

    await page.getByTestId('tool-call-job-link').click();
    await expect(page.getByTestId('job-editor')).toBeVisible();
    await expect(page.getByTestId('job-name')).toHaveValue(LINKED_JOB.name);

    await page.getByTestId('job-editor-back').click();
    await expect(page.getByText(CHAT_FIXTURE_MESSAGE)).toBeVisible();
    await expect(page.getByTestId('jobs-route')).toHaveCount(0);
  });

  // Saving is the other way off the page, and it follows the same rule: a job
  // edited from a chat's "Open job" link saves and returns to that chat, not to
  // a jobs list the user never opened (spec/14 § Jobs view).
  test('opened from a chat, saving returns to that chat rather than the jobs list', async ({
    page,
  }) => {
    await stubJobEditorApis(page);
    await page.goto(CHAT_WITH_JOB_LINK);
    await expect(page.getByText(CHAT_FIXTURE_MESSAGE)).toBeVisible();

    await page.getByTestId('tool-call-job-link').click();
    await expect(page.getByTestId('job-name')).toHaveValue(LINKED_JOB.name);
    await page.getByTestId('job-name').fill('Bus watch (weekdays)');

    const saved = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/jobs/${LINKED_JOB.id}`),
    );
    await page.getByTestId('job-save').click();
    await saved;

    await expect(page.getByText(CHAT_FIXTURE_MESSAGE)).toBeVisible();
    await expect(page.getByTestId('job-editor')).toHaveCount(0);
    await expect(page.getByTestId('jobs-route')).toHaveCount(0);
  });
});
