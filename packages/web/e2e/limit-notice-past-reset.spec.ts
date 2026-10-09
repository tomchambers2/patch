import { test, expect, type Page } from '@playwright/test';

// spec/12 § A usage or rate limit — the limit notice must not outlive the limit.
//
// Past its own reset the bubble used to read "You've reached your session limit
// on Default. It should be back now." and sit in the transcript for ever: a
// notice about a condition that is over, saying nothing about the reply it is
// standing in for still not having been sent, and with no way for it to go. The
// reported bug was that Patch was SHOWING him that.
//
// Two states have to be told apart. A chat whose turn is in flight is not parked
// on anything, so the notice withdraws itself. A chat still parked past its reset
// keeps it — `Try now` is the only thing left that moves it on — but says the
// true thing about why it is there.
const HARNESS = '/app/dev-harness.html?chat=chat_limit_past_reset';

/** A `chat.state` for the fixture chat that says NOTHING about the pause. */
function chatState(page: Page, activity: string): Promise<void> {
  return page.evaluate((a) => {
    const store = (
      window as unknown as {
        __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
      }
    ).__store;
    store.getState().applyEvent({
      type: 'chat.state',
      chatId: 'chat_limit_past_reset',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: a,
      lastUpdated: Date.now(),
    });
  }, activity);
}

test.describe('the limit notice once the limit has reset', () => {
  test('says the turn has not run, rather than that the limit is back', async ({ page }) => {
    await page.goto(HARNESS);
    const bar = page.getByTestId('rate-limit-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('rate-limit-headline')).toContainText(
      /reached your session limit/i,
    );
    // The exact figure is pinned against a frozen clock in the unit test; here
    // the harness seeds "20 minutes ago" at load and the page renders a second
    // or two later, and the elapsed time rounds UP to the minute.
    await expect(page.getByTestId('rate-limit-countdown')).toContainText(
      /That was 2[01] minutes ago and this turn has not run\./i,
    );
    // The sentence that reads as "nothing to do here" is gone.
    await expect(bar).not.toContainText(/should be back now/i);
  });

  test('makes Try now the action once there is nothing left to wait for', async ({ page }) => {
    await page.goto(HARNESS);
    const retry = page.getByTestId('rate-limit-retry');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute('data-past-reset', 'true');
    // Not one of three equal controls any more.
    await expect(retry).toHaveCSS('font-weight', '600');
  });

  test('leaves it an ordinary control while the wait is still running', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_limit_blocked');
    const retry = page.getByTestId('rate-limit-retry');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute('data-past-reset', 'false');
    await expect(retry).not.toHaveCSS('font-weight', '600');
  });

  test('withdraws itself the moment the chat reports a turn in flight', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    // The host speaks for the chat again — `Try now` landed, or the user sent
    // something, or a restart re-sent the owed turn. This frame says NOTHING
    // about the pause: the activity alone is the signal.
    await chatState(page, 'running');
    await expect(page.getByTestId('rate-limit-bar')).toHaveCount(0);
  });

  test('withdraws itself when the resumed turn stops for a permission prompt', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    await chatState(page, 'awaiting-permission');
    await expect(page.getByTestId('rate-limit-bar')).toHaveCount(0);
  });

  test('stands while the chat is still parked — time alone is not a signal', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    // An errored chat is exactly the shape a limit nobody parked wears, and an
    // idle one is the shape an armed pause wears. Neither may clear it.
    await chatState(page, 'errored');
    await chatState(page, 'idle');
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    await expect(page.getByTestId('rate-limit-retry')).toBeVisible();
  });
});

// Todoist: "patch error is wrong" — the banner read "That was 20690 days 23
// hours ago", a plain `now - epoch 0`. An upstream reading of `resetsAt: 0`
// (see @patch/auth's claude-usage.test.ts and host's
// limit-block-invented-reset.test.ts for where a 0 can originate) must be
// treated exactly like no reset stated, not like a reset in 1970.
test.describe('a limitBlock whose resetsAt is epoch 0', () => {
  test('shows no countdown or elapsed-time text at all', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_limit_epoch_reset');
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    await expect(page.getByTestId('rate-limit-headline')).toContainText(
      /reached your session limit/i,
    );
    await expect(page.getByTestId('rate-limit-countdown')).toHaveCount(0);
    await expect(page.getByTestId('rate-limit-bar')).not.toContainText(/ago/i);
  });
});
