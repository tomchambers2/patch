import { test, expect } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts. Tom, App Updates: "when
// answering a qusetion, clicking other must focus input".
//
// Choosing `Other` reveals the free-text box, and the click that reveals it is
// the click that starts typing in it. Proved in a real browser because the
// competition is real: Chrome focuses the `Other` button itself on mousedown,
// so "the box ends up focused" is a claim about which focus wins, which jsdom
// cannot settle. The state machine behind it (which question's box, toggling
// off, a card resolving) is pinned in ChatRoute.askUserQuestion.test.tsx.
const HARNESS = '/app/dev-harness.html?chat=chat_question';

const OTHER = '[data-testid="question-other-input"]';

test.describe('choosing Other puts the cursor in the box', () => {
  test('one click focuses the box — a second click is not needed to type', async ({ page }) => {
    await page.goto(HARNESS);

    await page.getByTestId('question-other').first().click();

    const box = page.locator(OTHER);
    await expect(box).toBeFocused();
    // ...and the proof that matters: typing with no further clicking lands in
    // the box rather than nowhere.
    await page.keyboard.type('Temporal');
    await expect(box).toHaveValue('Temporal');
  });

  test("focuses the clicked question's own box, not the first one on screen", async ({ page }) => {
    await page.goto(HARNESS);

    // The harness card asks two questions; open the FIRST question's box, then
    // the second's. The second click must move the cursor, not leave it behind.
    await page.getByTestId('question-other').first().click();
    await page.keyboard.type('Temporal');
    await page.getByTestId('question-other').nth(1).click();
    await page.keyboard.type('Web only, for now');

    const boxes = page.locator(OTHER);
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).toHaveValue('Temporal');
    await expect(boxes.nth(1)).toHaveValue('Web only, for now');
    await expect(boxes.nth(1)).toBeFocused();
  });

  test('turning Other off takes the box away; turning it on again re-takes the cursor', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const other = page.getByTestId('question-other').first();

    await other.click();
    await expect(page.locator(OTHER)).toBeFocused();

    await other.click();
    await expect(page.locator(OTHER)).toHaveCount(0);

    await other.click();
    await expect(page.locator(OTHER)).toBeFocused();
    await page.keyboard.type('Temporal');
    await expect(page.locator(OTHER)).toHaveValue('Temporal');
  });
});
