import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for
// patch/todo.md: "cron should be visible in a bar above the chat, showing how
// long until next wakeup and the prompt" (spec/02 § Self-wake, spec/14 § Main
// chat panel).
//
// `chat_bus` is seeded in dev-harness.tsx with a pending self-wake ~9 minutes
// out. jsdom can assert the text; only a real browser can confirm the bar is
// actually laid out ABOVE the transcript and visible, which is the whole ask.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('pending self-wake bar', () => {
  test('shows the countdown and the wake prompt', async ({ page }) => {
    await page.goto(HARNESS);
    const bar = page.getByTestId('wake-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('wake-bar-countdown')).toContainText(/Wakes in \d+m/);
    await expect(page.getByTestId('wake-bar-message')).toContainText(
      'check whether the 36 has left the depot',
    );
  });

  test('sits above the transcript, below the chat header', async ({ page }) => {
    await page.goto(HARNESS);
    const header = await page.getByTestId('chat-head').boundingBox();
    const bar = await page.getByTestId('wake-bar').boundingBox();
    const stream = await page.getByTestId('chat-stream').boundingBox();
    expect(header).not.toBeNull();
    expect(bar).not.toBeNull();
    expect(stream).not.toBeNull();
    expect(bar!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(stream!.y + 1);
  });

  test('a chat with no pending wake shows no bar', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('wake-bar')).toHaveCount(0);
  });

  // spec/02 § Self-wake — "count the interval from the end of the turn": a
  // loop tick that comes due while the chat's own turn is still running is
  // absorbed, not queued. `chat_loop_waiting` fixes this fixture's
  // `pendingWake.fireAt` in the past with `waiting: true` set, so a bar
  // reading a live countdown off it would show a bogus "now" — it must show
  // the waiting label instead, with no separate queued wake bubble.
  test('a loop waiting on the current turn shows "waiting for current turn", not a countdown', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_loop_waiting');
    await expect(page.getByTestId('wake-bar-countdown')).toContainText('waiting for current turn');
    await expect(page.getByTestId('wake-bar-countdown')).not.toContainText('now');
    // Absorbed, not queued: no QUEUED wake bubble alongside the running turn.
    await expect(page.getByTestId('queued-badge')).toHaveCount(0);
  });
});
