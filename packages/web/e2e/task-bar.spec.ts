import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for the
// task bar — spec/02 § Task list, spec/14 § Main chat panel: "a task bar at the
// top like with scheduled wakeups, editable".
//
// `chat_tasks` is seeded in dev-harness.tsx with a goal and a 3-item TodoWrite
// list (one completed, one in progress, one pending). jsdom already covers the
// state transitions; what only a real browser can show is that the bar is laid
// out above the transcript, that the collapse/expand and click-to-edit
// affordances actually work under real CSS, and that a completed item reads
// struck through.
const HARNESS = '/app/dev-harness.html?chat=chat_tasks';

/** The harness has no backend — accept the writes so edits stick. */
async function acceptWrites(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/chats/*/todos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await page.route('**/api/chats/*/goal', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
}

test.describe('task bar', () => {
  test('shows the current task and progress, collapsed', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('task-bar')).toBeVisible();
    await expect(page.getByTestId('task-bar-head')).toContainText('rebuild the index');
    await expect(page.getByTestId('task-bar-count')).toContainText('1/3');
    await expect(page.getByTestId('task-bar-list')).toHaveCount(0);
  });

  test('sits under the goal bar and above the transcript', async ({ page }) => {
    await page.goto(HARNESS);
    const goal = await page.getByTestId('goal-banner').boundingBox();
    const bar = await page.getByTestId('task-bar').boundingBox();
    const stream = await page.getByTestId('chat-stream').boundingBox();
    expect(goal).not.toBeNull();
    expect(bar).not.toBeNull();
    expect(stream).not.toBeNull();
    expect(bar!.y).toBeGreaterThanOrEqual(goal!.y + goal!.height - 1);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(stream!.y + 1);
  });

  test('expands to the full list, with completed items struck through', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('task-bar-summary').click();
    const rows = page.getByTestId('task-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('read the current indexer');
    await expect(rows.nth(2)).toContainText('schedule it nightly');
    const decoration = await rows
      .nth(0)
      .getByTestId('task-text')
      .evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(decoration).toContain('line-through');
    // Collapsing puts it away again.
    await page.getByTestId('task-bar-summary').click();
    await expect(page.getByTestId('task-bar-list')).toHaveCount(0);
  });

  test('an in-progress task reads as started, not as pending', async ({ page }) => {
    // The host marks an item in progress once a turn has been spent on it and
    // only the agent/user ever completes one, so "started but unfinished" and
    // "never started" have to be tellable apart on screen — otherwise a task the
    // chat has already had a whole turn on still reads pending.
    await page.goto(HARNESS);
    await page.getByTestId('task-bar-summary').click();
    const rows = page.getByTestId('task-row');
    await expect(rows.nth(1)).toHaveClass(/task-row-in_progress/);
    await expect(rows.nth(1).getByTestId('task-status-btn')).toHaveAttribute(
      'title',
      'in progress',
    );
    await expect(rows.nth(2).getByTestId('task-status-btn')).toHaveAttribute('title', 'pending');
    // Collapsed, the bar is on the in-progress item rather than the pending one.
    await page.getByTestId('task-bar-summary').click();
    await expect(page.getByTestId('task-bar-head')).toContainText('rebuild the index');
  });

  test('a task can be renamed in place and the summary follows it', async ({ page }) => {
    await acceptWrites(page);
    await page.goto(HARNESS);
    await page.getByTestId('task-bar-summary').click();
    await page.getByTestId('task-text').nth(1).click();
    const input = page.getByTestId('task-text-input');
    await expect(input).toBeFocused();
    await input.fill('rebuild the index from scratch');
    await input.press('Enter');
    await expect(page.getByTestId('task-row').nth(1)).toContainText(
      'rebuild the index from scratch',
    );
    await expect(page.getByTestId('task-bar-head')).toContainText('rebuild the index from scratch');
  });

  test('clicking a status dot advances the task and the progress count', async ({ page }) => {
    await acceptWrites(page);
    await page.goto(HARNESS);
    await page.getByTestId('task-bar-summary').click();
    // Row 2 is in progress → one click completes it: 1/3 becomes 2/3, and the
    // summary moves on to the next unfinished task.
    await page.getByTestId('task-status-btn').nth(1).click();
    await expect(page.getByTestId('task-bar-count')).toContainText('2/3');
    await expect(page.getByTestId('task-bar-head')).toContainText('schedule it nightly');
  });

  test('a task can be added and deleted', async ({ page }) => {
    await acceptWrites(page);
    await page.goto(HARNESS);
    await page.getByTestId('task-bar-summary').click();
    const add = page.getByTestId('task-add-input');
    await add.fill('benchmark it');
    await add.press('Enter');
    await expect(page.getByTestId('task-row')).toHaveCount(4);
    await expect(page.getByTestId('task-row').nth(3)).toContainText('benchmark it');
    await expect(add).toHaveValue('');

    await page.getByTestId('task-delete-btn').nth(0).click();
    await expect(page.getByTestId('task-row')).toHaveCount(3);
    await expect(page.getByTestId('task-bar')).not.toContainText('read the current indexer');
  });

  test('the goal above it is editable in a modal', async ({ page }) => {
    await acceptWrites(page);
    await page.goto(HARNESS);
    await page.getByTestId('goal-banner-text').click();
    await page.getByTestId('goal-edit-input').fill('Get the search index rebuilding hourly');
    await page.getByTestId('goal-edit-save').click();
    await expect(page.getByTestId('goal-banner')).toContainText(
      'Get the search index rebuilding hourly',
    );
  });

  test('a chat with no task list shows no bar', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('task-bar')).toHaveCount(0);
  });
});
