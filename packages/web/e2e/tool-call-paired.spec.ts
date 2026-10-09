import { test, expect } from '@playwright/test';

// spec/14 § Tool calls — "A call and its own result are ONE row, not two".
// A lone call whose result is the next entry folds into a single disclosure
// (Tom: "tool call appears twice — once as the invocation and once as the
// result"). The run-collapsing rule already covered 2+ calls; this is the
// ungrouped case that fell through it.
const PAIRED_CHAT = '/app/dev-harness.html?chat=chat_tool_paired';

test.describe('tool call folded with its result', () => {
  test('a call and its own result render as one row carrying both halves', async ({ page }) => {
    await page.goto(PAIRED_CHAT);

    // Exactly one row, and no separate result row alongside it.
    await expect(page.getByTestId('tool-call')).toHaveCount(1);
    await expect(page.getByTestId('tool-result')).toHaveCount(0);

    // Collapsed by default, summarised as the call — with `→` saying it returned.
    const row = page.getByTestId('tool-call');
    await expect(row).toHaveAttribute('data-open', 'false');
    await expect(row).toContainText('Read poll.ts');
    await expect(row).toContainText('→');

    // Expanding shows the args AND what came back, in the same disclosure.
    await page.getByTestId('tool-call-summary').click();
    await expect(page.getByTestId('tool-call-detail')).toContainText('src/poll.ts');
    await expect(page.getByTestId('tool-call-result')).toContainText('export const poll = 1;');
  });
});
