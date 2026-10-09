import { test, expect } from '@playwright/test';

// spec/14 § Main chat panel — "Tool runs collapse to one row". The fixture turn
// (dev-harness.tsx, chat_tools) fires six tools around one file edit, so the
// transcript must show two group rows plus the edit's own row — not thirteen
// rows. Real browser: only here can we prove the collapsed run actually costs
// one row of height and the expanded rows are really visible.
const HARNESS = '/app/dev-harness.html?chat=chat_tools';

test.describe('tool-run grouping', () => {
  test('a run of tool calls collapses to one narrated row', async ({ page }) => {
    await page.goto(HARNESS);
    const groups = page.locator('[data-testid="tool-group"]');
    await expect(groups).toHaveCount(2);
    // What the batch did, not what it acted on — that's what expanding the
    // row is for.
    await expect(groups.first()).toHaveText('▸Searched for 2 patterns, read 1 file');
    await expect(groups.nth(1)).toHaveText('▸Ran 1 command, read 1 file');

    // Collapsed, a group is a single row — not a stack of six.
    const height = await groups.first().evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(48);

    // The six folded rows are genuinely absent; only the edit's row is present.
    const calls = page.locator('[data-testid="tool-call"]');
    await expect(calls).toHaveCount(1);
    await expect(calls.first()).toHaveAttribute('data-edit', 'true');
    await expect(page.locator('[data-testid="tool-result"]')).toHaveCount(0);
  });

  test('the collapsed summary text is set in the body font, not the code font', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const summaryText = page.locator('[data-testid="tool-group"] .tool-summary-text').first();
    const fontFamily = await summaryText.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).not.toMatch(/JetBrains Mono/);
  });

  test('the file edit inside the run keeps its own row, diff collapsed until the chevron is clicked', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const edit = page.locator('[data-testid="tool-call"][data-edit="true"]');
    await expect(edit).toBeVisible();
    await expect(edit).toContainText('src/poll.ts');
    // Collapsed by default — same as every other tool call (spec/14 § Diffs).
    await expect(edit).toHaveAttribute('data-open', 'false');
    await expect(page.locator('[data-testid="diff-add-line"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-del-line"]')).toHaveCount(0);

    await edit.locator('[data-testid="tool-call-diff-toggle"]').click();

    await expect(edit).toHaveAttribute('data-open', 'true');
    await expect(page.locator('[data-testid="diff-add-line"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="diff-del-line"]')).toHaveCount(1);
  });

  test('clicking a group expands it into the individual call and result rows', async ({ page }) => {
    await page.goto(HARNESS);
    const group = page.locator('[data-testid="tool-group"]').first();
    const collapsed = await group.evaluate((el) => el.getBoundingClientRect().height);

    await group.locator('[data-testid="tool-group-summary"]').click();
    await expect(group).toHaveAttribute('data-open', 'true');
    await expect(group.locator('[data-testid="tool-call"]')).toHaveCount(3);
    await expect(group.locator('[data-testid="tool-result"]')).toHaveCount(3);
    await expect(group.locator('[data-testid="tool-call"]').first()).toBeVisible();

    const expanded = await group.evaluate((el) => el.getBoundingClientRect().height);
    expect(expanded).toBeGreaterThan(collapsed);

    // Collapses again on a second click.
    await group.locator('[data-testid="tool-group-summary"]').first().click();
    await expect(group).toHaveAttribute('data-open', 'false');
    await expect(group.locator('[data-testid="tool-call"]')).toHaveCount(0);
  });

  // The expanded args/result render as formatted key/value fields, not a raw
  // JSON blob — real-browser proof that the visible text has no
  // braces/quotes-as-punctuation and each arg is its own row.
  test('an expanded tool call inside a group shows formatted key/value fields, not raw JSON', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const group = page.locator('[data-testid="tool-group"]').first();
    await group.locator('[data-testid="tool-group-summary"]').click();

    // fixture: seq 2 is `Grep` with toolArgs { pattern: 'timeout' }.
    const grepCall = group.locator('[data-testid="tool-call"]').first();
    await grepCall.locator('[data-testid="tool-call-summary"]').click();
    const detail = grepCall.locator('[data-testid="tool-call-detail"]');
    await expect(detail).toBeVisible();
    await expect(detail).not.toContainText('{');
    await expect(detail.locator('.tool-field-row')).toHaveCount(1);
    await expect(detail.locator('.tool-field-key')).toHaveText('pattern');
    await expect(detail).toContainText('timeout');
  });
});
