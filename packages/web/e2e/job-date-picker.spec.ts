import { test, expect } from '@playwright/test';

// Starts / stops use the app's own date picker, not the browser's native
// datetime-local popup. The popover must also fit inside the viewport on a
// phone — computed layout only a real browser proves.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test.describe(`job editor date picker — ${name}`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      const json = (body: unknown) => (route: import('@playwright/test').Route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/folders**', json({ hosts: [] }));
      await page.route('**/api/skills**', json({ skills: [], paths: {} }));
      await page.route('**/api/jobs**', json({ jobs: [] }));
    });

    test('opens a custom calendar inside the viewport and picks a date', async ({ page }) => {
      await page.goto(NEW_JOB);
      await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);
      await page.getByTestId('job-date-start-open').click();
      const pop = page.getByTestId('job-date-start-popover');
      await expect(pop).toBeVisible();
      const box = (await pop.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await pop.locator('.dtf-day').nth(14).click();
      await page.getByTestId('job-date-start-hour').selectOption('17');
      await expect(page.getByTestId('job-date-start')).toHaveValue(/ 17:00$/);
      await page.getByTestId('job-date-start-done').click();
      await expect(pop).toBeHidden();
    });
  });
}
