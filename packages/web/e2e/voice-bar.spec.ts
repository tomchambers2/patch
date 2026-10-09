import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real CSS, no backend) for spec/07 § Session
// modes: a sustained session is a BAR IN FLOW at the top of the shell, not a
// floating capsule over the app. jsdom can assert the text; only a real browser
// can show that the bar sits above the columns and does not cover them — which
// is the whole reason it stopped being a capsule.
const HANDS_FREE = '/app/dev-harness.html?chat=thread_manager&voice=hands-free';
const CALL = '/app/dev-harness.html?chat=thread_manager&voice=call';

test.describe('voice bar', () => {
  test('sits above the columns and takes its own height — nothing is covered', async ({ page }) => {
    await page.goto(HANDS_FREE);
    const bar = page.getByTestId('voice-bar');
    await expect(bar).toBeVisible();
    const barBox = await bar.boundingBox();
    const cols = await page.locator('.three-col').boundingBox();
    expect(barBox).not.toBeNull();
    expect(cols).not.toBeNull();
    // In flow: the bar starts at the top, and the columns start BELOW it.
    expect(barBox!.y).toBeLessThan(4);
    expect(cols!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
    // A strip, not a takeover.
    expect(barBox!.height).toBeLessThan(60);
    // And it spans the window, so it reads as a mode that is switched on.
    expect(barBox!.width).toBeGreaterThan(1000);
  });

  test('hands-free says the word that wakes it, and names the chat', async ({ page }) => {
    await page.goto(HANDS_FREE);
    await expect(page.getByTestId('voice-bar-head')).toContainText('HANDS-FREE');
    await expect(page.getByTestId('voice-bar-chat')).toContainText(/manager/i);
    await expect(page.getByTestId('voice-bar-line')).toContainText('Waiting for you to say');
    await expect(page.getByTestId('voice-bar-line')).toContainText('patch');
  });

  test('a dropped utterance is shown, greyed, as heard-but-not-sent', async ({ page }) => {
    await page.goto(`${HANDS_FREE}&voiceLine=${encodeURIComponent('hello, how is it going')}`);
    const bar = page.getByTestId('voice-bar');
    await expect(bar).toHaveAttribute('data-state', 'heard');
    await expect(page.getByTestId('voice-bar-line')).toContainText('not addressed, so not sent');
    const opacity = await page
      .getByTestId('voice-bar-line')
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThan(1);
  });

  test('a call gets the same bar, and never asks for an address word', async ({ page }) => {
    await page.goto(CALL);
    await expect(page.getByTestId('voice-bar-head')).toContainText('ON CALL');
    await expect(page.getByTestId('voice-bar-line')).toHaveText('Listening');
    // Controls are reachable — the capsule's one advantage was that it was
    // clickable, and the bar must not lose it.
    await expect(page.getByTestId('voice-bar-mute')).toBeVisible();
    await expect(page.getByTestId('voice-bar-mode')).toBeVisible();
    await expect(page.getByTestId('voice-bar-end')).toBeVisible();
  });
});
