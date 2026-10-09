import { test, expect } from '@playwright/test';

// Todoist: "sidebar empty-state text is misaligned with every other row".
// `.empty-hint`'s shared `padding: 8px 2px` put every sidebar placeholder
// ("No chats match …", the per-section load errors, "No chats in the
// batch.") ~2px off the scroll region's raw edge, while `.sb-row` / `.batch-row`
// beside them sit on a 6px margin + 14px padding. jsdom applies no stylesheet,
// so only a real browser can measure the painted geometry.
//
// `[data-testid='attention-empty']` is covered separately by
// attention-empty-spacing.spec.ts — it aligns to the toggle above it (8px), not
// to the rows, and that difference is intentional.

const HARNESS = '/app/dev-harness.html';

test.describe('sidebar empty-state inset', () => {
  test('chat search placeholders line up with the chat rows', async ({ page }) => {
    // The harness serves no backend: answer the search with zero hits and one
    // host that was not searched, so both `.empty-hint` lines render.
    await page.route('**/api/chats/search**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          query: 'zzz-no-such-chat',
          hits: [],
          total: 0,
          nextOffset: null,
          hosts: [{ daemonId: 'mac1', hostName: 'Mac', state: 'offline' }],
        }),
      }),
    );
    await page.goto(HARNESS);
    const rowBox = (await page.locator('.sb-row').first().boundingBox())!;

    await page.getByTestId('chat-search').fill('zzz-no-such-chat');

    for (const id of ['chat-search-empty', 'chat-search-host-mac1']) {
      const hint = page.getByTestId(id);
      await expect(hint).toBeVisible();
      const hintBox = (await hint.boundingBox())!;
      // Same left edge as a row, not the 0px scroll-region edge the bare
      // `.empty-hint` gave it.
      expect(hintBox.x).toBeGreaterThan(4);
      expect(hintBox.x).toBeCloseTo(rowBox.x, 0);
      // And the text inside starts on the row's 14px content inset.
      const padLeft = await hint.evaluate((el) => getComputedStyle(el).paddingLeft);
      expect(padLeft).toBe('14px');
    }
  });

  test('"No chats in the batch." lines up with the batch rows', async ({ page }) => {
    await page.goto(HARNESS);
    const rowBox = (await page.locator('.sb-row').first().boundingBox())!;

    await page.getByTestId('batch-tab-batch').click();

    const empty = page.getByTestId('batch-empty');
    await expect(empty).toBeVisible();
    // This test owns the ALIGNMENT, not the wording — batch-empty-affordance
    // spec.ts is what pins the copy. Assert only enough to prove the right
    // element was measured.
    await expect(empty).toContainText('No chats in the batch');

    const emptyBox = (await empty.boundingBox())!;
    expect(emptyBox.x).toBeGreaterThan(4);
    expect(emptyBox.x).toBeCloseTo(rowBox.x, 0);
  });

  test('the inset is scoped to the sidebar — `.empty-hint` elsewhere keeps its compact padding', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    // The chat panel is a SIBLING of `aside.sb`, so `.sb .empty-hint` cannot
    // reach ThreadsStrip's `.threads-empty` / the routes' `.empty` placeholders.
    const leaks = await page.evaluate(() => {
      const sb = document.querySelector('.sb');
      const probe = document.createElement('div');
      probe.className = 'empty-hint';
      document.querySelector('main, .three-col > :not(.sb)')?.appendChild(probe);
      const pad = getComputedStyle(probe).padding;
      probe.remove();
      return { insideSb: Boolean(sb), outsidePad: pad };
    });
    expect(leaks.insideSb).toBe(true);
    expect(leaks.outsidePad).toBe('8px 2px');
  });
});
