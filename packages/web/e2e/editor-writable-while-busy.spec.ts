import { test, expect, type Page } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// Real-browser proof that the in-app editor is writable while the chat's agent
// is mid-turn (spec/14 § Editor — "Editable whatever the chat is doing").
//
// `chat_bus` is seeded with `activity: 'running'` (dev-harness.tsx), which is
// exactly the state that used to mount Monaco read-only and disable Save. The
// unit tests assert this against a mocked `@monaco-editor/react`; only a real
// browser proves the REAL Monaco actually accepts typing in that state.
const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse&ws=fake';

// Monaco is a big lazy chunk — the same headroom editor-browse-layout.spec.ts
// gives its mount, for the same reason (four workers sharing the box).
const MONACO_MOUNT = { timeout: 20_000 };

async function fileWrites(page: Page): Promise<Array<Extract<WireEvent, { type: 'file.write' }>>> {
  return page.evaluate(() =>
    (window as unknown as { __wsSent: WireEvent[] }).__wsSent.filter(
      (e): e is Extract<WireEvent, { type: 'file.write' }> => e.type === 'file.write',
    ),
  );
}

// How many times to retype before calling it a real failure. Two is enough for
// a dropped character; a third attempt failing means something other than
// keystroke timing is wrong and the test should say so loudly.
const TYPE_ATTEMPTS = 3;

/** Inter-keystroke delay Monaco can actually keep up with on a loaded box. */
const TYPE_DELAY_MS = 150;

/**
 * What the REAL Monaco model currently holds. `window.monaco` is the bundled
 * instance the app hands to @monaco-editor/loader (src/lib/monaco-loader.ts),
 * so this reads the editor's own state rather than scraping token spans out of
 * the DOM.
 */
async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (
      window as unknown as {
        monaco?: { editor: { getEditors(): Array<{ getValue(): string }> } };
      }
    ).monaco;
    const editor = monaco?.editor.getEditors()[0];
    return editor ? editor.getValue() : '';
  });
}

/** Poll the model until it reads `want`, then report whatever it settled on. */
async function settledEditorValue(page: Page, want: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  let value = await editorValue(page);
  while (value !== want && Date.now() < deadline) {
    await page.waitForTimeout(100);
    value = await editorValue(page);
  }
  return value;
}

// Open the browse editor on foo.ts and replace its whole contents by typing
// into the REAL Monaco. Returns the Save button.
//
// Monaco renders a line as several token spans, so the typed text is not
// reliably matchable with getByText — Save flipping to enabled is the
// observable proof that Monaco took the keystrokes and fired onChange (it is
// driven by `draft !== on-disk content`, and a read-only Monaco swallows input
// so the draft would never diverge).
async function typeIntoEditor(page: Page, text: string) {
  await page.getByTestId('tree-row-foo.ts').click();
  const editorPane = page.getByTestId('browse-editor');
  const monaco = editorPane.locator('.monaco-editor').first();
  await expect(monaco).toBeVisible(MONACO_MOUNT);

  // Wait for the file's content to actually be IN the editor before typing.
  // The content arrives from a stubbed fetch, and under a loaded machine it can
  // land after the first keystroke — Monaco then re-renders and moves the
  // cursor, scattering the token across the file.
  await expect(editorPane.getByText('const line0 = 0;')).toBeVisible(MONACO_MOUNT);

  const save = page.getByTestId('browse-save');
  await expect(save).toBeDisabled(); // nothing edited yet

  // Select-all then type, so the result does not depend on where the click put
  // the cursor: the document becomes exactly `text`. (Do NOT press Escape to
  // dismiss Monaco's suggest widget — Esc belongs to the rail and closes the
  // file browser.) Typed with a delay because Monaco takes keystrokes through a
  // hidden textarea and drops them when they outpace its re-render.
  //
  // The delay is load-sensitive and 30ms was far too fast for this box. Measured
  // on it, typing "zzqqzz" into the real Monaco under four parallel workers:
  // 30ms lost a character every single run (0/4 correct), while 150ms and 400ms
  // were perfect (4/4 each). The characters went missing at arbitrary positions,
  // and because Save enables on ANY divergence from the on-disk content, a short
  // document sailed past `toBeEnabled()` and only surfaced at the end as a
  // `file.write` whose content was missing a letter — which reads as a product
  // bug rather than a lost keystroke.
  //
  // So: type slowly enough that Monaco keeps up, and then CHECK what actually
  // landed rather than assuming, retyping if it came up short. This is still the
  // real typing path, which is what this test exists to prove.
  for (let attempt = 1; attempt <= TYPE_ATTEMPTS; attempt++) {
    await monaco.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
    const landed = await settledEditorValue(page, text);
    if (landed === text) break;
    if (attempt === TYPE_ATTEMPTS) {
      throw new Error(
        `Monaco kept dropping keystrokes after ${TYPE_ATTEMPTS} attempts: ` +
          `wanted ${JSON.stringify(text)}, editor holds ${JSON.stringify(landed)}`,
      );
    }
  }
  await expect(save).toBeEnabled();
  return save;
}

test.describe('editor is writable while the chat is running', () => {
  test('real Monaco accepts typing and Save emits file.write with the edit', async ({ page }) => {
    await page.goto(HARNESS);

    // Sanity: this chat really is busy — the sidebar's working badge only
    // renders while it is running. Without this the seed could flip to idle
    // and the test would silently stop proving anything.
    await expect(page.getByTestId('chat-row-chat_bus').getByTestId('badge-working')).toBeVisible();

    // No read-only badge on a busy chat any more.
    await expect(page.getByTestId('browse-readonly')).toHaveCount(0);

    const save = await typeIntoEditor(page, 'zzqqzz');
    await save.click();

    await expect.poll(async () => (await fileWrites(page)).length).toBe(1);
    const write = (await fileWrites(page))[0]!;
    expect(write).toMatchObject({ type: 'file.write', chatId: 'chat_bus', path: 'foo.ts' });
    // Select-all + type replaced the file, so the committed content is exactly
    // what was typed — nothing of the original survives.
    expect(write.content).toBe('zzqqzz');
  });

  test('⌘S saves while the chat is running', async ({ page }) => {
    await page.goto(HARNESS);

    await typeIntoEditor(page, 'qqzzqq');
    await page.keyboard.press('ControlOrMeta+s');

    await expect.poll(async () => (await fileWrites(page)).length).toBe(1);
    expect((await fileWrites(page))[0]!.content).toBe('qqzzqq');
  });
});
