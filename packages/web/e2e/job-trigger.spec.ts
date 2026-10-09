import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/08 § Action, spec/14 § Automations: a job-spawned
// chat's first user turn is the job's raw trigger prompt/payload, not
// something Tom typed — it renders as one quiet furniture line (same
// disclosure as a compaction boundary), not a plain user bubble.
// `chat_job_trigger` is seeded in the harness with `jobId` set and a raw
// JSON payload as its first turn.
const JOB_TRIGGER = '/app/dev-harness.html?chat=chat_job_trigger';

test.describe('job trigger turn', () => {
  test('collapsed, it is one quiet line — not a user bubble', async ({ page }) => {
    await page.goto(JOB_TRIGGER);
    const line = page.getByTestId('job-trigger');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-open', 'false');
    await expect(line).toContainText('Automated trigger');

    // No user bubble for the trigger turn itself — the only `.msg-user` on
    // screen is the later, genuine Tom-authored follow-up.
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.msg-user')).toContainText('thanks, keep watching');

    // Furniture, not prose: smaller and quieter than the assistant reply.
    const proseSize = await page
      .locator('.msg-assistant .content')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const lineSize = await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(lineSize).toBeLessThan(proseSize);

    // No bubble fill behind it.
    const bg = await line.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');

    // Nothing of the raw payload is on screen yet.
    await expect(line.locator('.tool-detail')).toHaveCount(0);

    // The genuine, later Tom-authored turn still renders as a normal bubble.
    await expect(page.getByText('thanks, keep watching')).toBeVisible();
  });

  test('expanding reveals the raw trigger payload', async ({ page }) => {
    await page.goto(JOB_TRIGGER);
    const line = page.getByTestId('job-trigger');
    await line.locator('.tool-summary').click();

    await expect(line).toHaveAttribute('data-open', 'true');
    const detail = line.locator('.tool-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('"route": "36"');
    await expect(detail).toContainText('"etaMinutes": 4');

    // And it closes again.
    await line.locator('.tool-summary').click();
    await expect(line).toHaveAttribute('data-open', 'false');
    await expect(line.locator('.tool-detail')).toHaveCount(0);
  });
});

// spec/08 § Action, spec/14 § Job trigger turn — a `continue`/`message`
// action's LATER fire into an existing chat is also not something Tom typed,
// whichever turn of the chat it lands on. `chat_job_trigger_later_fire` is
// seeded with a genuine Tom-authored first turn, then a later turn carrying
// its own `jobTrigger` flag.
const JOB_TRIGGER_LATER_FIRE = '/app/dev-harness.html?chat=chat_job_trigger_later_fire';

test.describe('job trigger turn — a later fire into an existing chat', () => {
  test('the later fire is collapsed furniture too, not a second user bubble', async ({ page }) => {
    await page.goto(JOB_TRIGGER_LATER_FIRE);

    // The genuine first turn is an ordinary bubble.
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.msg-user')).toContainText('watch this bus route for me');

    // The later job fire is the quiet furniture line, not a second bubble.
    const line = page.getByTestId('job-trigger');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-open', 'false');
    await expect(line).toContainText('Automated trigger');

    await line.locator('.tool-summary').click();
    await expect(line.locator('.tool-detail')).toContainText('"route": "36"');
  });
});
