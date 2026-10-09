import { test, expect, type Page } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts. Tom, App Updates: "patch show
// CMD + enter (or windows version) on the answer question button, since enter
// is newline".
//
// The Other box is the one field in the app where `↵` inserts a newline instead
// of sending (e2e/question-other-newline.spec.ts pins that mapping). Nothing on
// screen named the key that DOES send, so a long answer was typed into a box
// with no way out but guessing. The button now names the chord.
//
// Proved in a real browser because the claim is about what is painted: the
// chord has to sit on the control, on one line with the label, and stay
// readable in both themes — none of which jsdom applies any CSS for. The
// platform BRANCHING is pinned in src/__tests__/sendChord.test.ts; what is
// added here is that the branch actually taken is the browser's own, and that
// the result is legible.
const HARNESS = '/app/dev-harness.html?chat=chat_question';

const SUBMIT = '[data-testid="question-submit"]';
const CHORD = '[data-testid="question-submit-chord"]';

/** WCAG relative luminance of an opaque `rgb(r, g, b)` string. */
function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) as [
    number,
    number,
    number,
  ];
  const chan = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pretend to be a Mac keyboard, at the only layer the app is allowed to read. */
async function asMacKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    });
  });
}

test.describe('the Send answer button names the chord that sends', () => {
  test('this browser is not a Mac, so it reads Ctrl+Enter', async ({ page }) => {
    // The suite's Chromium runs on Linux, so the un-doctored page is the
    // non-Mac branch taken for real rather than from an injected probe.
    await page.goto(HARNESS);
    const submit = page.locator(SUBMIT);
    await expect(submit).toBeVisible();
    await expect(submit).toContainText('Send answer');
    await expect(page.locator(CHORD)).toHaveText('Ctrl+Enter');
    await expect(submit).not.toContainText('⌘');
  });

  test('a Mac keyboard reads ⌘↵', async ({ page }) => {
    await asMacKeyboard(page);
    await page.goto(HARNESS);
    await expect(page.locator(CHORD)).toHaveText('⌘↵');
    await expect(page.locator(SUBMIT)).not.toContainText('Ctrl');
  });

  test('the chord sits on the button, on the label’s own line', async ({ page }) => {
    await page.goto(HARNESS);
    const boxes = await page.locator(SUBMIT).evaluate((btn) => {
      const chord = btn.querySelector('[data-testid="question-submit-chord"]');
      if (!chord) throw new Error('no chord');
      const b = btn.getBoundingClientRect();
      const c = chord.getBoundingClientRect();
      return {
        btn: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height },
        chord: { top: c.top, bottom: c.bottom, left: c.left, right: c.right, height: c.height },
      };
    });
    // Painted, not collapsed to nothing.
    expect(boxes.chord.height).toBeGreaterThan(6);
    // Inside the control — it is an affordance on the button, not a caption
    // under it, and it must not overflow the control it labels.
    expect(boxes.chord.top).toBeGreaterThanOrEqual(boxes.btn.top - 0.5);
    expect(boxes.chord.bottom).toBeLessThanOrEqual(boxes.btn.bottom + 0.5);
    expect(boxes.chord.right).toBeLessThanOrEqual(boxes.btn.right + 0.5);
    // One line: the button is no taller than a single row of its own text.
    expect(boxes.btn.height).toBeLessThan(40);
    // Set back from the label by being smaller, and it follows it.
    const sizes = await page.locator(SUBMIT).evaluate((btn) => {
      const chord = btn.querySelector('[data-testid="question-submit-chord"]') as HTMLElement;
      return {
        button: parseFloat(getComputedStyle(btn).fontSize),
        chord: parseFloat(getComputedStyle(chord).fontSize),
      };
    });
    expect(sizes.chord).toBeLessThan(sizes.button);
    expect(boxes.chord.left).toBeGreaterThan(boxes.btn.left);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the chord is legible on the button in ${scheme} mode`, async ({ page }) => {
      // `--on-accent` flips from white to near-black between the themes, so a
      // chord given a colour of its own — or faded off the button's fill —
      // reads in one theme and disappears in the other.
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(HARNESS);
      const paint = await page.locator(SUBMIT).evaluate((btn) => {
        const chord = btn.querySelector('[data-testid="question-submit-chord"]') as HTMLElement;
        const cs = getComputedStyle(chord);
        return {
          chord: cs.color,
          opacity: Number(cs.opacity),
          label: getComputedStyle(btn).color,
          fill: getComputedStyle(btn).backgroundColor,
        };
      });
      expect(paint.chord).toBe(paint.label);
      expect(paint.opacity).toBe(1);
      expect(contrast(paint.chord, paint.fill)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('the glyphs stay out of the accessible name', async ({ page }) => {
    await page.goto(HARNESS);
    // Findable as the control it is, with the keys said in words rather than
    // as a mouthful of symbols.
    await expect(page.getByRole('button', { name: 'Send answer, Control-Enter' })).toBeVisible();
    await expect(page.locator(CHORD)).toHaveAttribute('aria-hidden', 'true');
  });

  test('the named chord is the one that actually sends', async ({ page }) => {
    // The button would be lying if the key it advertises did nothing. The
    // harness mounts ChatRoute with ws={null}, so a submit is observable as the
    // one "not connected" toast it pushes.
    await page.goto(HARNESS);
    await page.locator('[data-testid="question-option"][data-label="Web only"]').click();
    await page.getByTestId('question-other').first().click();
    await page.locator('[data-testid="question-other-input"]').click();
    await page.keyboard.type('Temporal');
    await expect(page.locator(CHORD)).toHaveText('Ctrl+Enter');

    await page.keyboard.press('Control+Enter');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const ui = (
            window as unknown as {
              __uiStore: { getState(): { errors: Array<{ message: string }> } };
            }
          ).__uiStore;
          return ui.getState().errors.filter((e) => e.message === 'not connected').length;
        }),
      )
      .toBe(1);
  });
});
