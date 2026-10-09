import { test, expect } from '@playwright/test';

// Real-browser e2e for the ⌘; / ⌃Space voice chords (spec/07 § 4 — mode 1).
//
// jsdom dispatches whatever KeyboardEvent a test hands it. A real browser
// decides for itself which keydown/keyup pairs a chord produces, which is the
// part that actually broke: the release is what tells the app whether the user
// tapped or held, so it has to arrive exactly once no matter which key of the
// chord the user lifts first.
//
// The harness records which shortcut actions fired on `window.__shortcutCalls`.

const CHAT = '/app/dev-harness.html?chat=thread_manager';

async function calls(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __shortcutCalls: string[] }).__shortcutCalls);
}

test.describe('voice hotkey chords', () => {
  test('⌘; opens a note and reports exactly one release, whichever key lifts first', async ({
    page,
  }) => {
    await page.goto(CHAT);
    await page.waitForFunction(
      () => (window as unknown as { __shortcutCalls?: string[] }).__shortcutCalls !== undefined,
    );

    // Lift the character key first, then the modifier.
    await page.keyboard.down('Meta');
    await page.keyboard.down(';');
    await page.keyboard.up(';');
    await page.keyboard.up('Meta');
    expect(await calls(page)).toEqual(['voiceHoldStart', 'voiceHoldEnd']);

    // Lift the MODIFIER first. macOS withholds the ';' keyup while ⌘ is down,
    // so the modifier's release has to end the chord — and the ';' keyup that
    // may follow must not end it a second time and commit twice.
    await page.evaluate(() => {
      (window as unknown as { __shortcutCalls: string[] }).__shortcutCalls.length = 0;
    });
    await page.keyboard.down('Meta');
    await page.keyboard.down(';');
    await page.keyboard.up('Meta');
    await page.keyboard.up(';');
    expect(await calls(page)).toEqual(['voiceHoldStart', 'voiceHoldEnd']);
  });

  test('⌃Space opens a global note and reports exactly one release', async ({ page }) => {
    await page.goto(CHAT);
    await page.waitForFunction(
      () => (window as unknown as { __shortcutCalls?: string[] }).__shortcutCalls !== undefined,
    );

    await page.keyboard.down('Control');
    await page.keyboard.down(' ');
    await page.keyboard.up('Control');
    await page.keyboard.up(' ');
    expect(await calls(page)).toEqual(['globalVoiceStart', 'globalVoiceEnd']);
  });
});
