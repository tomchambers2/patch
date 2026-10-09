import { test, expect, type Locator } from '@playwright/test';

// Real-browser e2e for spec/14 § Wide tables. A ten-column table inside the
// 780px reading measure was crushed into it: the message body's
// `overflow-wrap: anywhere` was inherited into the cells, which let them break
// mid-WORD, which drove the table's min-content width down to a couple of
// characters per column — so it always "fitted", the `overflow-x: auto` scroll
// never engaged, and headers rendered as `Deli/vere/d`. `chat_table` is seeded
// with a wide table, a prose paragraph and a small table in one reply.
const TABLE = '/app/dev-harness.html?chat=chat_table';

const MEASURE = 780;
const WIDE = { width: 1800, height: 900 };
const NARROW = { width: 700, height: 900 };

const wideTable = '.msg-assistant .content table >> nth=0';
const smallTable = '.msg-assistant .content table >> nth=1';
const prose = '.msg-assistant .content p >> nth=0';

/** How many line boxes the element's text actually occupies. */
async function lineCount(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  });
}

test.describe('wide transcript tables', () => {
  test('a wide table grows past the reading measure', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(TABLE);
    const table = page.locator(wideTable);
    await expect(table).toBeVisible();
    const width = await table.evaluate((el) => el.getBoundingClientRect().width);
    // The whole point: it is no longer confined to the prose column.
    expect(width).toBeGreaterThan(MEASURE);
  });

  test('prose in the same message stays at the reading measure', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(TABLE);
    const paragraph = page.locator(prose);
    await expect(paragraph).toBeVisible();
    const width = await paragraph.evaluate((el) => el.getBoundingClientRect().width);
    // Widening the table must not widen the reading measure with it.
    expect(width).toBeLessThanOrEqual(MEASURE);
  });

  test('no header cell breaks mid-word', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(TABLE);
    await expect(page.locator(wideTable)).toBeVisible();
    const headers = page.locator(`${wideTable} >> th`);
    const count = await headers.count();
    expect(count).toBe(10);
    for (let i = 0; i < count; i += 1) {
      const th = headers.nth(i);
      const text = (await th.innerText()).trim();
      // Every header here is a single word or a short phrase; each must sit on
      // one line rather than being sliced into `Si`/`ze`.
      expect({ text, lines: await lineCount(th) }).toEqual({ text, lines: 1 });
    }
  });

  test('cells wrap between words, never inside one', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto(TABLE);
    const cell = page.locator(`${wideTable} >> td >> nth=0`);
    await expect(cell).toBeVisible();
    const wrap = await cell.evaluate((el) => {
      const s = getComputedStyle(el);
      return { overflowWrap: s.overflowWrap, wordBreak: s.wordBreak };
    });
    // `anywhere` / `break-word` / `break-all` are all licences to split a word,
    // and `anywhere` additionally collapses the table's intrinsic width.
    expect(wrap).toEqual({ overflowWrap: 'normal', wordBreak: 'normal' });
  });

  test('a table too wide even for the panel scrolls rather than squashing', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto(TABLE);
    const table = page.locator(wideTable);
    await expect(table).toBeVisible();
    const { scrollWidth, clientWidth, overflowX } = await table.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(overflowX).toBe('auto');
    // Ten columns cannot fit a 700px window, so the last resort is in play —
    // and it is the TABLE that scrolls, which is what the next test checks.
    expect(scrollWidth).toBeGreaterThan(clientWidth);
  });

  test('a narrow panel keeps the table inside the panel, with no indent', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto(TABLE);
    const table = page.locator(wideTable);
    await expect(table).toBeVisible();
    const box = await page.evaluate(() => {
      const stream = document.querySelector('.chat-stream') as HTMLElement;
      const t = document.querySelector('.msg-assistant .content table') as HTMLElement;
      const p = document.querySelector('.msg-assistant .content p') as HTMLElement;
      const s = getComputedStyle(stream);
      const sr = stream.getBoundingClientRect();
      return {
        table: t.getBoundingClientRect(),
        prose: p.getBoundingClientRect(),
        contentLeft: sr.left + parseFloat(s.paddingLeft),
        contentRight: sr.right - parseFloat(s.paddingRight),
        streamScrollWidth: stream.scrollWidth,
        streamClientWidth: stream.clientWidth,
      };
    });
    // The slack clamps to zero below the measure. A negative margin derived
    // from `(100% - 780px) / 2` inverts here and would hang the table out of
    // the panel — so the edges are asserted, not the margin.
    expect(box.table.left).toBeGreaterThanOrEqual(box.contentLeft - 1);
    expect(box.table.right).toBeLessThanOrEqual(box.contentRight + 1);
    // Flush with the prose: no stray indent either way.
    expect(Math.abs(box.table.left - box.prose.left)).toBeLessThanOrEqual(1);
    // And the transcript itself never gains a horizontal scrollbar.
    expect(box.streamScrollWidth).toBeLessThanOrEqual(box.streamClientWidth + 1);
  });

  test('a wide table grows evenly on both sides and stays inside the panel', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(TABLE);
    await expect(page.locator(wideTable)).toBeVisible();
    const box = await page.evaluate(() => {
      const stream = document.querySelector('.chat-stream') as HTMLElement;
      const t = document.querySelector('.msg-assistant .content table') as HTMLElement;
      const p = document.querySelector('.msg-assistant .content p') as HTMLElement;
      const s = getComputedStyle(stream);
      const sr = stream.getBoundingClientRect();
      return {
        table: t.getBoundingClientRect(),
        prose: p.getBoundingClientRect(),
        contentLeft: sr.left + parseFloat(s.paddingLeft),
        contentRight: sr.right - parseFloat(s.paddingRight),
        streamScrollWidth: stream.scrollWidth,
        streamClientWidth: stream.clientWidth,
      };
    });
    // Todoist: "patch tables should expand evenly on both sides, not just
    // awkwardly right" — it spills past the prose on the LEFT as well…
    expect(box.table.left).toBeLessThan(box.prose.left - 20);
    // …by the same amount it spills past on the right.
    const spillLeft = box.prose.left - box.table.left;
    const spillRight = box.table.right - box.prose.right;
    expect(Math.abs(spillLeft - spillRight)).toBeLessThanOrEqual(2);
    // It grows into the empty gutters, but stops at the panel's edges — one
    // pixel further puts a horizontal scrollbar under the whole transcript.
    expect(box.table.left).toBeGreaterThanOrEqual(box.contentLeft - 1);
    expect(box.table.right).toBeLessThanOrEqual(box.contentRight + 1);
    expect(box.streamScrollWidth).toBeLessThanOrEqual(box.streamClientWidth + 1);
  });

  test('a small table keeps its natural width, centred in the column', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(TABLE);
    const table = page.locator(smallTable);
    await expect(table).toBeVisible();
    const t = await table.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, left: r.left, right: r.right };
    });
    const p = await page.locator(prose).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    const stream = await page.locator('.chat-stream').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    // Two short columns are not stretched to fill the room that is going spare…
    expect(t.width).toBeLessThan(300);
    // …and they sit in the middle of the chat rather than flush against its
    // left margin (Todoist: "patch tables should be centred in middle of chat,
    // not start at left edge"): equal space either side within the column the
    // prose occupies…
    expect(Math.abs(t.left - p.left - (p.right - t.right))).toBeLessThanOrEqual(2);
    expect(t.left - p.left).toBeGreaterThan(100);
    // …and that column is itself the middle of the transcript.
    const mid = (a: { left: number; right: number }): number => (a.left + a.right) / 2;
    expect(Math.abs(mid(t) - mid(stream))).toBeLessThanOrEqual(20);
  });

  test('a wide table is painted in full, not clipped at the message box', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(TABLE);
    await expect(page.locator(wideTable)).toBeVisible();
    // Bounding rects say where the table IS; they do not say whether it is
    // painted there. `.msg` uses `content-visibility: auto`, which implies paint
    // containment and clips whatever spills past the message box — so the
    // gutter-borrowing table lost its edges (Todoist: "patch tables are cut
    // off"). Hit-test just inside each outer edge: a clipped edge hits the
    // transcript behind it instead of the table.
    const hit = await page.evaluate(() => {
      const t = document.querySelector('.msg-assistant .content table') as HTMLElement;
      const r = t.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const inside = (x: number): boolean => !!document.elementFromPoint(x, y)?.closest('table');
      return { left: inside(r.left + 3), right: inside(r.right - 3) };
    });
    expect(hit).toEqual({ left: true, right: true });
  });
});
