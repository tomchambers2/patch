import { test, expect } from '@playwright/test';

// Real-browser round trip for the sidebar collapse chevron (Todoist, App
// Updates: "allow the sidebar to collapse, add chevron"; spec/14 § Sidebar
// §1, § Layout — desktop). The keyboard shortcut (⌘/) already toggled
// `sidebarCollapsed` — AppShell.test.tsx covers that — this proves the two
// visible chevrons that do the same thing by click: the sidebar's own `‹`
// collapse button, and the fixed `›` that appears at the shell's left edge
// once collapsed (Sidebar unmounts entirely, so it can't hold its own
// re-expand control).

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('sidebar collapse chevron', () => {
  test('clicking the collapse chevron hides the sidebar and reveals the expand chevron', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar-expand')).toHaveCount(0);

    await page.getByTestId('sidebar-collapse').click();

    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-expand')).toBeVisible();
  });

  test('clicking the expand chevron restores the sidebar', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-collapse').click();
    await expect(page.getByTestId('sidebar-expand')).toBeVisible();

    await page.getByTestId('sidebar-expand').click();

    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar-expand')).toHaveCount(0);
  });

  // Todoist, App Updates: "collapsed-sidebar expand button is a 22x26px target
  // flush to the window edge". It was the app's smallest control and the only
  // one left on screen once the sidebar is gone, at 22px wide — under the 24px
  // minimum — and butted against x=0 where the window frame competes for the
  // same pixels.
  //
  // Geometry alone is not the assertion. The button is out of flow over
  // `.chat-main`, so it can report a perfectly good bounding box while the
  // panel behind it owns the click (the failure mode `sidebar-header-overflow`
  // documents for the brand row). Both halves are checked below.
  test('the expand chevron is a full-size, inset, hit-testable target', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('sidebar-collapse').click();

    const expand = page.getByTestId('sidebar-expand');
    await expect(expand).toBeVisible();

    const box = await expand.boundingBox();
    expect(box).not.toBeNull();
    // 24px is the floor; the control is drawn at 28 so it is not sitting on it.
    expect(box!.width).toBeGreaterThanOrEqual(28);
    expect(box!.height).toBeGreaterThanOrEqual(28);
    // Inset from the shell's left edge rather than flush against it.
    expect(box!.x).toBeGreaterThan(0);

    // What the browser would actually deliver a click at the centre to. The
    // hit node is the inner <svg> as often as the button itself, so ask
    // whether the button CONTAINS it rather than comparing identity or
    // walking up to the nearest testid.
    const ownsItsCentre = await expand.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(ownsItsCentre).toBe(true);
  });
});
