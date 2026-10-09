import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Background task completions: a completion that
// reaches the surface still wrapped in its raw `<task-notification>` block —
// which is what replay, and any host on a pre-lifting host, delivers — is not
// a turn the user typed and not something they need to read. It renders as one
// quiet badged line with the block a chevron away.
// `chat_task_notification` is seeded in the harness with a real captured block
// as a user turn, between a genuine Tom-authored turn and the assistant's reply.
const NOTIFICATION_CHAT = '/app/dev-harness.html?chat=chat_task_notification';

test.describe('raw task-notification turn', () => {
  test('collapsed, it is one quiet badged line — not a user bubble', async ({ page }) => {
    await page.goto(NOTIFICATION_CHAT);
    const line = page.getByTestId('bg-task-notice');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-open', 'false');

    // The block's own summary sentence is what it reads as.
    await expect(line).toContainText(
      'Background command "Build web package to compile CSS" completed (exit code 0)',
    );
    // Badged, so it reads as the agent layer reporting rather than as Patch.
    await expect(page.getByTestId('bg-task-notice-badge')).toBeVisible();

    // None of the block's plumbing is on screen while collapsed.
    await expect(line).not.toContainText('tool-use-id');
    await expect(line).not.toContainText('baiw888mq');
    await expect(line.locator('.tool-detail')).toHaveCount(0);

    // No user bubble for it — the only `.msg-user` is Tom's genuine turn.
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.msg-user')).toContainText('run the build in the background');

    // Furniture, not prose: quieter and smaller than the assistant reply, with
    // no bubble fill behind it.
    const proseSize = await page
      .locator('.msg-assistant .content')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const lineSize = await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(lineSize).toBeLessThan(proseSize);
    const bg = await line.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');

    // It is ONE line — the seven-line block must not set the row's height.
    const height = await line.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(40);

    // The assistant reply reacting to it still renders normally.
    await expect(page.getByText('The build finished cleanly.')).toBeVisible();
  });

  test('expanding reveals the whole raw block, and closes again', async ({ page }) => {
    await page.goto(NOTIFICATION_CHAT);
    const line = page.getByTestId('bg-task-notice');
    await line.locator('.tool-summary').click();

    await expect(line).toHaveAttribute('data-open', 'true');
    const detail = line.locator('.tool-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('<task-notification>');
    await expect(detail).toContainText('toolu_019qoZTEw4vif4xvr1padB3a');
    await expect(detail).toContainText('<status>completed</status>');

    await line.locator('.tool-summary').click();
    await expect(line).toHaveAttribute('data-open', 'false');
    await expect(line.locator('.tool-detail')).toHaveCount(0);
  });
});
