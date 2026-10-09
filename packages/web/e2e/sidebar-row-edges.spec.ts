import { test, expect } from '@playwright/test';

// Todoist: "sidebar rows have four different right edges". Every row and toggle
// carried its own literal inset — `.sb-row`/`.batch-row`/the sidebar
// `.empty-hint`s on 6px, the toggles and boxes on 8px, `.ch-row` on 14px (its
// box's 8 plus its own 6), `.recent-folder-row` on 0 — and on top of that the
// scrolling bands lost another 10px to a scrollbar the fixed bands never paid,
// so the hover highlights ragged down the right side of the column.
//
// `--sb-inset` / `--sb-inset-right` on `.sb` are now the single source of that
// inset. jsdom applies no stylesheet, so only a real browser can measure it.

const HARNESS = '/app/dev-harness.html';

/** Every sidebar box whose background paints on hover / active / selection.
 *  `.attention-toggle` is deliberately absent: it is a chip sized to its own
 *  label (spec/14 § One column), so it shares the left edge and has no right
 *  edge to share — `attention-chip-size.spec.ts` owns its geometry.
 *  `.arch-toggle` is deliberately absent too: the cold-storage row is now a
 *  strip of square icon-only buttons (spec/14 § Sidebar item 6 / § One
 *  column), the same "self-contained control" class as the brand row's own
 *  icons and the sidebar collapse chevron — a toolbar, not a text row, so its
 *  individual buttons don't carry the column's edges. `sidebar-lifecycle-icons.spec.ts`
 *  owns its geometry instead. */
const ROW_SELECTORS = [
  '.sb-row',
  '.sb-row.special',
  '.channels',
  '.ch-toggle',
  '.ch-row',
  // The row the Needs attention chip shares with the chat search field: the
  // chip keeps the left edge, the field runs to the shared right edge.
  '.sb-top-row',
  '.sb .empty-hint',
  '.nav-row',
  '.new-chat-row',
  '.batch-tabs',
];

type Edge = { sel: string; left: number; right: number };

async function edges(page: import('@playwright/test').Page, selectors: string[]): Promise<Edge[]> {
  return page.evaluate((sels) => {
    const sb = document.querySelector('.sb') as HTMLElement;
    const box = sb.getBoundingClientRect();
    const out: { sel: string; left: number; right: number }[] = [];
    for (const sel of sels) {
      for (const n of Array.from(document.querySelectorAll(sel))) {
        const b = (n as HTMLElement).getBoundingClientRect();
        if (b.width === 0) continue;
        out.push({
          sel,
          left: Math.round(b.left - box.left),
          right: Math.round(box.right - b.right),
        });
      }
    }
    return out;
  }, selectors);
}

/** Assert every measured box shares one left edge and one right edge. */
function expectOneColumn(found: Edge[], expected: number): void {
  expect(found.length).toBeGreaterThanOrEqual(expected);
  const lefts = new Set(found.map((f) => f.left));
  const rights = new Set(found.map((f) => f.right));
  const detail = found.map((f) => `${f.sel} L${f.left} R${f.right}`).join('\n');
  expect(lefts.size, `left edges differ:\n${detail}`).toBe(1);
  expect(rights.size, `right edges differ:\n${detail}`).toBe(1);
}

test.describe('sidebar row edges', () => {
  test('every row and toggle shares one left and one right edge', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    // Expand the collapsible sections so their rows are in the same stack.
    await page.getByTestId('channels-toggle').click();
    await page.getByTestId('archived-toggle').click();
    await expect(page.getByTestId('channels-list')).toBeVisible();
    await expect(page.getByTestId('archived-section')).toBeVisible();

    // 9 of the 11 selectors render in this seed (`.batch-tabs` and the rest do;
    // `.sb .empty-hint` appears once Archived is open and empty).
    expectOneColumn(await edges(page, ROW_SELECTORS), 9);
  });

  test('the edges hold once the scroll band grows a scrollbar', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    await page.getByTestId('channels-toggle').click();
    await expect(page.getByTestId('channels-list')).toBeVisible();

    const before = await edges(page, ROW_SELECTORS);

    // Overflow `.sb-scroll`. Without a reserved gutter this is the moment the
    // scrolling band's rows jumped 10px left of the fixed bands' rows.
    const scrollbar = await page.evaluate(() => {
      const s = document.querySelector('.sb-scroll') as HTMLElement;
      const filler = document.createElement('div');
      filler.style.height = '4000px';
      s.appendChild(filler);
      return s.offsetWidth - s.clientWidth;
    });
    expect(scrollbar, 'the scroll band should actually be showing a scrollbar').toBeGreaterThan(0);

    const after = await edges(page, ROW_SELECTORS);
    expectOneColumn(after, 8);
    // And nothing moved: the gutter is reserved whether or not it is in use.
    expect(after[0].left).toBe(before[0].left);
    expect(after[0].right).toBe(before[0].right);
  });

  test('a channel row is indented by its text, not by its highlight', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('channels-toggle').click();
    await expect(page.getByTestId('channels-list')).toBeVisible();

    const box = (await page.locator('.channels').boundingBox())!;
    const row = (await page.locator('.ch-row').first().boundingBox())!;
    // Same box as the Channels header it sits under…
    expect(row.x).toBeCloseTo(box.x, 0);
    expect(row.width).toBeCloseTo(box.width, 0);
    // …but the label still starts further in than the header's.
    const label = (await page.locator('.ch-row .ch-name').first().boundingBox())!;
    const head = (await page.locator('.ch-toggle').boundingBox())!;
    expect(label.x).toBeGreaterThan(head.x + 14);
  });

  test('recent-folder rows take the same inset', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    // The seed has no all-archived folder, so this row type never renders here.
    // Its geometry is still pure CSS, so a probe in the same parent measures it.
    const measured = await page.evaluate(() => {
      const scroll = document.querySelector('.sb-scroll') as HTMLElement;
      const row = document.querySelector('.sb-row') as HTMLElement;
      const probe = document.createElement('div');
      probe.className = 'recent-folder-row';
      scroll.appendChild(probe);
      const p = probe.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      probe.remove();
      return { probeLeft: p.left, probeRight: p.right, rowLeft: r.left, rowRight: r.right };
    });
    expect(measured.probeLeft).toBeCloseTo(measured.rowLeft, 0);
    expect(measured.probeRight).toBeCloseTo(measured.rowRight, 0);
  });

  test('batch view rows share the column too', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('batch-tab-batch').click();
    await expect(page.getByTestId('batch-empty')).toBeVisible();

    expectOneColumn(
      await edges(page, [
        '.batch-tabs',
        '.batch-interval',
        '.batch-panel > .toggle',
        '.batch-row',
        '.sb .empty-hint',
        '.sb-row.special',
        '.nav-row',
        '.new-chat-row',
      ]),
      6,
    );
  });
});
