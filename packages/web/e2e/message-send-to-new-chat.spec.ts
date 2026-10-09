import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Message context menu — "Send to new chat": right-click a message (or
// a selection inside it) and open a new chat, in the same folder, with the text
// quoted in the composer as an unsent draft.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('send to new chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store;
      store.getState().applyEvent({
        type: 'chat.message',
        chatId: 'chat_bus',
        role: 'assistant',
        content: 'alpha beta gamma',
        seq: 9400,
        createdAt: Date.now(),
      } as unknown as WireEvent);
    });
  });

  test('right-click a selection sends just that selection', async ({ page }) => {
    const msg = page.getByTestId('msg').filter({ hasText: 'alpha beta gamma' });
    await msg.scrollIntoViewIfNeeded();
    // Select just "beta" programmatically, then open the menu on that word.
    await msg.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent?.indexOf('beta') ?? -1;
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 4);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
        const box = r.getBoundingClientRect();
        el.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: box.x + 2,
            clientY: box.y + 2,
          }),
        );
        return;
      }
      throw new Error('text not found');
    });
    await page.getByTestId('msg-context-menu-send-to-new-chat').click();
    const input = page.getByTestId('composer-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('> beta\n\n');
  });

  test('right-click with no selection sends the whole message', async ({ page }) => {
    const msg = page.getByTestId('msg').filter({ hasText: 'alpha beta gamma' });
    await msg.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await msg.locator('.content').click({ button: 'right' });
    await page.getByTestId('msg-context-menu-send-to-new-chat').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('> alpha beta gamma\n\n');
  });
});
