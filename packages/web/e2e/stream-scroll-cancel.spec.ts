import { test, expect, type Page } from '@playwright/test';

// Todoist: "when a response is streaming in and you try and scroll up to see
// what's already loaded it's very juttery because you're fighting it trying to
// pull down ... once you start to scroll up it should cancel scrolling to the
// bottom" (spec/14 § Main chat panel).
//
// This is the one that only a real browser can show, and the shape of the input
// is the whole test. A trackpad/wheel delivers a scroll as a long run of small
// deltas, a few dozen pixels each. Judged only by POSITION, every one of those
// lands inside the 50px at-bottom band, so follow mode stays on and the re-pin
// scheduled by the next streaming chunk puts `scrollTop` straight back at the
// bottom — which also resets the band, so the next delta is measured from the
// bottom again and is inside it again. The displacement can never accumulate:
// the user pushes up, the transcript pulls down, for as long as they keep
// trying. A single 200px fling escapes on the first event and looks fine, which
// is exactly why this reproduces with small deltas and not with big ones.
//
// The fixture streams a chunk on EVERY animation frame, so there is always a
// re-pin pending, as there is during a real reply.

const CHAT = 'chat_scroll';

type HarnessWindow = {
  __store: { setState: (fn: (s: unknown) => unknown) => void };
  __streamStop?: () => void;
};

/** Append an assistant chunk on every frame, as a live reply does. */
async function startStreaming(page: Page): Promise<void> {
  await page.evaluate((chatId) => {
    const w = window as unknown as HarnessWindow;
    let seq = 1000;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      w.__store.setState((s) => {
        const st = s as { timelines: Record<string, unknown[]> };
        return {
          timelines: {
            ...st.timelines,
            [chatId]: [
              ...st.timelines[chatId]!,
              {
                seq: seq++,
                kind: 'message',
                role: 'assistant',
                content: `streaming chunk ${seq} — lorem ipsum dolor sit amet consectetur.`,
                at: seq,
              },
            ],
          },
        };
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__streamStop = () => {
      running = false;
    };
  }, CHAT);
}

async function stopStreaming(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as HarnessWindow).__streamStop?.());
}

async function openPinnedToBottom(page: Page): Promise<void> {
  await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();
  // There is somewhere to scroll (otherwise every assertion below is vacuous).
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(200);
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
      timeout: 4000,
    })
    .toBeLessThan(5);
}

/**
 * Put the pointer over the transcript and scroll it with a run of small deltas,
 * the way a trackpad or a wheel actually reports one. Negative is up.
 */
async function scrollBy(page: Page, delta: number, steps: number): Promise<void> {
  const box = await page.locator('.chat-stream').boundingBox();
  if (box === null) throw new Error('.chat-stream has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(30);
  }
}

test.describe('scrolling up while a reply streams in', () => {
  test('cancels the auto-scroll instead of dragging the view back to the bottom', async ({
    page,
  }) => {
    await openPinnedToBottom(page);
    const stream = page.locator('.chat-stream');
    await startStreaming(page);
    // Let it stream for a moment while the user is still at the bottom.
    await page.waitForTimeout(300);

    // 20 small notches up — ~600px of deliberate scrolling, delivered the way
    // a trackpad delivers it.
    await scrollBy(page, -30, 20);
    const afterWheel = await stream.evaluate((el) => el.scrollTop);
    const gapAfterWheel = await stream.evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
    );

    // The scrolling actually moved the view: the user got to read history
    // rather than being held at the bottom for the whole gesture.
    expect(gapAfterWheel).toBeGreaterThan(400);

    // The reply keeps streaming for another beat. This is the window in which
    // the view used to be yanked back down, over and over.
    await page.waitForTimeout(600);
    const settled = await stream.evaluate((el) => ({
      top: el.scrollTop,
      gap: el.scrollHeight - el.clientHeight - el.scrollTop,
    }));
    await stopStreaming(page);

    // The view stayed where the user put it...
    expect(Math.abs(settled.top - afterWheel)).toBeLessThan(40);
    // ...and the bottom has run away from them, which is the whole point: they
    // are reading history while the reply carries on below.
    expect(settled.gap).toBeGreaterThan(gapAfterWheel);
  });

  test('re-engages the auto-scroll when the user scrolls back to the bottom', async ({ page }) => {
    await openPinnedToBottom(page);
    const stream = page.locator('.chat-stream');
    await startStreaming(page);
    await page.waitForTimeout(300);

    await scrollBy(page, -30, 20);
    await page.waitForTimeout(200);
    expect(
      await stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    ).toBeGreaterThan(200);

    // The reply finishes, and the user scrolls back down to the end themselves.
    await stopStreaming(page);
    await scrollBy(page, 400, 12);
    await expect
      .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(5);

    // Following again: the next reply keeps its newest chunk pinned in view.
    await startStreaming(page);
    await page.waitForTimeout(500);
    const gap = await stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await stopStreaming(page);
    expect(gap).toBeLessThan(5);
  });
});
