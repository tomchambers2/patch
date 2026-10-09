import { test, expect } from '@playwright/test';

// spec/14 § Composer — the input grows UPWARD (Todoist 6hWM34ph8Ph4vwcc:
// "patch need to be able to expand text box upwards if its long").
//
// `composer-transcript-layout.spec.ts` already proves the field auto-grows and
// caps. What it does NOT prove is the DIRECTION: that the extra height is taken
// from the transcript above rather than pushing the composer down off the
// window. That is what these measure — the composer's own bottom edge must not
// move as the field grows, and the transcript must give up the space.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';
const CAP = 200; // `.composer-input` max-height / MAX_INPUT_HEIGHT

/** A paste comfortably past the cap. */
const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long message`).join('\n');

async function box(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<{ top: number; bottom: number; height: number }> {
  return page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  });
}

test.describe('composer grows upwards', () => {
  test('the composer bottom edge does not move as the input grows', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();

    const oneLine = await box(page, '.composer');
    await input.fill('one\ntwo\nthree\nfour\nfive');
    await page.waitForTimeout(80);
    const several = await box(page, '.composer');
    await input.fill(LONG);
    await page.waitForTimeout(80);
    const capped = await box(page, '.composer');

    // Grew.
    expect(several.height).toBeGreaterThan(oneLine.height + 30);
    expect(capped.height).toBeGreaterThan(several.height);
    // Upwards: the bottom stayed where it was (sub-pixel tolerance only)...
    expect(Math.abs(several.bottom - oneLine.bottom)).toBeLessThan(2);
    expect(Math.abs(capped.bottom - oneLine.bottom)).toBeLessThan(2);
    // ...and the top rose by the whole of the growth.
    expect(oneLine.top - capped.top).toBeGreaterThan(30);
  });

  test('the transcript yields the space rather than being pushed off-screen', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();
    const streamBefore = await box(page, '.chat-stream');
    const composerBefore = await box(page, '.composer');

    await input.fill(LONG);
    await page.waitForTimeout(80);
    const streamAfter = await box(page, '.chat-stream');
    const composerAfter = await box(page, '.composer');

    // The transcript shrank by what the composer gained; nothing overflowed the
    // window, which is what "pushed off-screen" would look like.
    expect(streamAfter.height).toBeLessThan(streamBefore.height);
    const gained = composerAfter.height - composerBefore.height;
    const lost = streamBefore.height - streamAfter.height;
    expect(Math.abs(gained - lost)).toBeLessThan(2);
    const viewport = page.viewportSize();
    expect(composerAfter.bottom).toBeLessThanOrEqual((viewport?.height ?? 800) + 1);
  });

  test('it stops at the cap and scrolls inside instead of taking the window', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();
    await input.fill(LONG);
    await page.waitForTimeout(80);

    const field = await input.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return {
        height: t.getBoundingClientRect().height,
        overflowY: getComputedStyle(t).overflowY,
        scrollHeight: t.scrollHeight,
        clientHeight: t.clientHeight,
      };
    });
    expect(field.height).toBeLessThanOrEqual(CAP + 1);
    expect(field.overflowY).toBe('auto');
    // Genuinely scrollable — the rest of the message is reachable, not lost.
    expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
  });

  test('screenshots: one line, several lines, past the cap', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();
    await input.fill('a short message');
    await page.waitForTimeout(80);
    await page.screenshot({ path: '/tmp/queue-shots/G-web-composer-1-line.png' });

    await input.fill('one\ntwo\nthree\nfour\nfive');
    await page.waitForTimeout(80);
    await page.screenshot({ path: '/tmp/queue-shots/G-web-composer-several-lines.png' });

    await input.fill(LONG);
    await page.waitForTimeout(80);
    await page.screenshot({ path: '/tmp/queue-shots/G-web-composer-past-cap.png' });
  });
});
