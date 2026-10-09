import { test, expect } from '@playwright/test';

// spec/14 § Reserved OS chords — ⌘A (⌃A on Linux/Windows) is select-all, and
// the app must never take it over. Reported by Tom: "cmd + a does not select
// all text" — the global shortcut hook was calling preventDefault() and
// archiving the chat instead, so the transcript could not be selected/copied.
//
// jsdom can't answer this: it has no real selection model and no layout. This
// runs the REAL shortcut hook (mounted by the dev harness) in a real browser
// and checks the actual document selection.
const MD = '/app/dev-harness.html?chat=chat_md';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function shortcutCalls(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __shortcutCalls?: string[] }).__shortcutCalls ?? [],
  );
}

test.describe('select all', () => {
  test('⌘A over the transcript selects the conversation text', async ({ page }) => {
    await page.goto(MD);
    const prose = page.locator('.msg-assistant .content p').first();
    await expect(prose).toBeVisible();
    const proseText = ((await prose.textContent()) ?? '').trim();
    expect(proseText.length).toBeGreaterThan(0);

    // Click the transcript so focus is in the page but NOT in a text field.
    await prose.click();
    await page.keyboard.press(`${MOD}+a`);

    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    // The whole document's text is selected, so the assistant prose is in it.
    expect(selected.length).toBeGreaterThan(proseText.length);
    expect(selected).toContain(proseText.slice(0, 40));
    // …and no app action stole the chord.
    expect(await shortcutCalls(page)).not.toContain('archiveCurrent');
  });

  test('⌘A inside the composer selects the typed text, and does not archive', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=thread_manager');
    const composer = page.locator('textarea').first();
    await expect(composer).toBeVisible();
    await composer.click();
    await composer.fill('hello there this is a draft');
    await page.keyboard.press(`${MOD}+a`);

    const sel = await composer.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return t.value.slice(t.selectionStart, t.selectionEnd);
    });
    expect(sel).toBe('hello there this is a draft');
    expect(await shortcutCalls(page)).not.toContain('archiveCurrent');
  });

  test('⌘⌥A still archives — the chord archive moved to', async ({ page }) => {
    await page.goto(MD);
    await page.locator('.msg-assistant .content p').first().click();
    await page.keyboard.press(`${MOD}+Alt+a`);
    expect(await shortcutCalls(page)).toContain('archiveCurrent');
  });
});
