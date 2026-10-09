import { test, expect } from '@playwright/test';

// spec/14 § "Thinking…" indicator — all three dots share one beat, pulsing
// together rather than travelling in sequence, and the pulse is opacity alone.
// jsdom applies no stylesheet and runs no animation, so only a real browser can
// say what the three dots are actually doing at a given instant. A screenshot
// can't either: caught anywhere in the old staggered cycle's flat stretch the
// dots looked identical, so the proof has to be a run of samples taken ACROSS
// the cycle, each of the three read on the same frame.
const RUNNING_CHAT = '/app/dev-harness.html?chat=chat_bus'; // seeded activity: 'running'

// One full cycle is 1.2s; sample a little over one so no phase goes unseen.
async function sampleDots(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const dots = [...document.querySelectorAll('.thinking-dots span')];
    if (dots.length !== 3) throw new Error(`expected 3 dots, got ${dots.length}`);
    const frames: { opacities: number[]; transforms: string[] }[] = [];
    const started = performance.now();
    while (performance.now() - started < 1400) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      // Read all three on the SAME frame — comparing values taken at different
      // instants would prove nothing about whether they are in phase.
      frames.push({
        opacities: dots.map((d) => Number(getComputedStyle(d).opacity)),
        transforms: dots.map((d) => getComputedStyle(d).transform),
      });
    }
    return frames;
  });
}

test.describe('"Thinking…" indicator — the dots blink in sync', () => {
  test('all three dots hold the same opacity on every frame of the cycle', async ({ page }) => {
    await page.goto(RUNNING_CHAT);
    await expect(page.getByTestId('thinking-indicator')).toBeVisible();

    const frames = await sampleDots(page);
    expect(frames.length).toBeGreaterThan(20);

    for (const { opacities } of frames) {
      const [a, b, c] = opacities as [number, number, number];
      // Sub-frame scheduling jitter, not a stagger: the old delays were 0.18s
      // and 0.36s of a 1.2s cycle, which move opacity by whole tenths.
      expect(Math.abs(a - b)).toBeLessThan(0.02);
      expect(Math.abs(a - c)).toBeLessThan(0.02);
    }
  });

  test('the dots are actually pulsing, between muted and full', async ({ page }) => {
    await page.goto(RUNNING_CHAT);
    await expect(page.getByTestId('thinking-indicator')).toBeVisible();

    const frames = await sampleDots(page);
    const first = frames.map((f) => f.opacities[0] as number);
    // In sync but frozen would satisfy the test above; the indicator's whole
    // job is to say the chat is not dead.
    expect(Math.min(...first)).toBeLessThan(0.5);
    expect(Math.max(...first)).toBeGreaterThan(0.9);
  });

  test('no dot moves — the blink is opacity only, so the row never jumps', async ({ page }) => {
    await page.goto(RUNNING_CHAT);
    await expect(page.getByTestId('thinking-indicator')).toBeVisible();

    const frames = await sampleDots(page);
    for (const { transforms } of frames) {
      for (const transform of transforms) {
        expect(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
      }
    }

    // And the row itself keeps a fixed height and top edge throughout.
    const dots = page.locator('.thinking-dots');
    const before = (await dots.boundingBox())!;
    await page.waitForTimeout(600);
    const after = (await dots.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  });
});
