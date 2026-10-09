import { test, expect } from '@playwright/test';

// spec/14 § Jobs view — the cron Timezone select, in a real browser.
//
// The bug this guards: `0 9 * * *` was always evaluated in UTC, so a London
// user's "9am" job fired at 10am for the seven months of BST. The editor now
// sends the zone with the expression, and — critically — the expression is
// sent EXACTLY as shown, never rewritten into UTC.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

/** Stub the reads the editor makes, and record every POST /api/jobs body. */
async function stubApi(page: import('@playwright/test').Page, posted: unknown[]): Promise<void> {
  await page.route('**/api/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [{ daemonId: 'd1', roots: ['/work'], recent: [] }] }),
    }),
  );
  await page.route('**/api/jobs**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posted.push(JSON.parse(req.postData() ?? '{}'));
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'j_new' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [] }),
    });
  });
}

test.describe('job editor — cron timezone', () => {
  test('the Timezone select is on the cron trigger and echoed in the readout', async ({ page }) => {
    await stubApi(page, []);
    await page.goto(NEW_JOB);
    const tz = page.getByTestId('job-cron-timezone');
    await expect(tz).toBeVisible();
    await tz.selectOption('Europe/London');
    await expect(page.getByTestId('job-cron-timezone-value')).toHaveText('Europe/London');
    // The expression itself is untouched by the zone change.
    await expect(page.getByTestId('job-cron-value')).toHaveText('0 9 * * *');
  });

  test('the select offers UTC first and real IANA zones', async ({ page }) => {
    await stubApi(page, []);
    await page.goto(NEW_JOB);
    const values = await page
      .getByTestId('job-cron-timezone')
      .locator('option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(values[0]).toBe('UTC');
    expect(values).toContain('Europe/London');
    expect(values).toContain('America/New_York');
  });

  test('saving posts the zone with the expression unchanged', async ({ page }) => {
    const posted: unknown[] = [];
    await stubApi(page, posted);
    await page.goto(NEW_JOB);
    await page.getByTestId('job-name').fill('daily email update');
    await page.getByTestId('job-cron-timezone').selectOption('Europe/London');
    await page.getByTestId('job-spawn-folder').selectOption(JSON.stringify(['d1', '/work']));
    await page.getByTestId('job-spawn-prompt').fill('go');
    await page.getByTestId('job-save').click();
    await expect.poll(() => posted.length).toBe(1);
    expect((posted[0] as { trigger: unknown }).trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });

  test('choosing UTC omits the field entirely', async ({ page }) => {
    const posted: unknown[] = [];
    await stubApi(page, posted);
    await page.goto(NEW_JOB);
    await page.getByTestId('job-name').fill('utc job');
    await page.getByTestId('job-cron-timezone').selectOption('UTC');
    await page.getByTestId('job-spawn-folder').selectOption(JSON.stringify(['d1', '/work']));
    await page.getByTestId('job-spawn-prompt').fill('go');
    await page.getByTestId('job-save').click();
    await expect.poll(() => posted.length).toBe(1);
    expect((posted[0] as { trigger: unknown }).trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
    });
  });

  test('a natural-language schedule keeps its zone', async ({ page }) => {
    const posted: unknown[] = [];
    await stubApi(page, posted);
    await page.goto(NEW_JOB);
    await page.getByTestId('job-name').fill('weekday brief');
    await page.getByTestId('job-schedule-nl').fill('every weekday at 9am');
    await expect(page.getByTestId('job-cron-value')).toHaveText('0 9 * * 1-5');
    await page.getByTestId('job-cron-timezone').selectOption('Europe/London');
    await page.getByTestId('job-spawn-folder').selectOption(JSON.stringify(['d1', '/work']));
    await page.getByTestId('job-spawn-prompt').fill('go');
    await page.getByTestId('job-save').click();
    await expect.poll(() => posted.length).toBe(1);
    expect((posted[0] as { trigger: unknown }).trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'Europe/London',
    });
  });

  test('the Timezone field is cron-only', async ({ page }) => {
    await stubApi(page, []);
    await page.goto(NEW_JOB);
    await expect(page.getByTestId('job-cron-timezone')).toBeVisible();
    await page.getByTestId('job-trigger-type').selectOption('webhook');
    await expect(page.getByTestId('job-cron-timezone')).toHaveCount(0);
  });
});
