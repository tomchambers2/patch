import { test, expect } from '@playwright/test';

// spec/14 § Status badges — the `background` state.
//
// A backgrounded command or sub-agent outlives the turn that launched it, so
// the chat settles `idle` with work still in flight and the sidebar drew the
// finished tick over it. jsdom proves the derivation and the wiring; this
// proves the row really paints a STATIC glyph with the real CSS, in the slot
// the tick used to occupy. It used to spin — deliberately reverted (Tom: a
// spin is the strongest "happening right now" signal there is, which belongs
// to `working` alone; a quiet background job competing for that same
// attention was the opposite of what a calm, ignorable-until-it-matters
// status needs).
//
// `chat_bgtask` is the harness chat that has two background tasks running — the
// same two its Background task bar lists, so the sidebar row and the bar are
// checked against each other in one page.
const HARNESS = '/app/dev-harness.html?chat=chat_bgtask';

test.describe('sidebar background-job badge', () => {
  test('the row shows a static glyph where the tick was, and the bar agrees', async ({ page }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bgtask');
    await expect(row).toBeVisible();

    const badge = row.getByTestId('badge-background');
    await expect(badge).toBeVisible();
    // The states it replaces are gone from this row — that is the whole ask.
    await expect(row.getByTestId('badge-read')).toHaveCount(0);
    await expect(row.getByTestId('badge-done')).toHaveCount(0);

    // Named for a reader who cannot see the glyph.
    await expect(badge).toHaveAttribute('title', 'Background job running');
    await expect(badge).toHaveAttribute('aria-label', 'background job running');
    // A drawn glyph, not a dot.
    await expect(badge.locator('svg')).toHaveCount(1);

    // The open chat's own bar counts the same work, so the two readouts cannot
    // be telling the reader different things.
    await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');

    // A chat with nothing running is unaffected: still the tick's own slot,
    // still the badge it always drew.
    const other = page.getByTestId('chat-row-chat_md');
    await expect(other.getByTestId('badge-background')).toHaveCount(0);
  });

  test('it sits still — no animation at all, unlike `working`', async ({ page }) => {
    await page.goto(HARNESS);
    const badge = page.getByTestId('chat-row-chat_bgtask').getByTestId('badge-background');
    expect(await badge.locator('svg').evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'none',
    );

    const at = async (): Promise<string> =>
      badge.locator('svg').evaluate((el) => getComputedStyle(el).transform);
    const before = await at();
    await page.waitForTimeout(200);
    expect(await at()).toBe(before);
  });

  test('it draws in the badge track, without pushing the row title out of place', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const badge = page.getByTestId('chat-row-chat_bgtask').getByTestId('badge-background');
    const tick = page.getByTestId('chat-row-chat_md').getByTestId('badge-done');
    const bgBox = (await badge.boundingBox())!;
    const tickBox = (await tick.boundingBox())!;
    // spec/14: "Every state draws at the same footprint" — a badge that grows
    // its own box shoves the row title across and stops reading as a marker.
    expect(Math.abs(bgBox.x - tickBox.x)).toBeLessThanOrEqual(2);
    // The row reserves an 18px badge track; a badge that outgrows it shoves the
    // name across.
    expect(bgBox.width).toBeLessThanOrEqual(18);
    expect(bgBox.height).toBeLessThanOrEqual(18);

    const bgTitle = (await page
      .getByTestId('chat-row-chat_bgtask')
      .locator('.name')
      .boundingBox())!;
    const otherTitle = (await page.getByTestId('chat-row-chat_md').locator('.name').boundingBox())!;
    expect(Math.abs(bgTitle.x - otherTitle.x)).toBeLessThanOrEqual(1);
  });
});
