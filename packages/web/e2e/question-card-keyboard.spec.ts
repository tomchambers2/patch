import { test, expect, type Page } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts. Tom, App Updates: "patch ask a
// question tab should go between questions with arrow keys within the answers".
//
// Proved in a real browser because the whole feature IS the browser's own
// sequential focus navigation: jsdom implements neither Tab nor Enter/Space
// activation on a focused button, so "Tab reaches the NEXT question" and
// "↵ chooses where the cursor is" can only be claimed here. The roving-tabindex
// bookkeeping behind it is pinned in src/__tests__/QuestionCard.keyboard.test.tsx.
//
// The harness card asks two single-select questions — Library (date-fns, Luxon)
// and Scope (Everywhere, Web only) — each with the free-text `Other` after its
// options.
const HARNESS = '/app/dev-harness.html?chat=chat_question';

/** What the cursor is on, named the way the card labels it. */
async function cursor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'none';
    if (el.dataset.testid === 'question-other') return 'Other';
    return el.dataset.label ?? el.dataset.testid ?? el.tagName.toLowerCase();
  });
}

/** The labels of every option currently showing as chosen. */
async function chosen(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.question-option[data-selected="true"]')).map(
      (el) => (el as HTMLElement).dataset.label ?? 'Other',
    ),
  );
}

test.describe('answering a question card from the keyboard', () => {
  test('the card takes the cursor on its first option, ready for the arrows', async ({ page }) => {
    await page.goto(HARNESS);

    await expect.poll(() => cursor(page)).toBe('date-fns');
  });

  test('Tab goes to the NEXT QUESTION, not the next option of this one', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    // One Tab crosses the whole of the first question — its second option and
    // its Other are in the group, not in the Tab sequence.
    await page.keyboard.press('Tab');
    expect(await cursor(page)).toBe('Everywhere');

    // ...and ⇧Tab comes back to the first question.
    await page.keyboard.press('Shift+Tab');
    expect(await cursor(page)).toBe('date-fns');
  });

  test('Tab returns a question to the answer the arrows left it on', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('ArrowDown');
    expect(await cursor(page)).toBe('Luxon');

    await page.keyboard.press('Tab');
    expect(await cursor(page)).toBe('Everywhere');
    await page.keyboard.press('Shift+Tab');
    // Back where the cursor was, not reset to the top of the question.
    expect(await cursor(page)).toBe('Luxon');
  });

  test('Tab carries on out of the questions to the card buttons', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    // Answer both questions so Send answer is live and therefore tabbable.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('question-submit')).toBeEnabled();

    await page.keyboard.press('Tab');
    expect(await cursor(page)).toBe('question-submit');
    await page.keyboard.press('Tab');
    expect(await cursor(page)).toBe('question-cancel');
  });

  test("↑/↓ walk the focused question's answers, Other included, and wrap", async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('ArrowDown');
    expect(await cursor(page)).toBe('Luxon');
    await page.keyboard.press('ArrowDown');
    expect(await cursor(page)).toBe('Other');
    // Off the end, round to the top.
    await page.keyboard.press('ArrowDown');
    expect(await cursor(page)).toBe('date-fns');
    // ...and backwards off the top, round to the bottom.
    await page.keyboard.press('ArrowUp');
    expect(await cursor(page)).toBe('Other');
  });

  test('→/← move within the answers too', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('ArrowRight');
    expect(await cursor(page)).toBe('Luxon');
    await page.keyboard.press('ArrowLeft');
    expect(await cursor(page)).toBe('date-fns');
  });

  test('the arrows stay inside the question the cursor is in', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    // Six presses is two full laps of the first question's three answers — it
    // never crosses into Scope.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowDown');
    expect(await cursor(page)).toBe('date-fns');
  });

  test('moving does not choose — including over Other, which would take the cursor', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');

    expect(await chosen(page)).toEqual([]);
    // The free-text box never opened, so the cursor is still on Other and the
    // next arrow can carry on.
    await expect(page.getByTestId('question-other-input')).toHaveCount(0);
    expect(await cursor(page)).toBe('Other');
    await expect(page.getByTestId('question-submit')).toBeDisabled();
  });

  test('↵ chooses the answer the cursor is on', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    expect(await chosen(page)).toEqual(['Luxon']);
    // Single-select: arrowing back and choosing swaps rather than adds.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await chosen(page)).toEqual(['date-fns']);
  });

  test('Space chooses too, and a whole card is answerable without the mouse', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');

    expect(await chosen(page)).toEqual(['Luxon', 'Web only']);
    await expect(page.getByTestId('question-submit')).toBeEnabled();
  });

  test('choosing Other from the keyboard hands the cursor to its box', async ({ page }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');

    await page.keyboard.press('End');
    expect(await cursor(page)).toBe('Other');
    await page.keyboard.press('Enter');

    const box = page.getByTestId('question-other-input');
    await expect(box).toBeFocused();
    await page.keyboard.type('Temporal');
    await expect(box).toHaveValue('Temporal');
    // The arrows belong to the text now, not to the option list.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('X');
    await expect(box).toHaveValue('TemporaXl');
  });

  test('where the cursor is is drawn, and drawn differently from what is chosen', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect.poll(() => cursor(page)).toBe('date-fns');
    await page.keyboard.press('ArrowDown');

    const ring = await page
      .locator('[data-testid="question-option"][data-label="Luxon"]')
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { width: cs.outlineWidth, style: cs.outlineStyle };
      });
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThan(0);

    // ...and the unfocused, unchosen option next to it has no such ring, so the
    // cursor is what the ring means.
    const none = await page
      .locator('[data-testid="question-option"][data-label="date-fns"]')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(none).toBe('none');
  });
});
