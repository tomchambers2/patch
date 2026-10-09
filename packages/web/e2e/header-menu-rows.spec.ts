import { test, expect } from '@playwright/test';

// Todoist: "buttons are broken here. add tests and fix. also spacing." The ⋯
// menu's Snooze row held a 32px icon-only button inside a plain div: the word
// "Snooze" was dead text, and the oversized clock pushed its icon and label
// out of line with Tools / Move to… / Delete. Real CSS only shows in a browser.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('⋯ menu rows line up and the whole Snooze row is a button', () => {
  test('every row has its icon at the same x, its label at the same x, and one height', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    const menu = page.getByTestId('head-menu');
    await expect(menu).toBeVisible();

    const ids = ['action-tools', 'action-snooze', 'action-move', 'action-delete'];
    const iconX: number[] = [];
    const labelX: number[] = [];
    const heights: number[] = [];
    for (const id of ids) {
      const item = menu.getByTestId(id);
      const box = (await item.boundingBox())!;
      const svg = (await item.locator('svg').first().boundingBox())!;
      iconX.push(svg.x);
      heights.push(box.height);
      labelX.push(
        await item.evaluate((el) => {
          const r = document.createRange();
          const t = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)!;
          r.selectNodeContents(t);
          return r.getBoundingClientRect().x;
        }),
      );
    }
    for (const xs of [iconX, labelX]) {
      expect(Math.max(...xs) - Math.min(...xs), JSON.stringify(xs)).toBeLessThanOrEqual(0.5);
    }
    expect(
      Math.max(...heights) - Math.min(...heights),
      JSON.stringify(heights),
    ).toBeLessThanOrEqual(0.5);
  });

  test('clicking the right end of the Snooze row opens the presets, and Esc closes them', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('action-more').click();
    // Click the far right of the row, nowhere near the clock.
    const box = (await page.getByTestId('action-snooze').boundingBox())!;
    await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
    await expect(page.getByTestId('snooze-menu')).toBeVisible();
    await expect(page.locator('.snooze-option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('snooze-menu')).toHaveCount(0);
  });
});
