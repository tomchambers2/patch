import { test, expect } from '@playwright/test';

// spec/09 § `### push`, spec/14 ## Main chat panel — a patch_notify call
// carrying deepLink renders as a tappable link row on the collapsed tool-call
// summary itself (not buried in the expanded JSON), the same URI a push tap
// on the phone would open.
const DEEPLINK = '/app/dev-harness.html?chat=chat_deeplink';

test.describe('tool-call deep link', () => {
  test('a patch_notify call with a deepLink shows a tappable link on the collapsed summary', async ({
    page,
  }) => {
    await page.goto(DEEPLINK);
    const row = page.locator('[data-testid="notify-box"][data-deeplink="true"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('patch_notify');

    const link = row.getByTestId('tool-call-deeplink');
    await expect(link).toBeVisible();
    await expect(link).toContainText('citymapper://directions');
    await expect(link).toHaveAttribute(
      'href',
      'citymapper://directions?startcoord=51.4536,-2.5892&endcoord=51.4816,-2.5952',
    );
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('the notify row is a green box showing the message', async ({ page }) => {
    await page.goto(DEEPLINK);
    const box = page.getByTestId('notify-box');
    await expect(box).toContainText('Route to the venue is ready');
    const bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(g).toBeGreaterThan(r!);
    expect(g).toBeGreaterThan(b!);
  });
});
