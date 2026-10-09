import { test, expect } from '@playwright/test';

// The autonomy prompt in the job editor (spec/08 § Autonomy prompt): the
// account-wide prompt lives in Settings → Jobs, and the job editor tucks the
// per-job override under a collapsed "Advanced". Collapsed is computed
// visibility, which only a real browser proves.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

test.describe('job editor — autonomy prompt is under a collapsed Advanced', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/folders**', (route) =>
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
        body: JSON.stringify({ skills: [], paths: {} }),
      }),
    );
    await page.route('**/api/jobs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [] }),
      }),
    );
  });

  test('the box is hidden until Advanced is opened, then shows the account prompt read-only', async ({
    page,
  }) => {
    await page.goto(NEW_JOB);
    const box = page.getByTestId('job-autonomy-prompt-text');
    await expect(page.getByTestId('job-advanced-toggle')).toBeVisible();
    await expect(box).toBeHidden();

    await page.getByTestId('job-advanced-toggle').click();
    await expect(box).toBeVisible();
    await expect(box).toBeDisabled();
    await expect(box).toHaveValue(/running autonomously/);
  });
});
