import { test, expect } from '@playwright/test';

// spec/14 § Running-turn controls — a turn the user stopped, with nothing
// queued behind it, says so and offers Continue (Tom: "cancelled message
// should show status, and allow retry" — refined so the agent that already
// saw the message gets nudged onward rather than re-sent a duplicate).
//
// jsdom proves the wiring (chat.stopped marks the running turn; Continue sends
// a fresh nudge turn). This proves the affordance with the REAL CSS: the
// status sits under the message it belongs to, reads muted rather than in the
// danger colour a failure gets, and Continue is a real clickable target.
const STOPPED = '/app/dev-harness.html?chat=chat_stopped';
const INTERRUPTED = '/app/dev-harness.html?chat=chat_interrupted';

test.describe('stopped turn status', () => {
  test('the stopped message carries the status and Continue, below its own text', async ({
    page,
  }) => {
    await page.goto(STOPPED);
    const msg = page.locator('[data-turn-stopped="true"]');
    await expect(msg).toHaveCount(1);
    await expect(msg).toContainText('refactor the scheduler');

    const status = msg.getByTestId('turn-stopped');
    await expect(status).toHaveText(/Stopped\./);
    await expect(status).not.toContainText('cancelled');

    const continueBtn = msg.getByTestId('turn-stopped-continue');
    await expect(continueBtn).toHaveText('Continue');
    const box = await continueBtn.boundingBox();
    const text = await msg.getByTestId('msg-content').boundingBox();
    if (!box || !text) throw new Error('missing stopped-turn boxes');
    // Below the message it belongs to, and a real target rather than a sliver.
    expect(box.y).toBeGreaterThan(text.y);
    expect(box.width).toBeGreaterThanOrEqual(60);
    expect(box.height).toBeGreaterThanOrEqual(16);
  });

  test('reads muted, not in the danger colour a failed turn uses', async ({ page }) => {
    await page.goto(STOPPED);
    const status = page.getByTestId('turn-stopped');
    const colour = await status.evaluate((el) => getComputedStyle(el).color);
    const muted = await page
      .getByTestId('msg-content')
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--ink-3').trim());
    expect(muted).not.toBe('');
    // The token resolves to an rgb() string on the element; compare channels.
    const toRgb = async (value: string): Promise<string> =>
      page.evaluate((v) => {
        const probe = document.createElement('span');
        probe.style.color = v;
        document.body.appendChild(probe);
        const out = getComputedStyle(probe).color;
        probe.remove();
        return out;
      }, value);
    expect(colour).toBe(await toRgb(muted));
  });

  // The half-streamed reply must settle: a caret still blinking under a
  // stopped turn promises text that is never coming.
  test('the stopped reply keeps its partial text with no streaming caret', async ({ page }) => {
    await page.goto(STOPPED);
    await expect(page.getByTestId('msg').nth(1)).toContainText('Reading the scheduler');
    await expect(page.locator('.stream-caret')).toHaveCount(0);
  });
});

test.describe('interrupted turn status', () => {
  test('the interrupted message carries a muted status and no action', async ({ page }) => {
    await page.goto(INTERRUPTED);
    const msg = page.locator('[data-turn-interrupted="true"]');
    await expect(msg).toHaveCount(1);
    await expect(msg).toContainText('rename the config module');

    const status = msg.getByTestId('turn-interrupted');
    await expect(status).toHaveText(/Interrupted\./);
    await expect(status).not.toContainText('cancelled');

    // No retry, no Continue — the agent already saw it via the promoted turn.
    await expect(msg.getByTestId('turn-stopped-continue')).toHaveCount(0);
    await expect(status.locator('button')).toHaveCount(0);
  });
});
