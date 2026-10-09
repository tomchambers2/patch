import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Messages — on a wide panel the meta strip sits in the gutter beside
// the turn (stacked, readable) instead of squashed into the 16px tail below it.
const CREATED_AT = new Date('2024-03-01T14:32:00Z').getTime();

async function send(page: import('@playwright/test').Page, event: WireEvent) {
  await page.evaluate(
    (e) => {
      (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store
        .getState()
        .applyEvent(e);
    },
    event as unknown as WireEvent,
  );
}

for (const [label, width, inGutter] of [
  ['wide', 1600, true],
  ['narrow', 900, false],
] as const) {
  test(`${label} panel: meta strip ${inGutter ? 'beside' : 'under'} the message`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.clock.setFixedTime(CREATED_AT);
    await send(page, {
      type: 'chat.message',
      chatId: 'chat_bus',
      role: 'assistant',
      content: 'here is the answer',
      seq: 9100,
      createdAt: CREATED_AT,
    } as unknown as WireEvent);

    const msg = page.getByTestId('msg').filter({ hasText: 'here is the answer' });
    await msg.hover();
    const meta = msg.getByTestId('msg-meta');
    await expect(meta).toHaveCSS('opacity', '1');
    const m = await meta.boundingBox();
    const content = await msg.locator('.content').boundingBox();
    if (!m || !content) throw new Error('missing boxes');

    if (inGutter) {
      expect(m.x).toBeGreaterThanOrEqual(content.x + content.width);
      expect(m.y).toBeLessThan(content.y + 40);
      // host and model are fully visible, not clipped or overlapping.
      const host = await meta.getByTestId('msg-meta-host').boundingBox();
      const model = await meta.getByTestId('msg-meta-model').boundingBox();
      if (!host || !model) throw new Error('missing host/model');
      expect(model.y).toBeGreaterThanOrEqual(host.y + host.height - 1);
      expect(model.x + model.width).toBeLessThanOrEqual(m.x + m.width + 1);
      const vw = page.viewportSize()!.width;
      expect(m.x + m.width).toBeLessThanOrEqual(vw);
    } else {
      expect(m.y).toBeGreaterThanOrEqual(content.y + content.height - 1);
    }
  });
}
