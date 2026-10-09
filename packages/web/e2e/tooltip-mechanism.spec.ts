import { test, expect } from '@playwright/test';

// Real-browser e2e for TooltipHost (Todoist "patch icon tooltips are not
// working well" / spec/14 § Copy — Tooltips): the app draws its OWN tooltip
// rather than leaning on the browser's slow, unstyled, edge-clipping built-in
// one. Copy correctness is covered elsewhere (tooltip-copy.spec.ts); this
// covers the mechanism — it actually appears, on hover AND on keyboard focus,
// and it never runs off the edge of the window.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('the app tooltip', () => {
  test('appears on hover, names the control, and silences the native title meanwhile', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const editorBtn = page.getByTestId('action-editor');
    await expect(editorBtn).toBeVisible();
    await expect(editorBtn).toHaveAttribute('title', 'Editor');

    await editorBtn.hover();
    const tooltip = page.getByTestId('app-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText('Editor');
    // Only one tooltip may show at a time — the browser's own must be out of
    // the running while this one is up.
    await expect(editorBtn).not.toHaveAttribute('title', 'Editor');

    // Moving away restores it and takes the app tooltip back down.
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
    await expect(editorBtn).toHaveAttribute('title', 'Editor');
  });

  test('appears on keyboard focus, for a control reached without a pointer', async ({ page }) => {
    await page.goto(HARNESS);
    const editorBtn = page.getByTestId('action-editor');
    await expect(editorBtn).toBeVisible();

    await editorBtn.focus();
    const tooltip = page.getByTestId('app-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText('Editor');
  });

  test('never runs off the edge of the window', async ({ page }) => {
    await page.goto(HARNESS);
    // The ⋯ button is the rightmost icon on the action rail, flush against
    // the edge of the header — the one place in the harness a centred
    // tooltip would clip without the flip.
    const menu = page.getByTestId('action-more');
    await expect(menu).toBeVisible();

    await menu.hover();
    const tooltip = page.getByTestId('app-tooltip');
    await expect(tooltip).toBeVisible();

    const box = await tooltip.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
  });

  test('dismisses on Escape and on scroll', async ({ page }) => {
    await page.goto(HARNESS);
    const editorBtn = page.getByTestId('action-editor');
    await editorBtn.hover();
    const tooltip = page.getByTestId('app-tooltip');
    await expect(tooltip).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();

    // Move away and back — the pointer never left `editorBtn` for Escape, and
    // Playwright's hover is a no-op (no new mouseover) when it's already
    // there.
    await page.mouse.move(0, 0);
    await editorBtn.hover();
    await expect(tooltip).toBeVisible();
    // A wheel gesture over the (non-scrollable, in this harness view) header
    // proves nothing either way; dispatch the scroll event directly, which is
    // what a scroll ANYWHERE in the document — the sidebar list, the
    // transcript — actually fires, and what the capture-phase listener reacts
    // to regardless of which element it happens on.
    await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
    await expect(tooltip).toBeHidden();
  });
});
