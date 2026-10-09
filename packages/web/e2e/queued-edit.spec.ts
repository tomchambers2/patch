import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/04 ## Message queueing § Edit — "click to edit a queued message". In a
// real browser with the real CSS: clicking the queued text opens the in-place
// editor, Save fires `chat.edit_queued_request`, and the host's re-announce
// updates the message where it sits in the queue.
const QUEUED = '/app/dev-harness.html?chat=chat_queued&ws=fake';

type Win = {
  __wsSent: WireEvent[];
  __store: { getState(): { applyEvents(e: WireEvent[]): void } };
};

test('clicking a queued message edits it in place, keeping its place in the queue', async ({
  page,
}) => {
  await page.goto(QUEUED);
  const queued = page.locator('[data-queued="true"]');
  await expect(queued.nth(0)).toContainText('first queued turn');
  // It reads as editable.
  await expect(queued.nth(0).getByTestId('msg-content')).toHaveCSS('cursor', 'text');

  await queued.nth(0).getByTestId('msg-content').click();
  const input = page.getByTestId('msg-edit-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('first queued turn');

  await input.fill('first queued turn, reworded');
  await page.getByTestId('msg-edit-save').click();
  await expect(input).toHaveCount(0);

  const sent = await page.evaluate(() =>
    (window as unknown as Win).__wsSent.filter((e) => e.type === 'chat.edit_queued_request'),
  );
  expect(sent).toEqual([
    {
      type: 'chat.edit_queued_request',
      chatId: 'chat_queued',
      localId: expect.any(String),
      message: 'first queued turn, reworded',
    },
  ]);

  // The host re-announces it with the same localId: updated where it sits.
  const localId = (sent[0] as { localId: string }).localId;
  await page.evaluate((id) => {
    (window as unknown as Win).__store.getState().applyEvents([
      {
        type: 'chat.queued',
        chatId: 'chat_queued',
        localId: id,
        message: 'first queued turn, reworded',
        queueSeq: 1,
      },
    ]);
  }, localId);
  await expect(queued.nth(0)).toContainText('first queued turn, reworded');
  await expect(queued.nth(1)).toContainText('second queued turn');
  await expect(queued.nth(0).getByTestId('queued-badge')).toHaveText('Queued');
});
