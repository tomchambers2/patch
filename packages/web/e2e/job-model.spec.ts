import { test, expect } from '@playwright/test';

// spec/14 § Jobs view — Model. The picker is driven by the CHOSEN HOST's live
// catalogue, and `Account default` (storing no model at all) has to be a state
// the user can select and come back to, because that is what makes each fire
// take the account's `defaultModel` (spec/08 § Action).
//
// That row used to read `Host default` and meant the host's last-used model —
// whatever chat last ran on that machine — so a job's model drifted with
// unrelated activity. One account setting replaced it.
//
// This is the real browser rather than jsdom because the thing under test is
// the catalogue RELOADING when the folder picker moves the job to a different
// machine — a genuine effect/refetch sequence against two hosts.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

const HOSTS = {
  hosts: [
    { daemonId: 'd1', roots: ['/home/tom/alpha'], recent: [] },
    { daemonId: 'd2', roots: ['/home/tom/beta'], recent: [] },
  ],
};

// The dev harness seeds presence for 'd1' with `host.defaultModel:
// 'claude-opus-5'` — one of d1's own catalogue entries below, so picking d1
// exercises the real label lookup rather than falling back to the raw id.

/** Each machine serves a DIFFERENT catalogue, so a stale one is visible. */
const CATALOGUE: Record<string, Array<{ id: string; label: string }>> = {
  d1: [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  d2: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
};

async function stub(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(HOSTS),
    }),
  );
  await page.route('**/api/models**', (route) => {
    const daemonId = new URL(route.request().url()).searchParams.get('daemonId') ?? '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: CATALOGUE[daemonId] ?? [] }),
    });
  });
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: [] }),
    }),
  );
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [] }),
    }),
  );
}

test.describe('job editor — model picker', () => {
  test('starts on Account default and lists the chosen host’s models', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);

    const model = page.getByTestId('job-spawn-model');
    await expect(model).toBeVisible();
    // A new job pins nothing — it tracks the account setting rather than
    // freezing an id that will eventually be retired.
    await expect(model).toHaveValue('');
    // The harness's seeded chat history puts d1 in as the MRU host on load,
    // and d1 already has a default model mirrored to it — so the option
    // names the model it actually is, not just that one exists.
    await expect(model.locator('option[value=""]')).toHaveText('Account default (Opus 5)');

    await page
      .getByTestId('job-spawn-folder')
      .selectOption(JSON.stringify(['d1', '/home/tom/alpha']));
    await expect(model.locator('option[value="claude-opus-5"]')).toHaveCount(1);
    await model.selectOption('claude-opus-5');
    await expect(model).toHaveValue('claude-opus-5');
  });

  test('moving the job to another host reloads that host’s catalogue', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);

    const folder = page.getByTestId('job-spawn-folder');
    const model = page.getByTestId('job-spawn-model');

    await folder.selectOption(JSON.stringify(['d1', '/home/tom/alpha']));
    await expect(model.locator('option[value="claude-opus-5"]')).toHaveCount(1);

    // d2 serves a different catalogue. Leaving d1's models on screen is how an
    // id the target machine cannot run gets stored.
    await folder.selectOption(JSON.stringify(['d2', '/home/tom/beta']));
    await expect(model.locator('option[value="claude-sonnet-4-6"]')).toHaveCount(1);
    await expect(model.locator('option[value="claude-opus-5"]')).toHaveCount(0);
    // d2 has never reported a default model to this surface, so the option
    // stays unlabelled rather than carrying over d1's.
    await expect(model.locator('option[value=""]')).toHaveText('Account default');
  });

  test('a message action has no model control at all', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);

    await expect(page.getByTestId('job-spawn-model')).toBeVisible();
    await page.getByTestId('job-action-type').selectOption('continue');
    await expect(page.getByTestId('job-spawn-model')).toBeVisible();
    // `message` inherits host, folder and model from the chat it delivers into.
    await page.getByTestId('job-action-type').selectOption('message');
    await expect(page.getByTestId('job-spawn-model')).toHaveCount(0);
  });
});
