import { test, expect, type Page } from '@playwright/test';

// Real-browser e2e for spec/14 § Theming → Tables. In dark mode a transcript
// table's grid, header and rows all but vanished: the grid lines sat ~2.5:1 on
// the panel, the header's fill was the panel's own colour, and nothing told one
// row from the next. Colours are read from the COMPUTED style of the rendered
// table and measured against whatever is actually painted behind it, so the
// test follows the real cascade rather than a token's name.
const TABLE = '/app/dev-harness.html?chat=chat_table';
const table = '.msg-assistant .content table >> nth=0';

type Rgba = [number, number, number, number];

interface Painted {
  ground: Rgba;
  border: Rgba;
  headFill: Rgba;
  headInk: Rgba;
  oddFill: Rgba;
  evenFill: Rgba;
  bodyInk: Rgba;
}

/** Every colour the table paints, plus the opaque colour behind the table. */
async function paintedColours(page: Page): Promise<Painted> {
  return page.locator(table).evaluate((el) => {
    const parse = (c: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) throw new Error(`unparsed colour ${c}`);
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    // The first opaque background at or above `from` — what the eye sees
    // behind a transparent element. Translucent layers are composited on the
    // way down.
    const groundOf = (from: Element): [number, number, number, number] => {
      const layers: Array<[number, number, number, number]> = [];
      for (let n: Element | null = from; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] === 1) break;
      }
      let out: [number, number, number, number] = [255, 255, 255, 1];
      for (const l of layers.reverse()) {
        out = [
          l[0] * l[3] + out[0] * (1 - l[3]),
          l[1] * l[3] + out[1] * (1 - l[3]),
          l[2] * l[3] + out[2] * (1 - l[3]),
          1,
        ];
      }
      return out;
    };
    const th = el.querySelector('th') as HTMLElement;
    const rows = el.querySelectorAll('tbody tr');
    const odd = rows[0]!.querySelector('td') as HTMLElement;
    const even = rows[1]!.querySelector('td') as HTMLElement;
    return {
      ground: groundOf(el.parentElement as Element),
      border: parse(getComputedStyle(th).borderBottomColor),
      headFill: groundOf(th),
      headInk: parse(getComputedStyle(th).color),
      oddFill: groundOf(odd),
      evenFill: groundOf(even),
      bodyInk: parse(getComputedStyle(odd).color),
    };
  });
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, rounded to 2dp so a failure message is readable. */
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

test.describe('transcript tables in dark mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(TABLE);
    await expect(page.locator(table)).toBeVisible();
  });

  test('the grid lines clear 3:1 against the ground behind the table', async ({ page }) => {
    const c = await paintedColours(page);
    expect(c.border[3]).toBe(1);
    expect(contrast(c.border, c.ground)).toBeGreaterThanOrEqual(3);
    // And against the row fills they run between.
    expect(contrast(c.border, c.oddFill)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.border, c.evenFill)).toBeGreaterThanOrEqual(3);
  });

  test('the header row stands out from the body rows and the ground', async ({ page }) => {
    const c = await paintedColours(page);
    expect(contrast(c.headFill, c.ground)).toBeGreaterThanOrEqual(1.25);
    expect(contrast(c.headFill, c.oddFill)).toBeGreaterThanOrEqual(1.25);
    expect(contrast(c.headFill, c.evenFill)).toBeGreaterThanOrEqual(1.1);
  });

  test('alternate rows are striped', async ({ page }) => {
    const c = await paintedColours(page);
    expect(contrast(c.oddFill, c.evenFill)).toBeGreaterThanOrEqual(1.1);
  });

  test('text stays AAA on every fill it sits on', async ({ page }) => {
    const c = await paintedColours(page);
    expect(contrast(c.headInk, c.headFill)).toBeGreaterThanOrEqual(7);
    expect(contrast(c.bodyInk, c.oddFill)).toBeGreaterThanOrEqual(7);
    expect(contrast(c.bodyInk, c.evenFill)).toBeGreaterThanOrEqual(7);
  });
});
