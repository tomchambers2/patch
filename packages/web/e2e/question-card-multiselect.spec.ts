import { test, expect, type Locator, type Page } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts.
//
// Tom, App Updates: "patch multi select for questions is not clear". A
// `multiSelect: true` question was drawn EXACTLY like a single-select one —
// the same outlined rows, the same accent ring when picked — with the whole
// difference living in `role` (checkbox vs radio) and in what a second click
// did. A screen reader was told; a sighted user was not, so Tom picked one
// option and moved on from a question that wanted several.
//
// Each option now carries a real selection indicator: a square with a tick
// where several answers are allowed, a circle with a filled dot where one is.
// That is a claim about painted pixels from the real cascade, so it can only be
// settled in a browser — jsdom applies none of it. Both themes, because the
// mark is drawn in `--bg-elevated` on `--accent` and those swap places between
// them: a shape that reads in light can vanish in dark.
const HARNESS = '/app/dev-harness.html?chat=chat_question_styles';

const SINGLE_Q = 'Which date library should we use?';
const MULTI_Q = 'Which features do you want enabled?';

/** A palette token, resolved by the browser into the `rgb(...)` form
    `getComputedStyle` reports a painted colour in — so a palette re-tune cannot
    leave this spec passing while the card looks wrong. */
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

/** One question's answer rows (its options, then `Other`), on the pending card. */
function rows(page: Page, question: string): Locator {
  return page.locator(`.question-options[aria-label="${question}"] button.question-option`);
}

type Mark = {
  radius: string;
  width: number;
  height: number;
  borderColor: string;
  background: string;
  /* The ::after that draws the tick or the dot — absent until the row is
     picked, which is what makes "drawn at all" the test for selected. */
  drawn: boolean;
  markBackground: string;
  markBorderColor: string;
  markRadius: string;
  markRotated: boolean;
};

async function markOf(row: Locator): Promise<Mark> {
  return row.evaluate((el) => {
    const mark = el.querySelector('.question-indicator');
    if (!mark) throw new Error('option row has no selection indicator');
    const s = getComputedStyle(mark);
    const after = getComputedStyle(mark, '::after');
    const box = mark.getBoundingClientRect();
    return {
      radius: s.borderTopLeftRadius,
      width: box.width,
      height: box.height,
      borderColor: s.borderTopColor,
      background: s.backgroundColor,
      drawn: after.content !== 'none',
      // A dot paints as a background; a tick paints as two borders of an empty
      // box. Both are reported so each mode is checked on its own technique.
      markBackground: after.backgroundColor,
      markBorderColor: after.borderBottomColor,
      markRadius: after.borderTopLeftRadius,
      markRotated: after.transform !== 'none' && after.transform !== '',
    };
  });
}

