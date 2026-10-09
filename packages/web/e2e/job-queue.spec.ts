import { test, expect } from '@playwright/test';

// "patch looking at a job page should show the queue for that job".
//
// spec/08 § Concurrency: a job with a limit holds fires behind it. The counts
// were already on the row; the job's own page shows the fires themselves —
// what it is running now, and what is waiting.

const FOLDER = '/home/tom/projects/portfolio';
const JOB_ID = 'j_01KZSAG4ZNEZCNVA5AA3T4QHCA';

const LIMITED_JOB = {
  id: JOB_ID,
  name: 'App Updates',
  enabled: true,
  trigger: { type: 'todoist' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: FOLDER, skill: 'app-update' },
  concurrency: 1,
  createdAt: 1,
  updatedAt: 1,
};

const QUEUE = {
  concurrency: 1,
  inFlight: [
    {
      chatId: 'chat-running',
      localId: 'l1',
      startedAt: Date.parse('2026-09-07T09:00:00Z'),
      trigger: 'todoist',
      actionType: 'spawn',
      daemonId: 'd1',
      folder: FOLDER,
    },
  ],
  queued: [
    {
      fireId: 'f2',
      queuedAt: Date.parse('2026-09-07T09:01:00Z'),
      chatId: 'chat-waiting-1',
      trigger: 'todoist',
      actionType: 'spawn',
      daemonId: 'd1',
      folder: FOLDER,
    },
    {
      fireId: 'f3',
      queuedAt: Date.parse('2026-09-07T09:02:00Z'),
      chatId: 'chat-waiting-2',
      trigger: 'todoist',
      actionType: 'spawn',
      daemonId: 'd1',
      folder: FOLDER,
    },
  ],
};

const EDIT_JOB = `/app/dev-harness.html?route=/jobs/${JOB_ID}`;

async function stub(
  page: import('@playwright/test').Page,
  job: Record<string, unknown>,
  queue: unknown,
): Promise<void> {
  await page.route('**/api/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [{ daemonId: 'd1', roots: [FOLDER], recent: [] }] }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: ['app-update'], paths: {} }),
    }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  // Registered broadest-FIRST: playwright checks handlers in reverse
  // registration order, so the list route added last would swallow the
  // per-job routes below it.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [job] }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(job),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}/runs**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}/queue**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(queue),
    }),
  );
}

test.describe('job page — queue', () => {
  test('shows what the job is running and what is waiting behind its limit', async ({ page }) => {
    await stub(page, LIMITED_JOB, QUEUE);
    await page.goto(EDIT_JOB);
    // The editor mounts a heavy stack behind this route; give the first
    // assertion room on a loaded box.
    await expect(page.getByTestId('job-name')).toHaveValue(LIMITED_JOB.name, { timeout: 15_000 });

    const panel = page.getByTestId('job-queue');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Queue' })).toBeVisible();
    await expect(page.getByTestId('job-queue-limit')).toHaveText('1 at a time');

    // One fire running, two waiting — and the running one is drawn above the
    // waiting ones, because that is the order they will finish in.
    await expect(page.getByTestId('job-queue-running')).toHaveCount(1);
    await expect(page.getByTestId('job-queue-waiting')).toHaveCount(2);
    const rows = panel.locator('li');
    await expect(rows.first()).toHaveAttribute('data-testid', 'job-queue-running');

    // The running fire has a chat to open; a waiting one has not been sent, so
    // it must not offer a link to a chat that does not exist yet.
    await expect(page.getByTestId('job-queue-running').locator('.run-chat-link')).toHaveAttribute(
      'href',
      '/chats/chat-running',
    );
    await expect(
      page.getByTestId('job-queue-waiting').first().locator('.run-chat-link'),
    ).toHaveCount(0);

    // It sits above the history panel: the queue is what is about to happen.
    const queueTop = await panel.evaluate((el) => el.getBoundingClientRect().top);
    const runsTop = await page
      .getByTestId('recent-runs')
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(queueTop).toBeLessThan(runsTop);
  });

  test('a limited job with an empty queue says so rather than showing nothing', async ({
    page,
  }) => {
    await stub(page, LIMITED_JOB, { concurrency: 1, inFlight: [], queued: [] });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(LIMITED_JOB.name, { timeout: 15_000 });
    await expect(page.getByTestId('job-queue')).toContainText('Nothing running or queued.');
  });

  test('a job with no concurrency limit has no queue panel', async ({ page }) => {
    const unlimited: Record<string, unknown> = { ...LIMITED_JOB };
    delete unlimited.concurrency;
    await stub(page, unlimited, { concurrency: null, inFlight: [], queued: [] });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(LIMITED_JOB.name, { timeout: 15_000 });
    // The runs panel below it renders, so the page has settled.
    await expect(page.getByTestId('recent-runs')).toBeVisible();
    await expect(page.getByTestId('job-queue')).toHaveCount(0);
  });
});
