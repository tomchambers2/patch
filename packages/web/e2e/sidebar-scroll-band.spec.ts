import { test, expect } from '@playwright/test';
import { insideBand, openReportedState } from './sidebarBand.js';

// spec/14 § Sidebar → Scroll regions. The band that carries the sidebar's
// overflow used to clip it silently: with two drafts and one chat in an 800px
// window the band measured 211px against 329px of content, and nothing said so.
// Expanding "Channels (1)" then rendered Speakers below that
// invisible fold, so the section read as empty; a freshly saved draft vanished
// the same way whenever the band had been scrolled off its top.
//
// Only a real browser can prove this: it is measured geometry — what actually
// sits inside the band's box — and jsdom has no layout. (The other half of the
// fix, the painted scrollbar, is in sidebar-scroll-cue.spec.ts.)

test.describe('sidebar scroll band', () => {
  test('two drafts and one chat already overflow the band', async ({ page }) => {
    await openReportedState(page);
    const band = await page.evaluate(() => {
      const el = document.querySelector('.sb-scroll') as HTMLElement;
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
      };
    });
    // This is not a "hundreds of chats" edge case — the smallest realistic
    // sidebar already hides content, which is why the cue matters.
    expect(band.scrollHeight).toBeGreaterThan(band.clientHeight);
    expect(band.overflowY).toBe('auto');
  });

  test('expanding Channels brings its rows into view', async ({ page }) => {
    await openReportedState(page);

    // Collapsed and below the fold — the state a reload lands in.
    await expect(page.getByTestId('channels-count')).toHaveText('1');

    await page.getByTestId('channels-toggle').click();
    await expect(page.getByTestId('channels-list')).toBeAttached();

    // Measured, not merely "attached": before the fix the list rendered at
    // y=508..582 in a band that ended at y=510, so expanding showed nothing.
    const list = await insideBand(page, '[data-testid="channels-list"]');
    expect(
      list.inside,
      `channels list ${JSON.stringify(list.el)} must sit inside the band ${JSON.stringify(list.band)}`,
    ).toBe(true);
    // The header the user just clicked stays with its rows.
    const head = await insideBand(page, '[data-testid="channels-toggle"]');
    expect(head.inside).toBe(true);

    // And the channel row is genuinely clickable where it is drawn — the
    // band clips its overflow, so a clipped row still reports a box.
    for (const id of ['thread_speakers']) {
      const hit = await page.evaluate((chatId) => {
        const el = document.querySelector(`[data-testid="channel-row-${chatId}"]`);
        if (el === null) throw new Error(`no channel row for ${chatId}`);
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at !== null && el.contains(at);
      }, id);
      expect(hit, `${id} must be clickable`).toBe(true);
    }
  });

  test('a draft saved while the band is scrolled away is brought into view', async ({ page }) => {
    await openReportedState(page);
    // Put the band where opening Channels leaves it: scrolled off its top, so
    // the Drafts section is above the fold.
    await page.getByTestId('channels-toggle').click();
    await expect(page.getByTestId('channels-list')).toBeAttached();
    expect(
      await page.evaluate(() => (document.querySelector('.sb-scroll') as HTMLElement).scrollTop),
    ).toBeGreaterThan(0);

    // Save a third draft, exactly as the composer does.
    const newId = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __draftStore: {
            getState: () => {
              create: (folder?: string) => string;
              update: (id: string, patch: { text: string }) => void;
            };
          };
        }
      ).__draftStore;
      const id = store.getState().create('/home/tom/projects/portfolio');
      store.getState().update(id, { text: 'third draft' });
      return id;
    });
    await expect(page.getByTestId(`draft-row-${newId}`)).toBeVisible();

    // Three drafts are taller than the band, so what must be in view is the
    // row that just appeared and the header that says what it is — not the
    // whole section.
    const row = await insideBand(page, `[data-testid="draft-row-${newId}"]`);
    expect(
      row.inside,
      `the new draft row ${JSON.stringify(row.el)} must sit inside the band ${JSON.stringify(row.band)}`,
    ).toBe(true);
    // The new draft leads the list (draftStore.create prepends), so the header
    // that says what it is comes with it.
    const head = await insideBand(page, '[data-testid="drafts-section"] .folder-head');
    expect(
      head.inside,
      `the Drafts header ${JSON.stringify(head.el)} must sit inside the band ${JSON.stringify(head.band)}`,
    ).toBe(true);
  });

  test('after a reload nothing in the band is stranded out of reach', async ({ page }) => {
    await openReportedState(page);
    // A reload collapses Channels again and puts the band back at its top, with
    // the Channels header below the fold. It has to be reachable BY SCROLLING —
    // the band, not the aside, is what moves.
    const before = await insideBand(page, '[data-testid="channels-toggle"]');
    expect(before.inside).toBe(false);

    await page.evaluate(() => {
      const el = document.querySelector('.sb-scroll') as HTMLElement;
      el.scrollTop = el.scrollHeight;
    });
    const after = await insideBand(page, '[data-testid="channels-toggle"]');
    expect(after.inside).toBe(true);
    // The fixed chrome did not move while the band scrolled.
    await expect(page.getByTestId('bottom-nav')).toBeVisible();
    await expect(page.getByTestId('new-chat-fab')).toBeVisible();
  });
});
