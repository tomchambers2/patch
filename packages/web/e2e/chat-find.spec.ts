import { test, expect } from '@playwright/test';

// Find in this chat (spec/14 § Find in chat): ⌘F over a chat opens a bar that
// highlights matches in the transcript and steps through them.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const HARNESS = '/app/dev-harness.html?chat=chat_md';

test('⌘F opens the bar, counts matches, steps with Enter, Esc closes', async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('chat-stream')).toBeVisible();
  await expect(page.getByTestId('chat-find')).toHaveCount(0);

  await page.keyboard.press(`${MOD}+f`);
  const input = page.getByTestId('chat-find-input');
  await expect(input).toBeFocused();

  // Pick a word that really is in the transcript.
  const word = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="chat-stream"]')?.textContent ?? '';
    return t.match(/[A-Za-z]{5,}/)?.[0] ?? '';
  });
  expect(word).not.toBe('');
  await input.fill(word);
  const count = page.getByTestId('chat-find-count');
  await expect(count).toHaveText(/^1\/\d+$/);
  expect(await page.evaluate(() => (CSS as any).highlights.get('chat-find').size)).toBeGreaterThan(
    0,
  );

  const total = Number((await count.textContent())!.split('/')[1]);
  await input.press('Enter');
  await expect(count).toHaveText(total > 1 ? `2/${total}` : `1/1`);
  await input.press('Shift+Enter');
  await expect(count).toHaveText(`1/${total}`);

  await input.fill('zzzqqqnomatch');
  await expect(count).toHaveText('0');

  await input.press('Escape');
  await expect(page.getByTestId('chat-find')).toHaveCount(0);
  expect(await page.evaluate(() => (CSS as any).highlights.has('chat-find'))).toBe(false);
});
