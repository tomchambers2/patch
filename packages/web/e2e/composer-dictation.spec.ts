import { test, expect, type Locator } from '@playwright/test';

// Real-browser e2e for composer dictation (spec/07 § 4): a hands-free toggle
// session is ended by a GESTURE, never by silence. Runs against the dev harness
// with `/api/voice/transcribe` stubbed — no host needed.
//
// The mic itself is the one thing stubbed, at the hardware boundary only: this
// machine has no audio device, so Chromium can't enumerate even its own fake
// one (getUserMedia → NotFoundError). `getUserMedia` is therefore replaced with
// a REAL MediaStream produced by Web Audio, left unconnected so it carries
// genuine silence. Everything the test is actually about — the component, its
// timers, the real recorder reading real (silent) samples — runs for real.
const SILENT_MIC = `
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    return dest.stream; // nothing connected to it → silence
  };
`;

const CHAT = '/app/dev-harness.html?chat=thread_manager';

/** Longer than any auto-stop window a dictation session might carry. */
const LONG_PAUSE_MS = 13_000;

/**
 * A genuine QUICK TAP on the mic.
 *
 * The composer reads the gesture from how long the button was held: under
 * `TAP_THRESHOLD_MS` (220ms) is a tap that opens a sustained dictation session,
 * over it is a press-and-hold whose release COMMITS. Playwright's `click()`
 * does not control that gap — on a loaded box the scheduling between its
 * mousedown and mouseup drifted past 220ms, the composer correctly read a hold,
 * committed the session, and the test failed claiming silence had ended it.
 * Dispatching both events in one page-side call makes the held time ~0ms, so
 * the gesture is unambiguously the one this test means, whatever the machine
 * is doing.
 */
async function quickTap(mic: Locator): Promise<void> {
  await mic.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

test.describe('composer dictation — silence never ends the session', () => {
  test('a toggle session survives a long silence and commits only on the second tap', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(SILENT_MIC);
    await page.route('**/api/voice/transcribe*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'still listening' }),
      }),
    );

    await page.goto(CHAT);
    const mic = page.getByTestId('voice-note-btn');
    const input = page.getByTestId('composer-input');

    // Quick tap → hands-free toggle session.
    await quickTap(mic);
    await expect(mic).toHaveAttribute('aria-pressed', 'true');

    // Say nothing at all for well over the old auto-stop window. Pausing to
    // think mid-sentence must not commit the words already dictated.
    await page.waitForTimeout(LONG_PAUSE_MS);
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toHaveValue('');

    // The second tap is what ends it — transcript lands in the input, editable.
    await quickTap(mic);
    await expect(input).toHaveValue('still listening');
  });
});
