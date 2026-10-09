// Tom: "the way that conversations load — it loads the first message and loads
// them one [at a time] which results in an incredibly irritating way of looking
// at it and it's very slow as well ... [it should] load from the last message
// up so that there's no visual glitch and not load one message at a time which
// seems incredibly inefficient".
//
// A chat's history is not fetched over REST on open: the surface sends a
// `chat.replay` and the host re-emits every historical entry as its own
// WireEvent frame (582 of them on a busy chat). Committing each to the store
// separately meant one render of the whole stream per message, so the chat
// filled in visibly from the OLDEST message down while the scroll chased the
// growing content.
//
// The coalescing itself is unit-tested (a burst of frames becomes ONE store
// commit — src/__tests__/ws.test.ts, and applyEvents in chatStore.test.ts).
// What only a real browser can show is the consequence Tom actually sees: a
// cold-opened chat is anchored at its NEWEST message and stays there while the
// rest of the transcript lands, rather than stranding at the top of history.
//
// `chat_replay_dupe` deliberately has no seeded timeline (see dev-harness.tsx),
// so it stands in for a chat opened cold, before its replay lands.

import { test, expect } from '@playwright/test';

const HISTORY_LINES = 40;

/** One `chat.replay` frame per transcript entry, as the host emits them. */
function historyEvents(chatId: string, from: number, to: number): unknown[] {
  return Array.from({ length: to - from }, (_, i) => ({
    type: 'chat.message',
    chatId,
    seq: from + i,
    role: (from + i) % 2 === 0 ? 'user' : 'assistant',
    content: `replay line ${from + i}`,
  }));
}

/** Apply a run of replay frames the way the coalescing ws client now does. */
async function deliverBatch(
  page: import('@playwright/test').Page,
  events: unknown[],
): Promise<void> {
  await page.evaluate(
    ({ events: evts }) => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvents: (e: unknown[]) => void } };
        }
      ).__store;
      store.getState().applyEvents(evts);
    },
    { events },
  );
}

/** Distance from the bottom of the scroller, in px. */
function distanceFromBottom(stream: import('@playwright/test').Locator): Promise<number> {
  return stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

test.describe('a cold-opened chat is anchored at its newest replayed message', () => {
  test('a replayed transcript lands on the newest message, not the top of history', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_replay_dupe');
    const stream = page.locator('.chat-stream');
    await expect(stream).toBeVisible();
    // Cold open: nothing rendered yet, so this really is the replay path.
    await expect(page.locator('[data-testid="msg"]')).toHaveCount(0);

    await deliverBatch(page, historyEvents('chat_replay_dupe', 0, HISTORY_LINES));
    await expect(page.locator('[data-testid="msg"]')).toHaveCount(HISTORY_LINES);

    // The transcript overflows, so there IS somewhere to scroll — otherwise the
    // assertion below is vacuous.
    await expect
      .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(100);

    // Pinned to the newest message, not stranded where the fill began.
    await expect.poll(async () => distanceFromBottom(stream), { timeout: 4000 }).toBeLessThan(5);

    const last = page.locator('[data-testid="msg"]').last();
    await expect(last).toContainText(`replay line ${HISTORY_LINES - 1}`);
    await expect(last).toBeInViewport();
  });

  test('stays pinned to the bottom as further replay frames land', async ({ page }) => {
    // A long replay does not arrive in a single frame: the coalescer commits
    // once per frame, so the stream grows over several commits. Each one must
    // re-pin — this is the "visual glitch" case, where the view drifts up the
    // transcript as content is appended below it.
    await page.goto('/app/dev-harness.html?chat=chat_replay_dupe');
    const stream = page.locator('.chat-stream');
    await expect(stream).toBeVisible();

    await deliverBatch(page, historyEvents('chat_replay_dupe', 0, 15));
    await expect(page.locator('[data-testid="msg"]')).toHaveCount(15);
    await expect.poll(async () => distanceFromBottom(stream), { timeout: 4000 }).toBeLessThan(5);

    for (const [from, to] of [
      [15, 28],
      [28, HISTORY_LINES],
    ]) {
      await deliverBatch(page, historyEvents('chat_replay_dupe', from!, to!));
      await expect(page.locator('[data-testid="msg"]')).toHaveCount(to!);
      // Still at the newest message after the append, not pushed up by it.
      await expect.poll(async () => distanceFromBottom(stream), { timeout: 4000 }).toBeLessThan(5);
    }

    const last = page.locator('[data-testid="msg"]').last();
    await expect(last).toContainText(`replay line ${HISTORY_LINES - 1}`);
    await expect(last).toBeInViewport();
  });
});
