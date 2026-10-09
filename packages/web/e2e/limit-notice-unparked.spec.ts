import { test, expect } from '@playwright/test';

// A usage limit with no resume armed — auto-resume off (spec/12 § A turn only
// dies for a reason someone chose).
//
// The host publishes the structured block for this case too, and reports the
// failure in patch's own words. The bubble used to be gated on a resume time
// that this path never sets, so the whole structured notice vanished and the
// only account of the failure left in the transcript was the provider's own
// sentence — a monthly spend limit nobody overspent, and a reset hour in a zone
// the reader is not in.
test.describe('the limit notice when nothing was parked', () => {
  test('states the limit, and offers the controls that do something about it', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_limit_blocked');
    const bar = page.locator('[data-testid="rate-limit-bar"]');
    await expect(bar).toBeVisible();
    // The pool a person spends, on the account that spent it.
    await expect(page.locator('[data-testid="rate-limit-headline"]')).toContainText(
      /reached your weekly limit/i,
    );
    await expect(page.locator('[data-testid="rate-limit-account"]')).toHaveText('Default');
    // The wait, in words, not a unit symbol.
    await expect(page.locator('[data-testid="rate-limit-countdown"]')).toContainText(
      /It resets in .*hour/i,
    );
    await expect(page.locator('[data-testid="rate-limit-retry"]')).toBeVisible();
    await expect(page.locator('[data-testid="rate-limit-auto-resume"]')).toBeAttached();
    await expect(page.locator('[data-testid="rate-limit-extra-usage"]')).toBeVisible();
    // In the transcript, under the turn it is about — not in the banner stack.
    await expect(page.locator('[data-testid="chat-stream"]')).toContainText(
      /reached your weekly limit/i,
    );
  });

  test('reports the failure once, and never in the provider’s words', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_limit_blocked');
    await expect(page.locator('[data-testid="rate-limit-bar"]')).toBeVisible();
    // The turn that failed carries the mark and the retry — that is all it
    // needs to; the limit itself is accounted for once, in the notice.
    await expect(page.locator('[data-testid="turn-failed"]')).toBeVisible();
    await expect(page.locator('[data-testid="turn-retry"]')).toBeVisible();
    const stream = await page.locator('[data-testid="chat-stream"]').innerText();
    expect(stream).not.toMatch(/spend limit/i);
    expect(stream).not.toMatch(/claude\.ai\/settings\/usage/i);
    expect(stream).not.toMatch(/cc_cli_limit_message/);
  });
});
