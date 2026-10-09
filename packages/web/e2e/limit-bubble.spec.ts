import { test, expect, type Page } from '@playwright/test';

// spec/12 § A usage or rate limit — what a person is shown when a turn cannot
// run yet.
//
// This is in a REAL browser rather than jsdom for the two things jsdom cannot
// judge: where the notice sits in the document (it has to be inside the
// transcript, under the last message — it used to be a strip in the chrome),
// and whether the countdown actually counts (a countdown that does not count is
// a timestamp with extra steps).
//
// The sentence it replaced was "Extra usage limit on Default, resuming at 15:40
// (in 1 h)", which named a limit nobody had reached — overage is the OVERFLOW
// that covers for the session and week, not something a person spends — gave a
// clock time instead of a wait, and used a unit symbol nobody says out loud.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

/** Park `chat_md` on a limit, exactly as a `chat.state` from the host would. */
async function park(
  page: Page,
  block: Record<string, unknown>,
  msFromNow = 63 * 60_000,
): Promise<void> {
  await page.evaluate(
    ({ block: b, ms }) => {
      const w = window as unknown as {
        __store: {
          getState: () => {
            chats: Record<string, { daemonId: string; folder: string }>;
            applyEvent: (e: unknown) => void;
          };
        };
        __presenceStore: { getState: () => { setHostReport: (e: unknown) => void } };
      };
      w.__presenceStore.getState().setHostReport({
        type: 'daemon.host',
        daemonId: 'd1',
        hostName: 'box',
        backends: [],
        components: [],
        autoResumeRateLimit: true,
      });
      const row = w.__store.getState().chats['chat_md']!;
      const at = Date.now() + ms;
      w.__store.getState().applyEvent({
        type: 'chat.state',
        chatId: 'chat_md',
        daemonId: row.daemonId,
        activity: 'idle',
        folder: row.folder,
        lastUpdated: Date.now(),
        permissionMode: 'bypassPermissions',
        rateLimitResumingAt: at,
        resumeKind: 'rate_limit',
        limitBlock: { resetsAt: at, ...b },
      });
    },
    { block, ms: msFromNow },
  );
}

test.describe('the limit bubble', () => {
  test('names the pool that RAN OUT, never the overflow that failed to cover it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await park(page, {
      scope: 'session',
      accountLabel: 'Default',
      overageBlocked: true,
      overageReason: 'org_level_disabled_until',
    });

    const bubble = page.getByTestId('rate-limit-bar');
    await expect(page.getByTestId('rate-limit-headline')).toContainText(
      /reached your session limit/i,
    );
    await expect(page.getByTestId('rate-limit-account')).toHaveText('Default');
    // The headline that started this. It must not come back.
    await expect(bubble).not.toContainText(/extra usage limit/i);
  });

  test('sits in the transcript under the last message, not in the chrome above it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await park(page, { scope: 'session' });

    const inStream = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="rate-limit-bar"]');
      const stream = document.querySelector('[data-testid="chat-stream"]');
      return {
        inside: !!(el && stream && stream.contains(el)),
        last: !!(el && el.parentElement && el.parentElement.lastElementChild === el),
      };
    });
    expect(inStream.inside).toBe(true);
    expect(inStream.last).toBe(true);
  });

  test('counts down, in words, without anything else changing', async ({ page }) => {
    await page.goto(HARNESS);
    // 125s reads as "3 minutes"; ten seconds later it must read "2 minutes".
    // Nothing else touches the store in between, so only the component's own
    // clock can move it.
    await park(page, { scope: 'session' }, 125_000);

    const countdown = page.getByTestId('rate-limit-countdown');
    await expect(countdown).toContainText('3 minutes');
    await expect(countdown).toContainText('2 minutes', { timeout: 20_000 });
    // A unit symbol is not something a person says.
    await expect(countdown).not.toContainText(/\d+\s?h\b/);
  });

  test('offers the way to turn extra usage on only when that is what left no overflow', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await park(page, { scope: 'week' });
    await expect(page.getByTestId('rate-limit-bar')).toBeVisible();
    await expect(page.getByTestId('rate-limit-extra-usage')).toHaveCount(0);

    await park(page, {
      scope: 'session',
      overageBlocked: true,
      overageReason: 'org_level_disabled_until',
    });
    const link = page.getByTestId('rate-limit-extra-usage');
    // A link, not a switch: patch cannot flip an Anthropic account setting, and
    // a control that pretends to is worse than none. The explanation that used
    // to be a paragraph of chrome lives on it.
    await expect(link).toHaveAttribute('href', /claude\.ai/);
    await expect(link).toHaveAttribute('title', /not enabled/i);
    await expect(link).toHaveAttribute('title', /nothing has been overspent/i);
    // Not "this organisation": a personal subscription has no organisation
    // that did anything, and the sentence read as an accusation.
    await expect(link).not.toHaveAttribute('title', /organisation/i);
  });

  test('carries the auto-resume choice, ticked, and the manual retry', async ({ page }) => {
    await page.goto(HARNESS);
    await park(page, { scope: 'session' });

    await expect(page.getByTestId('rate-limit-auto-resume')).toBeChecked();
    await expect(page.getByTestId('rate-limit-retry')).toBeVisible();
  });
});
