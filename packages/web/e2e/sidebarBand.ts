// Shared fixture for the sidebar scroll-band specs (spec/14 § Sidebar → Scroll
// regions). Two spec files use it because only one of them can run with the
// browser's real scrollbars — `test.use({ launchOptions })` forces its own
// worker and Playwright only allows it at file level.
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const HARNESS = '/app/dev-harness.html?chat=chat_bus';

/** The roster from Tom's report: the fixed special threads plus ONE chat. */
export const SHORT_ROSTER = [
  {
    chatId: 'thread_manager',
    daemonId: 'd1',
    permissionMode: 'auto',
    name: 'manager',
    folder: '/home/tom/.patch/threads/manager',
    activity: 'idle',
    status: 'active',
    pinned: true,
    pinnedAt: 50,
    lastUpdated: 3,
  },
  {
    chatId: 'thread_speakers',
    daemonId: 'd1',
    permissionMode: 'auto',
    name: 'speakers',
    folder: '/home/tom/.patch/threads/speakers',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
  },
  {
    chatId: 'chat_bus',
    daemonId: 'd1',
    permissionMode: 'auto',
    name: 'bus-watch',
    folder: '/home/tom/projects/bus',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 4,
  },
];

/** Two saved drafts, as they survive a reload (spec/14 § New chat drafts). */
export async function seedDrafts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'patch.drafts.v1',
      JSON.stringify({
        drafts: {
          draft_a: {
            id: 'draft_a',
            folder: '/home/tom/projects/portfolio',
            text: 'first draft',
            updatedAt: 1,
          },
          draft_b: {
            id: 'draft_b',
            folder: '/home/tom/projects/bus',
            text: 'second draft',
            updatedAt: 2,
          },
        },
        order: ['draft_a', 'draft_b'],
      }),
    );
  });
}

/**
 * Load the harness in Tom's reported state: two drafts + one chat, short
 * enough to overflow the band. 740px, not the original 800px: App Updates'
 * cold-storage icon row (spec/14 § Sidebar item 6) shrank the fixed chrome
 * enough that this same roster no longer overflows at 800 — the band gained
 * back exactly the height five stacked text rows used to cost it. Shrinking
 * the window is truer to the report than padding the roster would be: Tom's
 * bug was "this ordinary amount of content clips silently", not "some
 * specific dataset clips".
 * `hydrate` REPLACES the chat map, so the whole roster goes in one call.
 */
export async function openReportedState(page: Page): Promise<void> {
  await seedDrafts(page);
  await page.setViewportSize({ width: 1280, height: 740 });
  await page.goto(HARNESS);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.evaluate((rows) => {
    (
      window as unknown as { __store: { getState: () => { hydrate: (r: unknown[]) => void } } }
    ).__store
      .getState()
      .hydrate(rows);
  }, SHORT_ROSTER);
  await expect(page.getByTestId('drafts-section')).toBeVisible();
}

export interface BandFit {
  inside: boolean;
  band: { top: number; bottom: number };
  el: { top: number; bottom: number };
}

/** Is every part of `sel` inside the band's own visible box? */
export async function insideBand(page: Page, sel: string): Promise<BandFit> {
  return await page.evaluate((s) => {
    const band = document.querySelector('.sb-scroll');
    const el = document.querySelector(s);
    if (band === null) throw new Error('no .sb-scroll');
    if (el === null) throw new Error(`no element for ${s}`);
    const b = band.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      // 1px of tolerance for sub-pixel rounding at the band's edges.
      inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
      band: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
      el: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
    };
  }, sel);
}
