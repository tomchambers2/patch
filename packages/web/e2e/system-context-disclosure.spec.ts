import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for the
// per-turn system-reminder disclosure — spec/02 § System-reminder disclosure,
// spec/14 § Main chat panel. jsdom covers the reducer (chatStore tests) and the
// collapsed/expanded DOM (ChatRoute.test.tsx); what only a real browser shows is
// that the disclosure actually sits under the turn it belongs to — between that
// bubble and the reply — and stays quiet: small, muted, no fill of its own.
//
// `chat_system_context` is seeded in dev-harness.tsx through the real reducer:
// a turn carrying a todo-edit reminder, re-sent after a host restart with the
// restart reminder (which folds onto the same bubble), then answered.
const HARNESS = '/app/dev-harness.html?chat=chat_system_context';

test.describe('system-reminder disclosure', () => {
  test('draws one collapsed row per block under the one bubble, in injection order', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const userBubbles = page.locator('[data-testid="msg"].msg-user');
    await expect(userBubbles).toHaveCount(1);

    const rows = userBubbles.first().getByTestId('system-context');
    await expect(rows).toHaveCount(2);
    const summaries = userBubbles.first().getByTestId('system-context-summary');
    await expect(summaries.nth(0)).toContainText('Todo list updated');
    await expect(summaries.nth(1)).toContainText('Turn interrupted by restart');
    await expect(page.getByTestId('system-context-detail')).toHaveCount(0);
  });

  test('sits between the turn and the reply, and opens to the raw block on click', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const content = page.locator('[data-testid="msg"].msg-user [data-testid="msg-content"]');
    const group = page.getByTestId('system-context-group');
    const reply = page.locator('[data-testid="msg"].msg-assistant');

    const contentBox = await content.boundingBox();
    const groupBox = await group.boundingBox();
    const replyBox = await reply.boundingBox();
    expect(contentBox && groupBox && replyBox).toBeTruthy();
    expect(groupBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height - 1);
    expect(groupBox!.y + groupBox!.height).toBeLessThanOrEqual(replyBox!.y + 1);

    // Quiet furniture: set smaller than the message it annotates.
    const summary = page.getByTestId('system-context-summary').nth(1);
    const summarySize = await summary.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const bodySize = await content.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(summarySize).toBeLessThan(bodySize);

    await summary.click();
    const detail = page.getByTestId('system-context-detail');
    await expect(detail).toHaveCount(1);
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('cut off partway');
  });
});
