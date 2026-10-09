import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real Sidebar + real CSS, no backend) for the
// Automations sidebar group (spec/08 § Action, spec/14 § Sidebar): "tasks
// triggered by webhook should show up as working/done in a separate section
// in the sidebar so you can easily see whats going on". Collapsed by default;
// expanding fetches `GET /api/chats?automations=only` and merges the result
// into the store — a job-spawned chat also stays wherever else it belongs
// (usually Archived), so the section is an ADDITIONAL always-current view,
// not a chat mover.
const HARNESS = '/app/dev-harness.html';

test.describe('Automations sidebar section', () => {
  test('is collapsed by default and expands to show job-spawned chats with working/done badges', async ({
    page,
  }) => {
    await page.route('**/api/chats?automations=only', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: [
            {
              chatId: 'auto_working',
              name: 'nightly build',
              preview: null,
              folder: '/home/tom/projects/portfolio',
              activity: 'running',
              status: 'active',
              pinned: false,
              pinnedAt: null,
              snoozedUntil: null,
              lastUpdated: 500,
              daemonId: 'd1',
              permissionMode: 'bypassPermissions',
              jobId: 'job_1',
            },
            {
              chatId: 'auto_done',
              name: 'weekly digest',
              preview: null,
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              snoozedUntil: null,
              lastUpdated: 400,
              daemonId: 'd1',
              permissionMode: 'bypassPermissions',
              jobId: 'job_2',
            },
          ],
        }),
      }),
    );

    await page.goto(HARNESS);

    const toggle = page.getByTestId('automations-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('title', /^Automations/);
    // Collapsed by default — no fetch has happened, no rows rendered.
    await expect(page.getByTestId('automations-section')).toHaveCount(0);

    await toggle.click();
    const section = page.getByTestId('automations-section');
    await expect(section).toBeVisible();

    const working = section.getByTestId('chat-row-auto_working');
    const done = section.getByTestId('chat-row-auto_done');
    await expect(working).toBeVisible();
    await expect(done).toBeVisible();

    // "working/done" — the exact statuses Tom asked to see at a glance.
    await expect(working.getByTestId('badge-working')).toBeVisible();
    await expect(done.getByTestId('badge-done')).toBeVisible();
  });

  // The empty state is the count on the toggle itself, not a line of text below
  // it (spec/14 §6) — four placeholder lines cost more sidebar height than the
  // chat list they push out of view.
  test('reports empty as a 0 on the row, with no body at all, when no job has spawned a chat', async ({
    page,
  }) => {
    await page.route('**/api/chats?automations=only', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [] }),
      }),
    );
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hidden: 0, archived: 1, snoozed: 0, deleted: 0, automations: 0 }),
      }),
    );
    await page.goto(HARNESS);
    // The 0 is on the row BEFORE it is opened — that is the whole empty state,
    // and it is what saves opening the section to find out.
    await expect(page.getByTestId('automations-section')).toHaveCount(0);
    await expect(page.getByTestId('automations-toggle')).toHaveAttribute(
      'title',
      'Automations · 0',
    );
    await page.getByTestId('automations-toggle').click();
    const section = page.getByTestId('automations-section');
    await expect(section).toBeAttached();
    await expect(page.getByTestId('automations-toggle')).toHaveAttribute(
      'title',
      'Automations · 0',
    );
    await expect(section).toBeEmpty();
  });

  test('a job-spawned chat is a DUPLICATE view — it also shows in Archived, not moved out of it', async ({
    page,
  }) => {
    await page.route('**/api/chats?automations=only', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: [
            {
              chatId: 'auto_dual',
              name: 'dual-membership run',
              preview: 'finished',
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              snoozedUntil: null,
              lastUpdated: 300,
              daemonId: 'd1',
              permissionMode: 'bypassPermissions',
              jobId: 'job_3',
            },
          ],
        }),
      }),
    );
    await page.route('**/api/chats?archived=include', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: [
            {
              chatId: 'auto_dual',
              name: 'dual-membership run',
              preview: 'finished',
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              lastUpdated: 300,
            },
          ],
        }),
      }),
    );

    await page.goto(HARNESS);

    await page.getByTestId('automations-toggle').click();
    await expect(
      page.getByTestId('automations-section').getByTestId('chat-row-auto_dual'),
    ).toBeVisible();

    await page.getByTestId('archived-toggle').click();
    await expect(
      page.getByTestId('archived-section').getByTestId('chat-row-auto_dual'),
    ).toBeVisible();
  });

  test('renders oldest-first — bottom-up, not most-recent-first — so a run updating settles at the bottom instead of reshuffling the list (Todoist: "Load chats bottom up so you don\'t get a jarring effect")', async ({
    page,
  }) => {
    await page.route('**/api/chats?automations=only', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: [
            {
              chatId: 'auto_newest',
              name: 'newest run',
              preview: null,
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              snoozedUntil: null,
              lastUpdated: 900,
              daemonId: 'd1',
              permissionMode: 'bypassPermissions',
              jobId: 'job_a',
            },
            {
              chatId: 'auto_oldest',
              name: 'oldest run',
              preview: null,
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              snoozedUntil: null,
              lastUpdated: 100,
              daemonId: 'd1',
              permissionMode: 'bypassPermissions',
              jobId: 'job_b',
            },
          ],
        }),
      }),
    );

    await page.goto(HARNESS);
    await page.getByTestId('automations-toggle').click();
    const section = page.getByTestId('automations-section');
    await expect(section).toBeVisible();

    const rowIds = await section
      .locator('[data-testid^="chat-row-"]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')));
    expect(rowIds).toEqual(['chat-row-auto_oldest', 'chat-row-auto_newest']);
  });

  test('a normal, non-job chat never appears in Automations', async ({ page }) => {
    await page.route('**/api/chats?automations=only', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [] }),
      }),
    );
    await page.goto(HARNESS);
    // `chat_bus` is a seeded, user-started chat in the active list.
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await page.getByTestId('automations-toggle').click();
    await expect(
      page.getByTestId('automations-section').getByTestId('chat-row-chat_bus'),
    ).toHaveCount(0);
  });
});
