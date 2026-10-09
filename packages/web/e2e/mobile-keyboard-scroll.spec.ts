import { test, expect, type Page } from '@playwright/test';

// Todoist: "Patch opening keyboard should keep same content focused on
// mobile. I'm looking at something and I want to keep it in view while I
// write a response" (spec/14 § Main chat panel).
//
// On a real phone the soft keyboard opening shrinks the layout viewport (the
// `interactive-widget=resizes-content` viewport meta in index.html), which
// shrinks `.chat-stream`'s own clientHeight — a container resize, not a
// content resize, and not something jsdom can produce (no layout engine).
// `setViewportSize` is a real browser resize and exercises the exact same
// CSS (`.chat-stream { flex: 1 }` inside `.app-shell { height: 100% }`), so
// this is a faithful stand-in without needing an actual mobile keyboard.

async function openChat(page: Page): Promise<void> {
  await page.goto('/app/dev-harness.html?chat=chat_scroll');
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();
  // There is somewhere to scroll (otherwise every assertion below is vacuous).
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(200);
}

/** Wheel-scroll the transcript the way a trackpad delivers it (negative is up). */
async function scrollBy(page: Page, delta: number, steps: number): Promise<void> {
  const box = await page.locator('.chat-stream').boundingBox();
  if (box === null) throw new Error('.chat-stream has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(30);
  }
}

async function shrinkViewportForKeyboard(page: Page): Promise<void> {
  const size = page.viewportSize();
  if (size === null) throw new Error('page has no viewport size');
  await page.setViewportSize({ width: size.width, height: size.height - 300 });
}

test.describe('the soft keyboard opening (a container resize)', () => {
  test('leaves a reading position untouched', async ({ page }) => {
    await openChat(page);
    const stream = page.locator('.chat-stream');

    // A fresh open is pinned to the bottom; scroll up to read history, which
    // turns following off and lands mid-transcript.
    await scrollBy(page, -30, 20);
    await expect
      .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeGreaterThan(200);
    const before = await stream.evaluate((el) => el.scrollTop);

    await shrinkViewportForKeyboard(page);
    // Give the ResizeObserver a moment to fire.
    await page.waitForTimeout(300);

    const after = await stream.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(5);
  });

  test('still re-pins to the newest message while following', async ({ page }) => {
    await openChat(page);
    const stream = page.locator('.chat-stream');

    await expect
      .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(5);

    await shrinkViewportForKeyboard(page);

    await expect
      .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(5);
  });
});
