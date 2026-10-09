import { test, expect, type Page } from '@playwright/test';

// Screenshot markup (spec/14 § Composer — screenshot markup). Runs in a real
// browser because the claim is that actual canvas drawing (createImageBitmap,
// 2d context, toBlob) produces a real flattened image — jsdom can't back any
// of that; the unit tests in ImageAnnotator.test.tsx and Composer.test.tsx
// stub it out and only lock the surrounding wiring/logic.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

// A real solid-colour PNG at the given size (not a 1x1 stub) — the
// annotator's canvas takes its display size from the decoded image's own
// resolution, so a too-small fixture makes the on-screen canvas too small to
// reliably interact with in a test.
async function attachPng(
  page: Page,
  name: string,
  width: number,
  height: number,
  color: string,
): Promise<void> {
  const pngDataUrl = await page.evaluate(
    ([w, h, c]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w as number;
      canvas.height = h as number;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = c as string;
      ctx.fillRect(0, 0, w as number, h as number);
      return canvas.toDataURL('image/png');
    },
    [width, height, color],
  );
  const buffer = Buffer.from(pngDataUrl.split(',')[1]!, 'base64');
  await page.setInputFiles('[data-testid="composer-file-input"]', {
    name,
    mimeType: 'image/png',
    buffer,
  });
}

test.describe('Screenshot markup', () => {
  test('attach an image, draw a box, done replaces the thumbnail with a flattened annotated PNG', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await attachPng(page, 'shot.png', 300, 200, '#3d8bfd');

    const chip = page.getByTestId('composer-attachment');
    await expect(chip).toBeVisible();
    const originalSrc = await chip.locator('img').getAttribute('src');

    await chip.getByTestId('composer-attachment-markup').click();
    const editor = page.getByTestId('image-annotator');
    await expect(editor).toBeVisible();

    const canvas = page.getByTestId('annotator-canvas');
    const box = (await canvas.boundingBox())!;
    // Box tool is the default — drag a rectangle across the middle of the canvas.
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, { steps: 5 });
    await page.mouse.up();

    // Undo enables once a mark is committed — proof the drag actually landed a shape.
    await expect(page.getByLabel('Undo last mark')).toBeEnabled();

    await page.getByTestId('annotator-done').click();
    await expect(editor).toBeHidden();

    // The chip now shows the annotated file, with a different (flattened) preview.
    await expect(chip.locator('.att-name')).toHaveText('shot-annotated.png');
    const newSrc = await chip.locator('img').getAttribute('src');
    expect(newSrc).not.toBe(originalSrc);
  });

  test('a small image is scaled UP to fill the editor, not shown at its tiny native size', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await attachPng(page, 'tiny.png', 24, 16, '#e0393e');
    await page.getByTestId('composer-attachment').getByTestId('composer-attachment-markup').click();
    const canvas = page.getByTestId('annotator-canvas');
    const box = (await canvas.boundingBox())!;
    // Native size is 24x16 — a comfortable editor shows it far larger.
    expect(box.width).toBeGreaterThan(200);
  });

  // Regression: a click with the text tool mounts an autoFocus input at the
  // click point, but the canvas isn't focusable — an un-prevented mousedown's
  // default action blurs whatever just took focus, so the input fired onBlur
  // (committing an empty label and discarding itself) before a single
  // keystroke could land. Only reproduces with real browser focus semantics;
  // jsdom's fireEvent doesn't run default actions, so this only ever showed
  // up here, not in ImageAnnotator.test.tsx.
  test('the text tool places a label that survives to type into', async ({ page }) => {
    await page.goto(HARNESS);
    await attachPng(page, 'shot.png', 300, 200, '#3d8bfd');
    await page.getByTestId('composer-attachment').getByTestId('composer-attachment-markup').click();

    await page.getByLabel('Text tool').click();
    const canvas = page.getByTestId('annotator-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);

    const input = page.getByTestId('annotator-text-input');
    await expect(input).toBeVisible();
    await input.type('fix this');
    await expect(input).toHaveValue('fix this');
    await input.press('Enter');

    await expect(input).toBeHidden();
    await expect(page.getByLabel('Undo last mark')).toBeEnabled();
  });

  test('the pencil affordance only appears on image attachments, not files', async ({ page }) => {
    await page.goto(HARNESS);
    await page.setInputFiles('[data-testid="composer-file-input"]', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    const chip = page.getByTestId('composer-attachment');
    await expect(chip).toBeVisible();
    await expect(chip.getByTestId('composer-attachment-markup')).toHaveCount(0);
  });

  // Regression (Todoist: "patch drawing controls overlap the window
  // controls"): the annotator is portalled straight to <body>, so in the
  // Electron shell its toolbar sits at the window's own top-left — same strip
  // the traffic lights float over (top-bar-chrome.spec.ts) — and without an
  // inset its leftmost tool button drew directly under them.
  test('the toolbar clears the traffic lights when the desktop shell hides the title bar', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
    });
    await page.goto(HARNESS);
    await attachPng(page, 'shot.png', 300, 200, '#3d8bfd');
    await page.getByTestId('composer-attachment').getByTestId('composer-attachment-markup').click();
    await expect(page.getByTestId('image-annotator')).toBeVisible();

    // Same 84px strip top-bar-chrome.spec.ts checks the brand row against —
    // mirrors TRAFFIC_LIGHT_INSET in packages/desktop/src/window-chrome.ts.
    const boxTool = (await page.getByLabel('Box tool').boundingBox())!;
    expect(boxTool.x).toBeGreaterThanOrEqual(84);
  });

  test('the toolbar sits flush left when NOT running under the desktop shell', async ({ page }) => {
    await page.goto(HARNESS);
    await attachPng(page, 'shot.png', 300, 200, '#3d8bfd');
    await page.getByTestId('composer-attachment').getByTestId('composer-attachment-markup').click();
    await expect(page.getByTestId('image-annotator')).toBeVisible();

    // No shell, no traffic lights, so the inset must NOT apply here.
    const boxTool = (await page.getByLabel('Box tool').boundingBox())!;
    expect(boxTool.x).toBeLessThan(84);
  });
});
