import { test, expect } from '@playwright/test';

// Real-browser e2e for the goal bar (spec/14 § Main chat panel — Goal bar).
// Real ChatRoute + real CSS via the dev harness, no backend. The goal text is
// shown in full (wrapped) and edited in a modal; everything else sits on one
// readable line.
const HARNESS = '/app/dev-harness.html?chat=chat_tasks';
const LONG =
  'Ship the release by Friday with every migration applied, the changelog written, the APK published and the old goal text fully visible without truncation anywhere in the bar';

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 780 }],
] as const) {
  test.describe(`goal bar — ${name}`, () => {
    test.use({ viewport });

    test('clicking the goal opens a modal; saving posts the new goal', async ({ page }) => {
      let posted: unknown = null;
      await page.route('**/api/chats/*/goal', async (r) => {
        posted = r.request().postDataJSON();
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.goto(HARNESS);
      await page.getByTestId('goal-banner-text').click();
      const input = page.getByTestId('goal-edit-input');
      await expect(input).toBeFocused();
      await input.fill(LONG);
      await page.getByTestId('goal-edit-save').click();
      await expect(page.getByTestId('goal-edit-modal')).toHaveCount(0);
      await expect(page.getByTestId('goal-banner-text')).toHaveText(LONG);
      expect(posted).toEqual({ goal: LONG });
    });

    test('the full goal text is visible, wrapped, in a readable font', async ({ page }) => {
      await page.route('**/api/chats/*/goal', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
      );
      await page.goto(HARNESS);
      await page.getByTestId('goal-banner-text').click();
      await page.getByTestId('goal-edit-input').fill(LONG);
      await page.getByTestId('goal-edit-save').click();
      const text = page.getByTestId('goal-banner-text');
      const m = await text.evaluate((el) => ({
        clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        font: parseFloat(getComputedStyle(el).fontSize),
      }));
      expect(m.clipped).toBe(false);
      expect(m.font).toBeGreaterThanOrEqual(15);
      const bar = await page.getByTestId('goal-banner').boundingBox();
      const box = await text.boundingBox();
      expect(box!.width).toBeGreaterThan(bar!.width * 0.7);
    });

    test('label, metrics and clear sit on a single line', async ({ page }) => {
      await page.goto(HARNESS);
      const meta = page.getByTestId('goal-banner-meta');
      const clear = page.getByTestId('goal-clear-btn');
      const a = await meta.boundingBox();
      const b = await clear.boundingBox();
      expect(a!.height).toBeLessThan(40);
      expect(Math.abs(a!.y + a!.height / 2 - (b!.y + b!.height / 2))).toBeLessThan(8);
    });
  });
}
