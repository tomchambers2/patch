import { test, expect, type Page } from '@playwright/test';

// Todoist: "patch still doesn't keep the right place in the chat when
// returning" (spec/14 § Main chat panel). The remembered position is a message
// anchor; coming back to a chat whose transcript has not arrived yet (or only
// partly) used to spend that memory on the first layout pass — the anchor
// message wasn't there, so the restore fell back to a raw pixel offset and
// never tried again once the history landed.

const CHAT = 'chat_scroll';

type Store = {
  getState: () => { timelines: Record<string, unknown[]> };
  setState: (partial: unknown) => void;
};

/** Seq of the message straddling the stream's top edge, and its offset past it. */
async function topMessage(page: Page): Promise<{ seq: number; past: number }> {
  return page.locator('.chat-stream').evaluate((el) => {
    const box = el.getBoundingClientRect();
    for (const m of el.querySelectorAll<HTMLElement>('[data-testid="msg"][data-seq]')) {
      const r = m.getBoundingClientRect();
      if (r.bottom <= box.top) continue;
      return { seq: Number(m.dataset['seq']), past: box.top - r.top };
    }
    throw new Error('no message in the stream');
  });
}

test('returning to a chat whose history arrives late keeps the place the user left', async ({
  page,
}) => {
  await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
      timeout: 4000,
    })
    .toBeLessThan(5);

  // Read history: a run of small wheel notches up, the way a trackpad scrolls.
  const box = await stream.boundingBox();
  if (box === null) throw new Error('.chat-stream has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, -30);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(200);
  const left = await topMessage(page);
  expect(left.seq).toBeLessThan(30);

  // Leave for another chat; while away, this chat's transcript is dropped so it
  // has to be fetched again on return.
  await page.locator('.sb-scroll [data-testid="chat-row-chat_bus"]').click();
  await expect(stream.getByText('history line 5 ')).toHaveCount(0);
  const full = await page.evaluate((chatId) => {
    const s = (window as unknown as { __store: Store }).__store;
    const saved = s.getState().timelines[chatId]!;
    s.setState({ timelines: { ...s.getState().timelines, [chatId]: [] } });
    return saved;
  }, CHAT);

  await page.locator(`.sb-scroll [data-testid="chat-row-${CHAT}"]`).click();
  await page.waitForTimeout(300);

  // The history lands after the first layout pass.
  await page.evaluate(
    ([chatId, entries]) => {
      const s = (window as unknown as { __store: Store }).__store;
      s.setState({ timelines: { ...s.getState().timelines, [chatId as string]: entries } });
    },
    [CHAT, full] as const,
  );

  await expect.poll(async () => (await topMessage(page)).seq, { timeout: 4000 }).toBe(left.seq);
  const back = await topMessage(page);
  expect(Math.abs(back.past - left.past)).toBeLessThan(4);
});
