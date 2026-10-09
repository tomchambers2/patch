// The desktop app's first-run page (packages/desktop/src/setup/setup.html,
// spec/05 § Desktop first run): the one question, "On this Mac" or "On my
// server", with the shell's bridge (`window.patchSetup`) stood in for by a
// recorder so the page can be driven on its own, in a real browser.

import { expect, test, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = `file://${join(dirname(fileURLToPath(import.meta.url)), '../../desktop/src/setup/setup.html')}`;

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w['__chosen'] = [];
    w['patchSetup'] = {
      choose: (c: unknown) => (w['__chosen'] as unknown[]).push(c),
      onProgress: (cb: (m: string) => void) => (w['__progress'] = cb),
      onFail: (cb: (m: string) => void) => (w['__fail'] = cb),
    };
  });
  await page.goto(PAGE);
}

const chosen = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => (window as never as { __chosen: unknown[] }).__chosen);

test.describe('first run', () => {
  test('asks one question with two answers, and nothing else', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'Patch' })).toBeVisible();
    await expect(page.getByTestId('choose-local')).toHaveText('On this Mac');
    await expect(page.getByTestId('choose-remote')).toHaveText('On my server');
    await expect(page.getByTestId('join-form')).toBeHidden();
    await expect(page.getByTestId('error')).toBeHidden();
  });

  test('"On this Mac" makes the choice, locks the page, and shows what the shell reports', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('choose-local').click();
    expect(await chosen(page)).toEqual([{ kind: 'local' }]);
    await expect(page.getByTestId('choose-local')).toBeDisabled();
    await expect(page.getByTestId('choose-remote')).toBeDisabled();
    await page.evaluate(() =>
      (window as never as { __progress(m: string): void }).__progress('Starting the server…'),
    );
    await expect(page.getByTestId('status')).toHaveText('Starting the server…');
  });

  test('a failure is shown, the page unlocks, and it can be tried again', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-local').click();
    await page.evaluate(() =>
      (window as never as { __fail(m: string): void }).__fail(
        'Installing the host failed (1):\ncurl: (7)',
      ),
    );
    await expect(page.getByTestId('error')).toContainText('curl: (7)');
    await expect(page.getByTestId('choose-local')).toBeEnabled();
    await page.getByTestId('choose-local').click();
    expect(await chosen(page)).toEqual([{ kind: 'local' }, { kind: 'local' }]);
    await expect(page.getByTestId('error')).toBeHidden();
  });

  test('"On my server" asks for the pairing code and sends it as typed, trimmed', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await expect(page.getByTestId('join-form')).toBeVisible();
    await expect(page.getByTestId('pairing-code')).toBeFocused();
    await page.getByTestId('pairing-code').fill('  patch-pair://patch.example.com?nonce=abc \n');
    await page.getByTestId('connect').click();
    expect(await chosen(page)).toEqual([
      { kind: 'remote', input: 'patch-pair://patch.example.com?nonce=abc' },
    ]);
  });

  test('an empty code is turned back on the page without bothering the shell', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('error')).toContainText('Paste the pairing code');
    expect(await chosen(page)).toEqual([]);
  });

  test('Back returns to the question', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await page.getByTestId('back').click();
    await expect(page.getByTestId('choose-local')).toBeVisible();
    await expect(page.getByTestId('join-form')).toBeHidden();
  });

  test('a rejected code leaves the form open to correct', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await page.getByTestId('pairing-code').fill('patch-pair://x?nonce=old');
    await page.getByTestId('connect').click();
    await page.evaluate(() =>
      (window as never as { __fail(m: string): void }).__fail('pairing nonce expired'),
    );
    await expect(page.getByTestId('error')).toHaveText('pairing nonce expired');
    await expect(page.getByTestId('join-form')).toBeVisible();
    await expect(page.getByTestId('pairing-code')).toBeEnabled();
    await expect(page.getByTestId('pairing-code')).toHaveValue('patch-pair://x?nonce=old');
  });
});
