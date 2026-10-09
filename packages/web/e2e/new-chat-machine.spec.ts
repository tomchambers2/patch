import { test, expect } from '@playwright/test';

// Real-browser e2e for choosing where a new chat runs (spec/14 §8), against the
// dev harness with two machines registered.
const NEW = '/app/dev-harness.html?chat=new&hosts=two';

test.describe('new chat — which machine', () => {
  test('choosing a machine offers its own folders and spawns there', async ({ page }) => {
    let spawnBody: Record<string, unknown> | null = null;
    await page.route('**/api/chats', async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      spawnBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
      await r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ chatId: 'c-mac', folder: '/Users/dev/code', status: 'pending' }),
      });
    });
    await page.goto(NEW);

    const home = page.getByTestId('machine-choice-d1');
    const mac = page.getByTestId('machine-choice-d2');
    await expect(home).toHaveAttribute('aria-pressed', 'true');
    await expect(mac).toHaveText('mac');
    await expect(page.getByTestId('folder-quick-/Users/dev/code')).toHaveCount(0);

    await mac.click();
    await expect(mac).toHaveAttribute('aria-pressed', 'true');
    await expect(home).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('folder-quick-/Users/dev/code').click();
    await expect(page.locator('.folder-pill-label')).toHaveText('code');

    const composer = page.getByTestId('composer-input');
    await composer.fill('hello mac');
    await composer.press('Meta+Enter');
    await expect.poll(() => spawnBody).toMatchObject({ daemonId: 'd2', folder: '/Users/dev/code' });
  });

  test('the machine row and the project row do not overlap', async ({ page }) => {
    await page.goto(NEW);
    const machines = (await page.getByTestId('new-chat-machines').boundingBox())!;
    const pill = (await page.getByTestId('new-chat-folder-pill').boundingBox())!;
    expect(machines.y + machines.height).toBeLessThanOrEqual(pill.y + 1);
  });
});
