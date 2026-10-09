import { test, expect } from '@playwright/test';

// Monaco follows the app's palette, in a real browser, at a real colour scheme.
// Todoist: "editor does not folow light/dark theme" and "diff not visible on
// dark mode".
//
// Why this can only be checked here: `monaco.editor.defineTheme` takes CONCRETE
// colours, so `lib/monacoTheme.ts` reads the palette back off `:root` with
// `getComputedStyle`. jsdom has neither a cascade for custom properties nor
// `matchMedia`, so the unit tests can only assert the plumbing. What actually
// reaches the screen is Monaco's own `--vscode-*` variables, which its theme
// service writes from the theme it was given — that is what is asserted below.
//
// `?editor=diff` mounts the real EditorRail in diff mode over a seeded change
// set (see dev-harness.tsx).
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=diff';

// Monaco is a big lazy chunk (~2s to first paint on an idle box, worse with
// four Playwright workers sharing the machine). Only the mount gets headroom.
const MONACO_MOUNT = { timeout: 20_000 };

/**
 * The palette value the app's own CSS resolves `token` to, right now, as
 * `#rrggbb`. Shorthand is expanded because a custom property's computed value is
 * the token stream as authored, and the production CSS is minified (`#ffffff` →
 * `#fff`) — the same expansion `lib/monacoTheme.ts` does before handing colours
 * to Monaco, so this assertion means the same thing in dev and in a built app.
 */
async function appToken(page: import('@playwright/test').Page, token: string): Promise<string> {
  const raw = await page.evaluate(
    (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
    token,
  );
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  return (
    short ? `#${short[1]!}${short[1]!}${short[2]!}${short[2]!}${short[3]!}${short[3]!}` : raw
  ).toLowerCase();
}

/** What Monaco actually paints with: the variable its theme service injected. */
async function monacoVar(page: import('@playwright/test').Page, name: string): Promise<string> {
  return page
    .locator('.monaco-diff-editor')
    .first()
    .evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
}

type Rgb = [number, number, number];

/** `rgba(r, g, b, a)` or `#rrggbb` → channels + alpha. */
function parseColour(value: string): { rgb: Rgb; alpha: number } {
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!hex) throw new Error(`unparseable colour: "${value}"`);
  return {
    rgb: [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)],
    alpha: 1,
  };
}

/** Alpha-composite `fg` over the opaque `bg`, as the compositor would. */
function composite(fg: { rgb: Rgb; alpha: number }, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(fg.rgb[i]! * fg.alpha + bg[i]! * (1 - fg.alpha))) as Rgb;
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

test.describe('Monaco follows the app theme', () => {
  test('in dark mode the editor paints the app palette, not the built-in light theme', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);
    const diff = page.locator('.monaco-diff-editor').first();
    await expect(diff).toBeVisible(MONACO_MOUNT);

    // The dark base is active (this is the bit that was wrong: without a
    // `theme` prop, @monaco-editor/react applies its `"light"` default).
    await expect(page.locator('.monaco-editor.vs-dark').first()).toBeVisible();
    expect(await monacoVar(page, '--vscode-editor-background')).toBe(
      await appToken(page, '--bg-elevated'),
    );
  });

  test('the diff washes are visible against the dark editor surface', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible(MONACO_MOUNT);

    const surface = parseColour(await monacoVar(page, '--vscode-editor-background')).rgb;
    const inserted = parseColour(
      await monacoVar(page, '--vscode-diffEditor-insertedLineBackground'),
    );
    const removed = parseColour(await monacoVar(page, '--vscode-diffEditor-removedLineBackground'));

    // Both washes are translucent, so what a reader sees is the composite.
    expect(inserted.alpha).toBeLessThan(1);
    expect(removed.alpha).toBeLessThan(1);
    const add = composite(inserted, surface);
    const del = composite(removed, surface);

    // The original complaint: the wash was indistinguishable from the surface.
    expect(contrast(add, surface)).toBeGreaterThan(1.15);
    expect(contrast(del, surface)).toBeGreaterThan(1.15);
    // …and added must not read as removed. Two washes of equal lightness can't
    // be separated by luminance, so this is a hue check (green-vs-red bias).
    const bias = (c: Rgb): number => c[1] - c[0];
    expect(bias(add)).toBeGreaterThan(bias(surface) + 8);
    expect(bias(del)).toBeLessThan(bias(surface) - 8);
  });

  test('the mounted editor re-themes live when the OS colour scheme flips', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);
    const dark = page.locator('.monaco-editor.vs-dark').first();
    await expect(dark).toBeVisible(MONACO_MOUNT);

    // Tag the live DOM node so a remount (which would create a fresh element and
    // drop the marker) can't be mistaken for a re-theme.
    await page
      .locator('.monaco-diff-editor')
      .first()
      .evaluate((el) => el.setAttribute('data-scheme-probe', 'same-node'));

    await page.emulateMedia({ colorScheme: 'light' });

    const same = page.locator('.monaco-diff-editor[data-scheme-probe="same-node"]');
    await expect(same).toHaveCount(1);
    await expect(same.locator('.monaco-editor.vs').first()).toBeVisible();
    expect(await monacoVar(page, '--vscode-editor-background')).toBe(
      await appToken(page, '--bg-elevated'),
    );
  });
});
