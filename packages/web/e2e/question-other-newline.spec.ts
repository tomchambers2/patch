import { test, expect, type Page } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts. Tom, App Updates: "patch other
// input box, does nothing on enter. should add a new line. shift/cmd enter
// should send it".
//
// The Other box is the DELIBERATE INVERSE of the composer: `↵` and `⇧↵` both
// insert a newline, and only `⌘↵` / `Ctrl↵` sends. Newline insertion is the
// browser's own default on a real textarea, which jsdom fakes — so it is proved
// here, in a real browser, against the real CSS. The wire frame the send
// produces is proved in ChatRoute.askUserQuestion.test.tsx (the harness runs
// with no socket, so a send here can only be observed as the attempt it makes).
const HARNESS = '/app/dev-harness.html?chat=chat_question';

const OTHER = '[data-testid="question-other-input"]';

/**
 * How many times the card has tried to send. The harness mounts ChatRoute with
 * `ws={null}`, so a submit reaches `handlePermission` and stops at its "not
 * connected" guard, which pushes exactly one toast onto the uiStore. That toast
 * is therefore the honest, observable "submit() ran" signal in this harness.
 */
async function sendAttempts(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ui = (
      window as unknown as {
        __uiStore: { getState(): { errors: Array<{ message: string }> } };
      }
    ).__uiStore;
    return ui.getState().errors.filter((e) => e.message === 'not connected').length;
  });
}

/** Answer the second question, so only the key mapping can hold a send back. */
async function completeCard(page: Page): Promise<void> {
  await page.locator('[data-testid="question-option"][data-label="Web only"]').click();
}

/** Turn on the first question's Other box and put a first line in it. */
async function openOther(page: Page): Promise<void> {
  await page.getByTestId('question-other').first().click();
  await expect(page.locator(OTHER)).toBeVisible();
  await page.locator(OTHER).click();
  await page.keyboard.type('Temporal');
}

test.describe('the Other free-text answer takes newlines on Enter', () => {
  test('bare ↵ inserts a newline and does not send', async ({ page }) => {
    await page.goto(HARNESS);
    await completeCard(page);
    await openOther(page);
    // The card IS sendable — the Send answer button is live.
    await expect(page.getByTestId('question-submit')).toBeEnabled();

    await page.keyboard.press('Enter');
    await page.keyboard.type('once it ships');

    await expect(page.locator(OTHER)).toHaveValue('Temporal\nonce it ships');
    expect(await sendAttempts(page)).toBe(0);
  });

  test('⇧↵ inserts a newline and does not send either', async ({ page }) => {
    await page.goto(HARNESS);
    await completeCard(page);
    await openOther(page);

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('once it ships');

    await expect(page.locator(OTHER)).toHaveValue('Temporal\nonce it ships');
    expect(await sendAttempts(page)).toBe(0);
  });

  test('⌘↵ sends, and leaves no newline behind', async ({ page }) => {
    await page.goto(HARNESS);
    await completeCard(page);
    await openOther(page);

    await page.keyboard.press('Meta+Enter');

    await expect.poll(() => sendAttempts(page)).toBe(1);
    await expect(page.locator(OTHER)).toHaveValue('Temporal');
  });

  test('Ctrl↵ sends too', async ({ page }) => {
    await page.goto(HARNESS);
    await completeCard(page);
    await openOther(page);

    await page.keyboard.press('Control+Enter');

    await expect.poll(() => sendAttempts(page)).toBe(1);
    await expect(page.locator(OTHER)).toHaveValue('Temporal');
  });

  test('⌘↵ does nothing while the card is still incomplete', async ({ page }) => {
    await page.goto(HARNESS);
    // Second question deliberately unanswered.
    await openOther(page);
    await expect(page.getByTestId('question-submit')).toBeDisabled();

    await page.keyboard.press('Meta+Enter');

    expect(await sendAttempts(page)).toBe(0);
    // Nor does the blocked shortcut fall through to a stray newline.
    await expect(page.locator(OTHER)).toHaveValue('Temporal');

    // Answer the other question and the very same keystroke goes through.
    await completeCard(page);
    await page.locator(OTHER).click();
    await page.keyboard.press('Meta+Enter');
    await expect.poll(() => sendAttempts(page)).toBe(1);
  });

  test('the box still reads as the one-line field it replaced, and grows', async ({ page }) => {
    await page.goto(HARNESS);
    await openOther(page);

    const box = page.locator(OTHER);
    // A textarea, so a newline is representable at all.
    expect(await box.evaluate((el) => el.tagName)).toBe('TEXTAREA');

    const style = await box.evaluate((el) => {
      const cs = getComputedStyle(el);
      const label = document.querySelector('.question-option-label');
      return {
        font: cs.fontFamily,
        size: cs.fontSize,
        resize: cs.resize,
        cardFont: label ? getComputedStyle(label).fontFamily : '',
      };
    });
    // A textarea's UA default font is monospace and does NOT inherit — the card
    // font is what it must draw in.
    expect(style.font).toBe(style.cardFont);
    expect(style.font.toLowerCase()).not.toContain('monospace');
    // No drag handle: it sizes itself.
    expect(style.resize).toBe('none');

    // One typed line is about one line tall, and roughly what the single-line
    // input it replaced was — not a chunky default multi-row textarea.
    const oneLine = await box.evaluate((el) => el.getBoundingClientRect().height);
    expect(oneLine).toBeLessThan(44);

    // ...and it grows when the answer does, rather than scrolling from line two.
    await page.keyboard.press('Enter');
    await page.keyboard.type('once it ships');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and not before');
    const threeLines = await box.evaluate((el) => el.getBoundingClientRect().height);
    expect(threeLines).toBeGreaterThan(oneLine + 10);
  });
});
