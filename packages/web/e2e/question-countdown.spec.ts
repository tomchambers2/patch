import { test, expect, type Page, type Locator } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts: the countdown ring.
//
// Tom, App Updates: "patch should show a 1 minute timer on a question, slowly
// going down, a circle pie chart thing. so the user knows when it expires."
//
// Proved in a real browser because the thing asked for is a DRAWN shape that
// moves: jsdom has no stylesheet cascade and no layout, so "the ring is 24px in
// the card's corner" and "the arc is visibly shorter a second later" cannot be
// claimed there. The arithmetic behind it is pinned in
// src/__tests__/QuestionCard.countdown.test.tsx and the rules in
// src/__tests__/questionExpirySettingStyles.test.ts.
//
// `chat_question_timer` seeds two pending questions: one with a minute on it
// and one with three seconds. `chat_question` seeds a question with no deadline
// at all, which is the shape a host with expiry turned off produces.
const TIMER = '/app/dev-harness.html?chat=chat_question_timer';
const NO_DEADLINE = '/app/dev-harness.html?chat=chat_question';

/** The ring on the card whose question reads `text`. */
function ringFor(page: Page, text: string): Locator {
  return page
    .locator('[data-testid="question-card"]')
    .filter({ hasText: text })
    .getByTestId('question-countdown');
}

/** How much of the arc is still drawn, 1 = full ring, 0 = empty. */
async function remainingFraction(ring: Locator): Promise<number> {
  return ring.evaluate((el) => {
    const fill = el.querySelector('.question-countdown-fill');
    if (!fill) throw new Error('the ring drew no depleting arc');
    const total = Number(fill.getAttribute('stroke-dasharray'));
    const offset = Number(fill.getAttribute('stroke-dashoffset'));
    if (!(total > 0)) throw new Error(`unusable stroke-dasharray: ${total}`);
    return 1 - offset / total;
  });
}

async function secondsLeft(ring: Locator): Promise<number> {
  return Number(await ring.getAttribute('data-seconds-left'));
}

test.describe('the question countdown ring', () => {
  test('is drawn as a real ring in the card corner, not a collapsed nothing', async ({ page }) => {
    await page.goto(TIMER);
    const ring = ringFor(page, 'Which date library');
    await expect(ring).toBeVisible();

    const card = page
      .locator('[data-testid="question-card"]')
      .filter({ hasText: 'Which date library' });
    const geometry = await ring.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const svg = el.querySelector('svg');
      const arc = el.querySelector('.question-countdown-fill');
      if (!svg || !arc) throw new Error('the ring has no svg');
      const arcBox = (arc as SVGGraphicsElement).getBoundingClientRect();
      const cs = getComputedStyle(arc);
      return {
        width: box.width,
        height: box.height,
        right: box.right,
        top: box.top,
        arcWidth: arcBox.width,
        arcHeight: arcBox.height,
        stroke: cs.stroke,
      };
    });
    // A box with actual size — the invisible-control failure mode.
    expect(geometry.width).toBeGreaterThanOrEqual(16);
    expect(geometry.height).toBeGreaterThanOrEqual(16);
    // Round, not a line: the arc's own box is as tall as it is wide.
    expect(Math.abs(geometry.arcWidth - geometry.arcHeight)).toBeLessThanOrEqual(2);
    // …and painted in something, not transparent.
    expect(geometry.stroke).not.toBe('none');
    expect(geometry.stroke).not.toBe('rgba(0, 0, 0, 0)');

    // In the card's top corner, inside it.
    const cardBox = await card.boundingBox();
    if (!cardBox) throw new Error('the question card has no box');
    expect(geometry.right).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(geometry.right).toBeGreaterThan(cardBox.x + cardBox.width - 60);
    expect(geometry.top).toBeGreaterThanOrEqual(cardBox.y);
    expect(geometry.top).toBeLessThan(cardBox.y + 60);
  });

  test('opens near a full minute and visibly depletes as it runs down', async ({ page }) => {
    await page.goto(TIMER);
    const ring = ringFor(page, 'Which date library');
    await expect(ring).toBeVisible();

    // The fixture's deadline is a minute from page load, so allow for the
    // second or so the load itself takes.
    const opened = await secondsLeft(ring);
    expect(opened).toBeGreaterThan(55);
    expect(opened).toBeLessThanOrEqual(60);
    expect(await remainingFraction(ring)).toBeGreaterThan(0.9);

    // Slowly going down — the arc is measurably shorter, not merely relabelled.
    const before = await remainingFraction(ring);
    await expect.poll(() => secondsLeft(ring), { timeout: 5_000 }).toBeLessThan(opened - 1);
    expect(await remainingFraction(ring)).toBeLessThan(before);
  });

  test('names the time left for a screen reader, then names it as expired', async ({ page }) => {
    await page.goto(TIMER);
    const short = ringFor(page, 'Ship it now?');
    await expect(short).toHaveAttribute('aria-label', /\d+ seconds? left to answer/);

    // The three-second card runs out while we watch.
    await expect(short).toHaveAttribute('data-expired', 'true', { timeout: 10_000 });
    await expect(short).toHaveAttribute('aria-label', 'question expired');
    expect(await remainingFraction(short)).toBeLessThan(0.02);

    // The minute-long card beside it is untouched — one card's deadline is not
    // the transcript's.
    await expect(ringFor(page, 'Which date library')).toHaveAttribute('data-expired', 'false');
  });

  test('a run-out card is NOT resolved by the surface — the host owns that', async ({ page }) => {
    await page.goto(TIMER);
    const card = page.locator('[data-testid="question-card"]').filter({ hasText: 'Ship it now?' });
    await expect(card.getByTestId('question-countdown')).toHaveAttribute('data-expired', 'true', {
      timeout: 10_000,
    });
    // No invented outcome, and the options still take a click: the resolution
    // arrives over the wire or not at all.
    await expect(card.getByTestId('permission-outcome')).toHaveCount(0);
    await expect(card).not.toHaveAttribute('data-resolved', /.+/);
    await expect(card.getByTestId('question-option').first()).toBeEnabled();
  });

  test('is absent entirely on a question with no deadline', async ({ page }) => {
    await page.goto(NO_DEADLINE);
    await expect(page.getByTestId('question-card').first()).toBeVisible();
    await expect(page.getByTestId('question-countdown')).toHaveCount(0);
  });

  test('does not intercept a click aimed at the card behind it', async ({ page }) => {
    await page.goto(TIMER);
    const card = page
      .locator('[data-testid="question-card"]')
      .filter({ hasText: 'Which date library' });
    // The ring overlaps the card's top-right corner; the element the browser
    // hands that point to must not be the ring.
    const ring = card.getByTestId('question-countdown');
    const box = await ring.boundingBox();
    if (!box) throw new Error('the ring has no box');
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
        return el?.closest('.question-countdown') === null || el === null;
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit, 'the ring swallowed a point over the card').toBe(true);
  });

  test('leaves the card answerable from the keyboard exactly as before', async ({ page }) => {
    // The ring sits outside `.question-options` and carries no tabindex, so the
    // roving-tabindex journey is untouched: the cursor still lands on the first
    // option, and ↓ still steps to the next one.
    await page.goto(TIMER);
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.label))
      .toBe('Ship');
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.label))
      .toBe('Hold');
  });
});
