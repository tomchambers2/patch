import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Messages — a message's hover state covers the message itself, not
// the empty row around it. A short user bubble sits at the right of a full-width
// turn box; the pointer in the blank space to its left, or in the gutter beside
// it, is not over the message and must not reveal its controls.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';
const CREATED_AT = new Date('2024-03-01T14:32:00Z').getTime();

test.describe('message hover extent', () => {
  test('hover covers the message width only; the blank row and gutter cancel it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.evaluate((createdAt) => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store;
      store.getState().applyEvent({
        type: 'chat.message',
        chatId: 'chat_bus',
        role: 'user',
        content: 'short question',
        seq: 9300,
        createdAt,
      } as unknown as WireEvent);
    }, CREATED_AT);

    const msg = page.getByTestId('msg').filter({ hasText: 'short question' });
    const meta = msg.getByTestId('msg-meta');
    const trigger = msg.getByTestId('msg-side-thread-trigger');
    await expect(meta).toHaveCount(1);
    await msg.scrollIntoViewIfNeeded();

    const content = await msg.locator('.content').boundingBox();
    const box = await msg.boundingBox();
    if (!content || !box) throw new Error('missing message boxes');
    const y = content.y + content.height / 2;
    // The turn box is wider than the bubble — otherwise there is nothing to test.
    expect(content.x - box.x).toBeGreaterThan(40);

    // Blank row to the left of the bubble.
    await page.mouse.move(box.x + 20, y);
    await expect(meta).toHaveCSS('opacity', '0');
    await expect(trigger).toHaveCSS('opacity', '0');

    // Over the bubble.
    await page.mouse.move(content.x + content.width / 2, y);
    await expect(meta).toHaveCSS('opacity', '1');
    await expect(trigger).toHaveCSS('opacity', '1');

    // Back out into the blank row: cancelled again.
    await page.mouse.move(box.x + 20, y);
    await expect(meta).toHaveCSS('opacity', '0');
  });
});
