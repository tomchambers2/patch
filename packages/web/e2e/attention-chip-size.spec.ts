import { test, expect } from '@playwright/test';

// Todoist: "patch needs attention box is huge, too big". The control is a
// two-word filter, but it was drawn as a full-bleed bordered panel — the same
// footprint as the whole Chats/Batch strip below it — so it read as a big empty
// box at the top of the sidebar. spec/14 § Chat lifecycle → Needs attention
// toggle makes it a chip sized to its own label, and § One column exempts it
// from the shared right edge for exactly that reason.
//
// Only a real browser can measure this: jsdom has no layout and applies no
// stylesheet.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

/** The accent tokens, read from the live stylesheet rather than hard-coded. */
async function accents(page: import('@playwright/test').Page): Promise<{
  accent: string;
  tint: string;
  strong: string;
}> {
  return page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    /** Resolve a token to the same rgb() form getComputedStyle reports. */
    const rgb = (token: string): string => {
      probe.style.color = s.getPropertyValue(token).trim();
      return getComputedStyle(probe).color;
    };
    const out = {
      accent: rgb('--accent'),
      tint: rgb('--accent-tint'),
      strong: rgb('--accent-strong'),
    };
    probe.remove();
    return out;
  });
}

test.describe('needs-attention chip size', () => {
  test('the chip is sized by its label, not by the sidebar', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();

    const chip = (await page.getByTestId('attention-toggle').boundingBox())!;
    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    const tabs = (await page.getByTestId('batch-tabs').boundingBox())!;

    // It used to be 253px of a 280px sidebar. A chip takes what its two words
    // need and leaves the rest of the row empty.
    expect(chip.width).toBeLessThan(sidebar.width * 0.6);
    // …and it is not the full-width strip's twin any more, on either axis.
    expect(tabs.width - chip.width).toBeGreaterThan(60);
    expect(chip.height).toBeLessThan(tabs.height - 6);
    // 39px before; a chip, not a panel.
    expect(chip.height).toBeLessThanOrEqual(28);

    // Sized by its content, not by its container: widening the sidebar widens
    // the rows and leaves the chip alone. `.sb` is a flex column whose default
    // `align-items: stretch` made the chip full-bleed even with `width: auto`,
    // so this is the assertion that catches a regression back to that.
    const widened = await page.evaluate(() => {
      const sb = document.querySelector('.sb') as HTMLElement;
      sb.style.width = '460px';
      const chipW = (
        document.querySelector('.attention-toggle') as HTMLElement
      ).getBoundingClientRect().width;
      const rowW = (document.querySelector('.sb-row') as HTMLElement).getBoundingClientRect().width;
      return { chipW, rowW };
    });
    expect(widened.chipW).toBeCloseTo(chip.width, 0);
    // Guard the guard: the sidebar really did get wider.
    expect(widened.rowW).toBeGreaterThan(sidebar.width * 1.3);
  });

  test('the chip keeps the sidebar column left edge and a pill radius', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();

    const chip = (await page.getByTestId('attention-toggle').boundingBox())!;
    const row = (await page.locator('.sb-row').first().boundingBox())!;
    // spec/14 § One column: it leaves the shared RIGHT edge, not the left one.
    expect(Math.abs(chip.x - row.x)).toBeLessThanOrEqual(1);
    expect(chip.x + chip.width).toBeLessThan(row.x + row.width - 40);

    const radius = await page
      .getByTestId('attention-toggle')
      .evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius).toBeGreaterThanOrEqual(chip.height / 2);
  });

  test('the active (filtered) state is still obviously accent-filled', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();

    const toggle = page.getByTestId('attention-toggle');
    const paint = async (): Promise<{ bg: string; border: string; color: string; icon: string }> =>
      toggle.evaluate((el) => {
        const s = getComputedStyle(el);
        const icon = el.querySelector('.attention-icon');
        return {
          bg: s.backgroundColor,
          border: s.borderTopColor,
          color: s.color,
          icon: icon === null ? '' : getComputedStyle(icon).stroke,
        };
      });

    const off = await paint();
    // Off: a quiet outline, no fill.
    expect(off.bg).toBe('rgba(0, 0, 0, 0)');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const on = await paint();

    const { accent, tint, strong } = await accents(page);
    expect(on.bg).toBe(tint);
    expect(on.border).toBe(accent);
    expect(on.color).toBe(strong);
    expect(on.icon).toBe(strong);
    expect(on.bg).not.toBe(off.bg);
  });
});
