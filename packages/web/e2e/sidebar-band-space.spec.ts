import { test, expect } from '@playwright/test';
import { openReportedState } from './sidebarBand.js';

// spec/14 § Sidebar → Scroll regions: a fixed band claims only the height it
// needs, because every pixel it claims comes out of the chat list.
//
// `.sb` is a flex column, and flex margins NEVER collapse. The sidebar's fixed
// chrome was written in the collapsing idiom anyway — each control carrying
// both a top and a bottom margin — so every adjacent pair was separated by the
// SUM of the two rather than by the one gap the design gives that pair. With
// two drafts and four chats in an 800px window that stacked 10px of gap the
// chrome does not use, straight out of the band that was already 118px short of
// its content.
//
// Only a real browser can answer this: it is measured layout, and jsdom has no
// layout.

/** Every adjacent pair of `.sb` children, with the margins each contributes. */
async function chromeSeams(page: import('@playwright/test').Page): Promise<
  {
    above: string;
    below: string;
    aboveMarginBottom: number;
    belowMarginTop: number;
    gap: number;
  }[]
> {
  return await page.evaluate(() => {
    const sb = document.querySelector('.sb');
    if (sb === null) throw new Error('no .sb');
    const kids = Array.from(sb.children) as HTMLElement[];
    const seams = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const above = kids[i] as HTMLElement;
      const below = kids[i + 1] as HTMLElement;
      seams.push({
        above: above.className.trim(),
        below: below.className.trim(),
        aboveMarginBottom: parseFloat(getComputedStyle(above).marginBottom),
        belowMarginTop: parseFloat(getComputedStyle(below).marginTop),
        gap:
          Math.round(
            (below.getBoundingClientRect().top - above.getBoundingClientRect().bottom) * 2,
          ) / 2,
      });
    }
    return seams;
  });
}

test('no seam in the sidebar chrome pays for two margins', async ({ page }) => {
  await openReportedState(page);
  const seams = await chromeSeams(page);
  // Guard the guard: the sidebar really is a stack of fixed rows around the band.
  expect(seams.length).toBeGreaterThanOrEqual(6);
  const doubled = seams.filter((s) => s.aboveMarginBottom > 0 && s.belowMarginTop > 0);
  expect(
    doubled,
    `these seams stack two margins where the design gives one: ${JSON.stringify(doubled)}`,
  ).toEqual([]);
  // And the gap that is drawn is the single margin, not a sum.
  for (const s of seams) {
    expect(s.gap, `gap at ${s.above} | ${s.below}`).toBe(
      Math.max(s.aboveMarginBottom, s.belowMarginTop),
    );
  }
});

test('the band is taller than the chrome used to leave it', async ({ page }) => {
  await openReportedState(page);
  const band = await page.evaluate(() => {
    const el = document.querySelector('.sb-scroll') as HTMLElement;
    return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
  // Tom's reported state — two drafts and four chats, short enough to
  // overflow (`openReportedState`) — measured a 211px band against 329px of
  // content at the original 800px window. The chrome's stacked margins were
  // 10px of that deficit, and the band takes every pixel the chrome gives back
  // (`flex: 1 1000 auto`, and the chrome is nowhere near its content height).
  expect(band.clientHeight).toBeGreaterThanOrEqual(221);
  // The band still carries the overflow — nothing here moved it onto the aside.
  expect(band.scrollHeight).toBeGreaterThan(band.clientHeight);
});

test('the sidebar still reads as separate controls, not one fused stack', async ({ page }) => {
  await openReportedState(page);
  const seams = await chromeSeams(page);
  // Reclaiming the doubling must not run the controls together. Exactly one
  // seam is allowed to draw no gap at all, and it is the one that already drew
  // none: the lifecycle group meeting the bottom nav, which is separated by
  // that nav's own border rather than by space.
  const fused = seams.filter((s) => s.gap === 0).map((s) => `${s.above} | ${s.below}`);
  expect(fused).toEqual(['sb-lifecycle | sb-bottom']);
});
