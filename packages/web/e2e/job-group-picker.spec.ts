import { test, expect } from '@playwright/test';

// Group picker (spec/08 § Groups, spec/14 § Jobs view): a dropdown of every
// distinct group already in use, plus a "New group…" option that reveals
// free text for a name not yet seen — not a bare free-text field.
//
// A real browser rather than jsdom because a `<select>`'s options are what
// the user actually opens.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

const JOBS = {
  jobs: [
    {
      id: 'j_a',
      name: 'a',
      group: 'Finance',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'x' },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'j_b',
      name: 'b',
      group: 'Home',
      enabled: true,
      trigger: { type: 'cron', expression: '0 9 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '/tmp', prompt: 'x' },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

async function stub(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hosts: [{ daemonId: 'd1', roots: ['/home/tom/projects/alpha'], recent: [] }],
      }),
    }),
  );
  await page.route('**/api/jobs**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOBS) }),
  );
}

test.describe('job editor group picker', () => {
  test('offers every distinct group in use, then New group… for free text', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);

    const select = page.getByTestId('job-group');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText([
      'Ungrouped',
      'Finance',
      'Home',
      'New group…',
    ]);

    // Picking an existing group needs no free-text field.
    await select.selectOption({ label: 'Finance' });
    await expect(page.getByTestId('job-group-custom')).toHaveCount(0);

    // "New group…" reveals the free-text field for a name not yet in use.
    await select.selectOption({ label: 'New group…' });
    const custom = page.getByTestId('job-group-custom');
    await expect(custom).toBeVisible();
    await custom.fill('Watchers');
    await expect(custom).toHaveValue('Watchers');
  });
});
