import { test, expect, type Page } from '@playwright/test';

// spec/14 § Keyboard shortcuts — `⌘↵` commits the field being typed in; and
// § Discoverability — a control with a shortcut names it in its tooltip.
//
// Proved in a real browser because both halves are about the browser's own
// behaviour: a chord has to reach a field that is genuinely focused (jsdom fires
// keydown at whatever element it is told to), and the chord a tooltip prints
// comes from the platform the page is actually running on. This Chromium runs on
// Linux, so the un-doctored page is the non-Mac branch taken for real.
const FORKED = '/app/dev-harness.html?chat=chat_forked&ws=fake';

/** Frames the surface has sent, as the harness records them. */
async function sent(page: Page): Promise<Array<{ type: string; [k: string]: unknown }>> {
  return page.evaluate(() => (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent);
}

/** Pretend to be a Mac keyboard, at the only layer the app is allowed to read. */
async function asMacKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    });
  });
}

/** Open the second user turn's editor and return its field. */
async function openEditor(page: Page) {
  const turn = page.locator('.msg-user').nth(1);
  await turn.hover();
  await turn.getByTestId('msg-edit').click();
  const field = turn.getByTestId('msg-edit-input');
  await expect(field).toBeVisible();
  return { turn, field };
}

test.describe('⌘↵ saves an edited message', () => {
  test('the chord forks the turn, with no trip to the mouse', async ({ page }) => {
    await page.goto(FORKED);
    const { turn, field } = await openEditor(page);

    await field.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('rewritten by keyboard');
    await page.keyboard.press('Control+Enter');

    // Saved: the frame went out, and the editor closed behind it.
    await expect
      .poll(async () => (await sent(page)).filter((e) => e.type === 'chat.fork_request').length)
      .toBe(1);
    const fork = (await sent(page)).find((e) => e.type === 'chat.fork_request')!;
    expect(fork.message).toBe('rewritten by keyboard');
    await expect(turn.getByTestId('msg-edit-input')).toHaveCount(0);
  });

  test('the chord the Save button advertises is the one that works', async ({ page }) => {
    await page.goto(FORKED);
    const { field } = await openEditor(page);
    // What it promises…
    await expect(page.getByTestId('msg-edit-save-chord').first()).toHaveText('Ctrl+Enter');
    // …is what it does.
    await field.click();
    await page.keyboard.press('Control+Enter');
    await expect
      .poll(async () => (await sent(page)).filter((e) => e.type === 'chat.fork_request').length)
      .toBe(1);
  });

  test('bare ↵ types a newline instead — a turn can be several lines', async ({ page }) => {
    await page.goto(FORKED);
    const { field } = await openEditor(page);
    await field.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('first line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second line');

    await expect(field).toHaveValue('first line\nsecond line');
    expect((await sent(page)).filter((e) => e.type === 'chat.fork_request')).toEqual([]);
  });

  test('the chord tag sits inside the button, on the label’s own line', async ({ page }) => {
    await page.goto(FORKED);
    await openEditor(page);
    const boxes = await page
      .getByTestId('msg-edit-save')
      .first()
      .evaluate((btn) => {
        const chord = btn.querySelector('[data-testid="msg-edit-save-chord"]');
        if (!chord) throw new Error('no chord tag');
        const b = btn.getBoundingClientRect();
        const c = chord.getBoundingClientRect();
        return {
          btn: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height },
          chord: { top: c.top, bottom: c.bottom, left: c.left, right: c.right, height: c.height },
        };
      });
    expect(boxes.chord.height).toBeGreaterThan(6);
    expect(boxes.chord.top).toBeGreaterThanOrEqual(boxes.btn.top - 0.5);
    expect(boxes.chord.bottom).toBeLessThanOrEqual(boxes.btn.bottom + 0.5);
    expect(boxes.chord.right).toBeLessThanOrEqual(boxes.btn.right + 0.5);
    // Right OF the label, and one line only.
    expect(boxes.chord.left).toBeGreaterThan(boxes.btn.left);
    expect(boxes.btn.height).toBeLessThan(40);
  });
});

test.describe('tooltips carry their shortcut', () => {
  test('every control with a chord names it, for THIS keyboard', async ({ page }) => {
    await page.goto(FORKED);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute(
      'title',
      'Collapse sidebar (Ctrl+/)',
    );
    await expect(page.getByTestId('new-chat-fab')).toHaveAttribute('title', 'Ctrl+N');
    // New chat is the one labelled button whose shortcut is tooltip-only — no
    // inline chord tag (spec/14 § Discoverability).
    await expect(page.getByTestId('new-chat-fab-chord')).toHaveCount(0);
    await expect(page.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived (Ctrl+Shift+A)',
    );
    await expect(page.getByTestId('action-archive')).toHaveAttribute(
      'title',
      'Archive (Ctrl+Alt+A)',
    );
    await expect(page.getByTestId('send-btn')).toHaveAttribute('title', 'Send (Enter)');
  });

  test('a Mac keyboard is told about ⌘, not Ctrl', async ({ page }) => {
    await asMacKeyboard(page);
    await page.goto(FORKED);
    await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute(
      'title',
      'Collapse sidebar (⌘/)',
    );
    await expect(page.getByTestId('action-archive')).toHaveAttribute('title', 'Archive (⌘⌥A)');
    await expect(page.getByTestId('new-chat-fab')).toHaveAttribute('title', '⌘N');
    await expect(page.getByTestId('new-chat-fab-chord')).toHaveCount(0);
  });
});
