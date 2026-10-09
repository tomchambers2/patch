import { test, expect, type Page } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts / § Permission prompts.
//
// Tom, Patch Updates: "the ask a question background is garish. just structure
// it with outlines instaed of horrible orange". The question card carried no
// background of its own, so it inherited `.permission`'s edge-to-edge
// `--waiting-tint` fill and became a solid orange slab — and every outlined
// control nested in it (the option rows, the Other box) read as garish because
// it was sitting ON the orange.
//
// The two cards must now be told apart by treatment, not just by content: the
// APPROVAL card keeps the fill (an approval halts the turn, and it is the one
// transcript state that gets colour), and the QUESTION card is an outlined
// panel. Only a real browser can settle that — the claim is about painted
// pixels from the real cascade, which jsdom applies none of.
//
// Asserted against the palette tokens read off `:root` at runtime rather than
// hardcoded hexes, so the relationship ("not the waiting fill", "outlined in
// the waiting hue") is what is pinned and a future palette re-tune cannot make
// this spec pass while the card looks wrong. Both themes, because
// `--waiting-tint` is a pale amber in light and a near-black brown in dark:
// a fix that reads right in one can be invisible in the other.
const HARNESS = '/app/dev-harness.html?chat=chat_question_styles';

// The unreadable-question card carries the same testid and no `data-resolved`
// either, so "pending" has to exclude it explicitly.
const PENDING_QUESTION =
  '[data-testid="question-card"]:not([data-resolved]):not(.question-card-broken)';
const ANSWERED_QUESTION = '[data-testid="question-card"][data-resolved]';
const BROKEN_QUESTION = '.question-card-broken';
const PENDING_APPROVAL = '[data-testid="permission"]:not([data-resolved])';

/**
 * A palette token, normalised into the same `rgb(r, g, b)` form
 * `getComputedStyle` reports a painted colour in — by asking the browser to
 * resolve it as a real colour rather than string-matching a hex.
 */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, name);
}

async function bg(page: Page, sel: string): Promise<string> {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function borderOf(page: Page, sel: string): Promise<{ color: string; width: string }> {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.borderTopColor, width: s.borderTopWidth };
    });
}

/** The assertions that must hold identically in light and in dark. */
async function assertOutlinedNotFilled(page: Page): Promise<void> {
  const waitingTint = await token(page, '--waiting-tint');
  const waiting = await token(page, '--waiting');

  // 1. The approval card still IS the amber fill. This is the guard on the
  //    fix's scope: `.permission` is shared, and washing the orange out of it
  //    would have taken the approval card's deliberate colour with it.
  await expect(page.locator(PENDING_APPROVAL).first()).toBeVisible();
  // (Superseded: Tom called the slab "ugly" — the approval card is now an
  // outlined panel too, see permission-card-style.spec.ts. It must still
  // keep the waiting hue as its border.)
  expect((await borderOf(page, PENDING_APPROVAL)).color).toBe(waiting);

  // 2. The question card is NOT.
  await expect(page.locator(PENDING_QUESTION).first()).toBeVisible();
  const cardBg = await bg(page, PENDING_QUESTION);
  expect(cardBg).not.toBe(waitingTint);

  // 3. It is defined by an outline instead — a real border, in the waiting
  //    hue, so the amber survives as structure rather than as a slab.
  const cardBorder = await borderOf(page, PENDING_QUESTION);
  expect(cardBorder.width).not.toBe('0px');
  expect(cardBorder.color).toBe(waiting);

  // 4. The amber has not simply been deleted — it survives as the accent
  //    detail the outline leaves room for, on the chip that labels the
  //    question. Losing it entirely would make a question indistinguishable
  //    from any other quiet panel in the transcript.
  const chip = page.locator('.question-header').first();
  expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(waitingTint);
  expect(await chip.evaluate((el) => getComputedStyle(el).color)).toBe(waiting);

  // 5. The option rows still read as their own controls against it. With the
  //    card no longer orange, rows painted the same surface as the card would
  //    dissolve into it — the exact way this fix could go wrong.
  const optionBg = await bg(page, '.question-option');
  expect(optionBg).not.toBe(cardBg);
  const optionBorder = await borderOf(page, '.question-option');
  expect(optionBorder.width).not.toBe('0px');

  // 6. ...and a picked row is unmistakable: the accent ring, not a tint that
  //    happens to differ by a shade.
  const accent = await token(page, '--accent');
  await page.locator('.question-option').first().click();
  const picked = page.locator('.question-option.selected').first();
  await expect(picked).toBeVisible();
  const pickedBorder = await borderOf(page, '.question-option.selected');
  expect(pickedBorder.color).toBe(accent);
  expect(await picked.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');

  // 7. An answered card is still visibly answered. `.permission.resolved`
  //    signalled that by swapping the amber fill for the panel — with the
  //    pending card already on the panel, that alone would have made the two
  //    identical.
  const answeredBorder = await borderOf(page, ANSWERED_QUESTION);
  expect(answeredBorder.color).not.toBe(cardBorder.color);
  const answeredOpacity = await page
    .locator(ANSWERED_QUESTION)
    .first()
    .evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(answeredOpacity)).toBeLessThan(1);

  // 8. A question the app could not read is outlined as the problem it is,
  //    rather than inheriting the pending card's amber or the old fill.
  const danger = await token(page, '--danger');
  await expect(page.locator(BROKEN_QUESTION)).toBeVisible();
  expect((await borderOf(page, BROKEN_QUESTION)).color).toBe(danger);
  expect(await bg(page, BROKEN_QUESTION)).not.toBe(waitingTint);
}

test.describe('the question card is outlined, not filled with the waiting amber', () => {
  test('light mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HARNESS);
    await assertOutlinedNotFilled(page);
  });

  test('dark mode', async ({ page }) => {
    // `prefers-color-scheme`, not `data-theme`: the harness sets no explicit
    // theme, so this exercises the media-query copy of the dark palette — the
    // one that paints on first load, and the copy most easily left behind when
    // the two dark blocks drift.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);
    await assertOutlinedNotFilled(page);
  });

  test('the Other box is not a white slab on the dark card', async ({ page }) => {
    // It was hardcoded `#fff` behind an undefined `var(--bg-input)`, so in dark
    // mode the one free-text field on this card painted white — the same
    // garishness in the other direction (spec/14 § Theming: no component
    // hardcodes a colour).
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);

    await page.getByTestId('question-other').first().click();
    const box = page.getByTestId('question-other-input');
    await expect(box).toBeVisible();
    const boxBg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(boxBg).not.toBe('rgb(255, 255, 255)');
    // And it belongs to the same surface family as the option rows it sits with.
    expect(boxBg).toBe(await bg(page, '.question-option'));
  });
});
