import { test, expect } from '@playwright/test';

// spec/14 § Breathing room — a tool row inside a turn sits evenly between the
// prose either side of it and the working dots below it. It used to hang 38px
// under the paragraph before it and 10px over the one after, so it read as
// belonging to the wrong paragraph.
test('a tool row sits evenly between the prose around it and the working dots', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_tool_rhythm');
  await expect(page.locator('[data-testid="tool-group"]')).toHaveCount(2);
  const gaps = await page.evaluate(() => {
    const first = document.querySelector('[data-testid="tool-group"]')!;
    const rows = [...first.parentElement!.children].slice(1);
    // The gap the eye sees: from where a message's text ends, not its box —
    // a real message also carries the (invisible at rest) meta strip.
    const seen = (el: Element): number =>
      (el.classList.contains('msg') ? el.querySelector('.content')! : el).getBoundingClientRect()
        .bottom;
    const out: number[] = [];
    for (let i = 1; i < rows.length; i++)
      out.push(Math.round(rows[i]!.getBoundingClientRect().top - seen(rows[i - 1]!)));
    return out;
  });
  // prose, run, prose, run, prose, lone call, dots — every seam the same, with
  // the messages carrying their timestamp strip as they do in a real chat.
  await expect(page.locator('[data-testid="msg-meta"]').first()).toHaveCount(1);
  expect(gaps).toEqual([16, 16, 16, 16, 16, 16]);
  await expect(page.locator('[data-testid="tool-group-summary"]').first()).toHaveText(
    '▸Looking at the poller first.',
  );
  const size = await page
    .locator('.tool-group .tool-summary-text')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(size).toBe('15px');
});
