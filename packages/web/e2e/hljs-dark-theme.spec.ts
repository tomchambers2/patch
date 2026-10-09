import { test, expect } from '@playwright/test';

// Todoist: "patch no contrast here in dark mode". `Markdown.tsx` highlights
// fenced code with highlight.js and scopes it with the `.hljs` classes; the
// theme was loaded once in index.css as GitHub's LIGHT theme
// (`highlight.js/styles/github.css`), unconditionally — so `.hljs-string` and
// `.hljs-property` (navy/near-black, meant for a white page) painted on the
// dark `--bg-elevated` code-block surface, reading as blank space. Same bug
// class as monaco-theme.spec.ts's diff colours, on a different surface: a
// third-party static theme that never looked at `prefers-color-scheme`.
//
// `chat_bus` (seeded in dev-harness.tsx) carries a real fenced ```js block
// (`const pods = harvest('mangetout'); return pods.length;`), which exercises
// `.hljs-keyword`, `.hljs-title.function_`, `.hljs-string` and the
// no-specific-class fallback (`.hljs-property` on `.length`, coloured by the
// theme's base `.hljs` rule) all in one render.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

type Rgb = [number, number, number];

function parseRgb(value: string): Rgb {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!m) throw new Error(`unparseable colour: "${value}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

test.describe('fenced code blocks follow the app theme', () => {
  test('every hljs token clears AA against the code-block surface in dark mode', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);

    const pre = page.locator('.md-pre').first();
    await expect(pre).toBeVisible();
    const surface = parseRgb(await pre.evaluate((el) => getComputedStyle(el).backgroundColor));

    // The base `.hljs` colour (what a token with no specific class, like
    // `.hljs-property` on `pods.length`, falls back to) and every classed token
    // actually present in the fixture's rendered HTML.
    const code = pre.locator('code.hljs');
    const baseColour = parseRgb(await code.evaluate((el) => getComputedStyle(el).color));
    expect(
      contrast(baseColour, surface),
      `.hljs base colour on the code surface`,
    ).toBeGreaterThanOrEqual(AA);

    const tokenClasses = ['hljs-keyword', 'hljs-title', 'hljs-string'];
    for (const cls of tokenClasses) {
      const el = pre.locator(`.${cls}`).first();
      await expect(el, `.${cls} present in the fixture`).toHaveCount(1);
      const colour = parseRgb(await el.evaluate((n) => getComputedStyle(n).color));
      expect(contrast(colour, surface), `.${cls} on the code surface`).toBeGreaterThanOrEqual(AA);
    }
  });

  test('light mode keeps the light GitHub theme (no regression)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HARNESS);

    const pre = page.locator('.md-pre').first();
    await expect(pre).toBeVisible();
    const keyword = pre.locator('.hljs-keyword').first();
    await expect(keyword).toHaveCount(1);
    // GitHub light's keyword red (#d73a49) — proves the dark theme isn't
    // leaking into light mode via the media-scoped `@import`.
    expect(await keyword.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(215, 58, 73)');
  });

  test('dark mode uses the matching GitHub dark theme, not the light one', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);

    const pre = page.locator('.md-pre').first();
    await expect(pre).toBeVisible();
    const keyword = pre.locator('.hljs-keyword').first();
    await expect(keyword).toHaveCount(1);
    // GitHub dark's keyword red (#ff7b72) — the light theme's #d73a49 would
    // still pass this test's AA check on its own, so this pins the actual fix
    // rather than a colour that happens to be light-enough by coincidence.
    expect(await keyword.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 123, 114)');
  });
});
