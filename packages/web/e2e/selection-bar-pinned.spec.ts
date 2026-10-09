import { test, expect } from '@playwright/test';

// spec/14 § Sidebar → Scroll regions + § Selecting multiple rows (shift-click):
// the selection bar belongs to the FIXED top band, not to the scrolling chat
// list.
//
// Todoist: "selection bar can archive/delete chats that are scrolled out of
// view". The bar rendered as the first child of `.sb-scroll`, so it scrolled
// away with the rows. With the list squeezed to a couple of visible rows a
// shift-selected range of 6 offered archive and delete for chats that were all
// off screen — and then the bar itself scrolled out of reach too.
//
// Only a real browser can prove this: jsdom has no layout and no scrolling, so
// the bar's box never moves there however the DOM is nested.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

// Short enough that the ~20 seeded chats overflow the list band by a wide
// margin, tall enough that the band still has usable rows in it — squeeze it
// much further and the fixed bands claim the whole column, which is a
// different bug (§ Scroll regions) and makes the rows unclickable.
const SQUEEZED = { width: 1280, height: 620 };

type Box = { x: number; y: number; width: number; height: number };

/** The selection bar's box, or null when it isn't rendered. */
async function barBox(page: import('@playwright/test').Page): Promise<Box> {
  const box = await page.getByTestId('selection-bar').boundingBox();
  if (box === null) throw new Error('selection bar has no box');
  return box;
}

/**
 * Plain-click the first chat row, then shift-click a later one, producing a
 * range big enough that its rows cannot all fit the squeezed list. Returns the
 * count the bar reports.
 */
async function selectALongRange(page: import('@playwright/test').Page): Promise<number> {
  const rows = page.locator('[data-testid^="chat-row-chat_"]');
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();
  expect(total).toBeGreaterThan(5);
  await rows.nth(0).click();
  // Playwright scrolls the target into view to click it, which is exactly the
  // situation being tested: the far end of the range is on screen and the
  // anchor end is not.
  await rows.nth(Math.min(total - 1, 5)).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  const label = await page.getByTestId('selection-count').textContent();
  return Number.parseInt((label ?? '').trim(), 10);
}

/** Scroll the chat list band to its bottom and wait for the scroll to settle. */
async function scrollListToBottom(page: import('@playwright/test').Page): Promise<number> {
  return await page.evaluate(async () => {
    const el = document.querySelector('.sb-scroll');
    if (el === null) throw new Error('no .sb-scroll');
    el.scrollTop = el.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return el.scrollTop;
  });
}

test.describe('the selection bar is pinned above the chat list', () => {
  test.use({ viewport: SQUEEZED });

  test('stays put and stays reachable when the list is scrolled', async ({ page }) => {
    await page.route('**/api/chats/**', (r) => r.fulfill({ status: 200, body: '{"ok":true}' }));
    await page.goto(HARNESS);

    const selected = await selectALongRange(page);
    expect(selected).toBeGreaterThan(1);

    const before = await barBox(page);
    const scrolled = await scrollListToBottom(page);
    // If the list didn't actually scroll the test proves nothing.
    expect(scrolled).toBeGreaterThan(0);

    const after = await barBox(page);
    // The whole point: the bar does not travel with the list.
    expect(Math.round(after.y)).toBe(Math.round(before.y));
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    await expect(page.getByTestId('selection-bar')).toBeInViewport();

    // Its actions are still on screen and still hit-testable — the bar being
    // technically in the DOM is not the same as the user being able to use it.
    await expect(page.getByTestId('selection-archive')).toBeInViewport();
    await expect(page.getByTestId('selection-delete')).toBeInViewport();
    await expect(page.getByTestId('selection-clear')).toBeInViewport();
    await page.getByTestId('selection-clear').click();
    await expect(page.getByTestId('selection-bar')).toHaveCount(0);
  });

  test('sits outside the scrolling band, above the chat list', async ({ page }) => {
    await page.goto(HARNESS);
    await selectALongRange(page);

    const nesting = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="selection-bar"]');
      const scroll = document.querySelector('.sb-scroll');
      if (bar === null || scroll === null) throw new Error('missing bar or scroll band');
      return {
        insideScrollBand: scroll.contains(bar),
        // DOCUMENT_POSITION_FOLLOWING === the scroll band comes after the bar.
        barPrecedesBand:
          (bar.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      };
    });
    expect(nesting.insideScrollBand).toBe(false);
    expect(nesting.barPrecedesBand).toBe(true);

    // And it is drawn above the list rather than merely earlier in the DOM.
    const bar = await barBox(page);
    const band = await page.locator('.sb-scroll').boundingBox();
    if (band === null) throw new Error('no scroll band box');
    expect(bar.y + bar.height).toBeLessThanOrEqual(Math.round(band.y) + 1);
  });

  test('keeps the sidebar right edge it shares with the fixed band', async ({ page }) => {
    await page.goto(HARNESS);
    await selectALongRange(page);

    // spec/14 § Sidebar → One column. Now the bar lives in the fixed band it
    // must line up with the fixed band's controls, which pay the scrollbar
    // gutter as margin rather than out of their content box. The Chats/Batch
    // strip is the top-band reference, not the Needs attention chip: that one
    // is sized by its own label and is exempt from the shared right edge.
    const edges = await page.evaluate(() => {
      const read = (sel: string): { left: number; right: number } => {
        const el = document.querySelector(sel);
        if (el === null) throw new Error(`no element for ${sel}`);
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right) };
      };
      return {
        bar: read('[data-testid="selection-bar"]'),
        tabs: read('.batch-tabs'),
        nav: read('.nav-row'),
      };
    });
    expect(edges.bar.left).toBe(edges.tabs.left);
    expect(edges.bar.right).toBe(edges.tabs.right);
    expect(edges.bar.left).toBe(edges.nav.left);
    expect(edges.bar.right).toBe(edges.nav.right);
  });
});
