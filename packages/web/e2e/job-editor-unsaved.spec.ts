import { test, expect } from '@playwright/test';

// spec/14 § Jobs view — Unsaved changes (Todoist 6hWJvMWfJrxGg646: "patch
// navigating away from a job being edited loses the draft state. should clearly
// indicate unsaved when on it. and also modal").
//
// Real browser rather than jsdom because the thing under test is a NAVIGATION
// being held open by the router's own navigator, with the app's confirm modal
// on top of it — three real components (the route, the guard, ConfirmModal) and
// the router in between.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';
const EDIT_JOB = '/app/dev-harness.html?route=/jobs/j_unsaved';

const JOB = {
  id: 'j_unsaved',
  name: 'Nightly sweep',
  enabled: true,
  filter: null,
  trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
  action: {
    type: 'spawn',
    daemonId: 'd1',
    folder: '/home/tom/alpha',
    prompt: 'sweep the thing',
    notifyOnComplete: true,
    permissionMode: 'auto',
  },
};

async function stub(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [{ daemonId: 'd1', roots: ['/home/tom/alpha'], recent: [] }] }),
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
  // Playwright matches routes in REVERSE registration order, so the broad
  // `**/api/jobs**` has to be registered FIRST or it swallows the single-job
  // GET and hands the editor a `{ jobs: [...] }` list where a Job belongs.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [JOB] }),
    }),
  );
  await page.route('**/api/jobs/j_unsaved/runs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route('**/api/jobs/j_unsaved', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOB) }),
  );
}

test.describe('job editor — unsaved changes', () => {
  test('a freshly loaded job shows no unsaved indicator', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    // The load, the background refetch and the host/folder seeding all run
    // before this settles; none of them may count as the user's own edit.
    await page.waitForTimeout(300);
    await expect(page.getByTestId('job-editor-unsaved')).toHaveCount(0);
  });

  test('a new-job form nobody has touched shows no unsaved indicator', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);
    await expect(page.getByTestId('job-editor-back')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('job-editor-unsaved')).toHaveCount(0);
  });

  test('typing into a field raises the unsaved indicator', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    await page.getByTestId('job-name').fill('Nightly sweep (edited)');
    const chip = page.getByTestId('job-editor-unsaved');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('Unsaved changes');
    await page.screenshot({ path: '/tmp/queue-shots/F-unsaved-indicator.png' });
  });

  test('undoing the edit clears the indicator again', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    await page.getByTestId('job-name').fill('Nightly sweep (edited)');
    await expect(page.getByTestId('job-editor-unsaved')).toBeVisible();
    await page.getByTestId('job-name').fill('Nightly sweep');
    await expect(page.getByTestId('job-editor-unsaved')).toHaveCount(0);
  });

  test('leaving with unsaved edits asks first, and Keep editing stays put', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    await page.getByTestId('job-name').fill('Nightly sweep (edited)');
    await page.getByTestId('job-editor-back').click();

    const modal = page.getByTestId('confirm-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Unsaved changes');
    await expect(page.getByTestId('confirm-ok')).toHaveText('Discard changes');
    await expect(page.getByTestId('confirm-cancel')).toHaveText('Keep editing');
    await page.screenshot({ path: '/tmp/queue-shots/F-confirm-modal.png' });

    await page.getByTestId('confirm-cancel').click();
    await expect(modal).toHaveCount(0);
    // Still on the editor, with the edit intact — nothing was lost.
    await expect(page.getByTestId('job-editor')).toBeVisible();
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep (edited)');
  });

  test('Discard changes lets the navigation through', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    await page.getByTestId('job-name').fill('Nightly sweep (edited)');
    await page.getByTestId('job-editor-back').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('jobs-route')).toBeVisible();
  });

  test('an untouched job leaves with no prompt at all', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    await page.getByTestId('job-editor-back').click();
    await expect(page.getByTestId('jobs-route')).toBeVisible();
    await expect(page.getByTestId('confirm-modal')).toHaveCount(0);
  });

  // The save's own redirect must not trip the guard it just satisfied.
  test('saving leaves without asking', async ({ page }) => {
    await stub(page);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Nightly sweep');
    await page.getByTestId('job-name').fill('Nightly sweep (edited)');
    await expect(page.getByTestId('job-editor-unsaved')).toBeVisible();
    await page.getByTestId('job-save').click();
    await expect(page.getByTestId('jobs-route')).toBeVisible();
    await expect(page.getByTestId('confirm-modal')).toHaveCount(0);
  });
});
