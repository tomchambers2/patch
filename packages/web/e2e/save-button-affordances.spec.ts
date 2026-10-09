import { test, expect, type Page } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// The file editor's Save, as a button (Tom, App Updates: "patch save button is
// not a real button").
//
// `.browse-actions` and `.diff-panel-actions` share their layout rule but only
// the diff one styled its buttons, so Save fell through to the preflight reset:
// transparent, unbordered, unpadded, with a default cursor — a run of body text
// that happened to be clickable — and no commit control in the app carried a
// focus ring. Only a real browser has a cascade, so the look and the keyboard
// journey are pinned here; the stylesheet's source is locked in
// src/__tests__/saveControls.test.tsx.
//
// `?editor=browse` mounts the real EditorRail against the stubbed file API.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse&ws=fake';

// Monaco is a big lazy chunk — the same headroom the other editor specs give
// its mount, for the same reason (several workers sharing the box).
const MONACO_MOUNT = { timeout: 20_000 };

/** Inter-keystroke delay the real Monaco keeps up with on a loaded box. */
const TYPE_DELAY_MS = 150;
const TYPE_ATTEMPTS = 3;

async function fileWrites(page: Page): Promise<Array<Extract<WireEvent, { type: 'file.write' }>>> {
  return page.evaluate(() =>
    (window as unknown as { __wsSent: WireEvent[] }).__wsSent.filter(
      (e): e is Extract<WireEvent, { type: 'file.write' }> => e.type === 'file.write',
    ),
  );
}

/** What the REAL Monaco model holds — its own state, not scraped token spans. */
async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (
      window as unknown as { monaco?: { editor: { getEditors(): Array<{ getValue(): string }> } } }
    ).monaco;
    return monaco?.editor.getEditors()[0]?.getValue() ?? '';
  });
}

/** Open a file; Save is dead until something is edited. */
async function openFile(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByTestId('tree-row-foo.ts').click();
  const pane = page.getByTestId('browse-editor');
  await expect(pane.locator('.monaco-editor').first()).toBeVisible(MONACO_MOUNT);
  // The stub's content lands AFTER mount; wait for a known line before typing
  // or the keystrokes scatter across a re-render.
  await expect(pane.getByText('const line0 = 0;')).toBeVisible(MONACO_MOUNT);
}

/** Open a file and dirty it, which is the only state in which Save is live. */
async function openDirtyFile(page: Page, text = 'zzqqzz'): Promise<void> {
  await openFile(page);
  const monaco = page.getByTestId('browse-editor').locator('.monaco-editor').first();
  // Monaco takes keystrokes through a hidden textarea and drops them when they
  // outpace its re-render, so type slowly and CHECK what landed — a dropped
  // character still dirties the buffer, so `toBeEnabled()` would sail past it.
  for (let attempt = 1; attempt <= TYPE_ATTEMPTS; attempt++) {
    await monaco.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
    if ((await editorValue(page)) === text) break;
    if (attempt === TYPE_ATTEMPTS) {
      throw new Error(`Monaco kept dropping keystrokes: editor holds ${await editorValue(page)}`);
    }
  }
  await expect(page.getByTestId('browse-save')).toBeEnabled();
}

test('Save is drawn as a control, not as a run of body text', async ({ page }) => {
  await openDirtyFile(page);
  const save = page.getByTestId('browse-save');

  const look = await save.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      cursor: cs.cursor,
      background: cs.backgroundColor,
      borderWidth: cs.borderTopWidth,
      radius: cs.borderTopLeftRadius,
      padding: cs.paddingTop + ' ' + cs.paddingLeft,
    };
  });
  expect(look.cursor).toBe('pointer');
  expect(look.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(look.borderWidth).not.toBe('0px');
  expect(look.radius).not.toBe('0px');
  expect(look.padding).not.toBe('0px 0px');

  // A target to hit, not a word to aim at.
  const box = (await save.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(30);
  expect(box.width).toBeGreaterThanOrEqual(48);
});

test('with nothing to save it reads as dead rather than merely doing nothing', async ({ page }) => {
  await openFile(page);
  const save = page.getByTestId('browse-save');
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS('cursor', 'default');
  // Still a button, just a spent one — dimmed rather than stripped back to the
  // text it used to look like whether or not there was anything to commit.
  await expect(save).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(Number(await save.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
});

test('Save is reachable from the keyboard and shows where the cursor is', async ({ page }) => {
  await openDirtyFile(page);
  const save = page.getByTestId('browse-save');

  // Real focus, not a styled div pretending: the element the document reports
  // as active is this button.
  await save.focus();
  expect(await save.evaluate((el) => document.activeElement === el)).toBe(true);
  await expect(save).toBeFocused();

  const ring = await save.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: cs.outlineWidth, style: cs.outlineStyle, colour: cs.outlineColor };
  });
  expect(ring.style).toBe('solid');
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  // It is the app's accent ring, not the UA's. The token is compared by
  // painting it and reading it back, since the computed outline is an rgb().
  const accentRgb = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(ring.colour).toBe(accentRgb);
});

test('Enter on the focused Save commits the file, exactly as clicking it would', async ({
  page,
}) => {
  await openDirtyFile(page, 'qqzzqq');
  const save = page.getByTestId('browse-save');

  await save.focus();
  await page.keyboard.press('Enter');

  // The keyboard reaches the real save path, not just the styling of one.
  await expect.poll(async () => (await fileWrites(page)).length).toBe(1);
  const write = (await fileWrites(page))[0]!;
  expect(write).toMatchObject({ type: 'file.write', chatId: 'chat_bus', path: 'foo.ts' });
  expect(write.content).toBe('qqzzqq');
});

test('Space on the focused Save commits it too', async ({ page }) => {
  await openDirtyFile(page, 'wwvvww');
  const save = page.getByTestId('browse-save');

  await save.focus();
  await page.keyboard.press('Space');

  await expect.poll(async () => (await fileWrites(page)).length).toBe(1);
  expect((await fileWrites(page))[0]!.content).toBe('wwvvww');
});