async function assertModesAreTold(page: Page): Promise<void> {
  const accent = await token(page, '--accent');
  const ink3 = await token(page, '--ink-3');
  const elevated = await token(page, '--bg-elevated');

  const single = rows(page, SINGLE_Q);
  const multi = rows(page, MULTI_Q);
  // Two options plus `Other` in each — `Other` is one of the options and must
  // not be the one row left looking like the old undifferentiated button.
  await expect(single).toHaveCount(3);
  await expect(multi).toHaveCount(3);

  // 1. Every row of both questions actually paints an indicator, at a size a
  //    person can see. A mark with no box is a mark nobody reads.
  for (const list of [single, multi]) {
    for (let i = 0; i < 3; i++) {
      const m = await markOf(list.nth(i));
      expect(m.width).toBeGreaterThanOrEqual(12);
      expect(m.height).toBeGreaterThanOrEqual(12);
      expect(m.borderColor).toBe(ink3);
    }
  }

  // 2. The distinction itself: the single-select mark is a CIRCLE and the
  //    multi-select mark is not. This is the whole bug — the two modes used to
  //    be pixel-identical.
  const singleIdle = await markOf(single.first());
  const multiIdle = await markOf(multi.first());
  // `getComputedStyle` hands a percentage radius back as a percentage, so the
  // two modes are compared as resolved geometry rather than as CSS strings.
  const radiusPx = (m: Mark): number =>
    m.radius.endsWith('%')
      ? (Number.parseFloat(m.radius) / 100) * m.width
      : Number.parseFloat(m.radius);
  expect(radiusPx(singleIdle)).toBe(singleIdle.width / 2); // a circle
  expect(radiusPx(multiIdle)).toBeLessThan(multiIdle.width / 4); // a square, corners softened
  expect(multiIdle.radius).not.toBe(singleIdle.radius);

  // 3. It is a leading indicator in a real row, not a shape laid over the
  //    label: the mark's box ends before the text column begins.
  const geometry = await multi.first().evaluate((el) => {
    const mark = el.querySelector('.question-indicator')!.getBoundingClientRect();
    const body = el.querySelector('.question-option-body')!.getBoundingClientRect();
    return { markRight: mark.right, bodyLeft: body.left };
  });
  expect(geometry.markRight).toBeLessThanOrEqual(geometry.bodyLeft);

  // 4. Picking a multi-select row fills the BOX in the accent and knocks a
  //    tick out of it — two borders of an empty box rotated onto their corner,
  //    painted in the option surface so it inverts with the theme rather than
  //    being a hardcoded white that disappears one way round.
  await multi.first().click();
  await expect(multi.first()).toHaveClass(/selected/);
  const ticked = await markOf(multi.first());
  expect(ticked.borderColor).toBe(accent);
  expect(ticked.background).toBe(accent);
  expect(ticked.drawn).toBe(true);
  expect(ticked.markRotated).toBe(true);
  expect(ticked.markBorderColor).toBe(elevated);

  // 5. Picking a single-select row does the OTHER familiar thing: the circle
  //    stays hollow and gains a filled dot. Each mode keeps the form its
  //    control has everywhere else, which is what carries the message.
  await single.first().click();
  const dotted = await markOf(single.first());
  expect(dotted.borderColor).toBe(accent);
  expect(dotted.background).not.toBe(accent);
  expect(dotted.drawn).toBe(true);
  expect(dotted.markRotated).toBe(false);
  expect(dotted.markBackground).toBe(accent);
  expect(Number.parseFloat(dotted.markRadius)).toBeGreaterThan(0);

  // 6. Multi-select accumulates, and every pick is legible as a filled mark —
  //    the point of the whole change is that a second answer is discoverable.
  await multi.nth(1).click();
  expect((await markOf(multi.first())).drawn).toBe(true);
  expect((await markOf(multi.nth(1))).drawn).toBe(true);
  // Single-select still moves the one mark instead of adding a second.
  await single.nth(1).click();
  expect((await markOf(single.first())).drawn).toBe(false);
  expect((await markOf(single.nth(1))).drawn).toBe(true);

  // 7. Deselecting empties it again, so the indicator is the selection state
  //    rather than a badge that only ever goes on.
  await multi.first().click();
  const cleared = await markOf(multi.first());
  expect(cleared.drawn).toBe(false);
  expect(cleared.background).not.toBe(accent);
  expect(cleared.borderColor).toBe(ink3);
}

test.describe('a question shows on screen how many answers it takes', () => {
  test('light mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HARNESS);
    await assertModesAreTold(page);
  });

  test('dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HARNESS);
    await assertModesAreTold(page);
  });

  test('the indicator is decoration: the accessible state stays on the button', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const multi = rows(page, MULTI_Q).first();
    // The role and `aria-checked` are what a screen reader is told; the mark
    // must not push a second copy of that into the accessible name.
    await expect(multi).toHaveRole('checkbox');
    await expect(multi).toHaveAttribute('aria-checked', 'false');
    await expect(multi).toHaveAccessibleName('Search Full-text search over chats.');
    await multi.click();
    await expect(multi).toHaveAttribute('aria-checked', 'true');
    await expect(multi).toHaveAccessibleName('Search Full-text search over chats.');
    await expect(rows(page, SINGLE_Q).first()).toHaveRole('radio');
  });
});
