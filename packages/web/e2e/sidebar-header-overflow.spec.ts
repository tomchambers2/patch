import { test, expect } from '@playwright/test';

// spec/14 § Sidebar §1: the brand row's right-hand cluster (connection dot,
// "open sidebar in new window", collapse chevron) is sidebar chrome and must
// stay inside the sidebar at EVERY width the user can drag it to.
//
// This can only be proven in a real browser. `.sb-brand` is a flex row whose
// left item `.brand-row` defaults to `min-width: auto`, so it refuses to shrink
// below its content and pushes `.sb-brand-right` past the sidebar's right edge.
// `.sb` is `overflow: hidden` + `contain: layout paint`, so the overflowing
// controls are not merely ugly — they are clipped away and stop hit-testing:
// `elementFromPoint` over the collapse chevron returns the chat header behind
// it. jsdom has no layout, so only a real browser catches this.
//
// Two independent triggers, both covered below:
//  1. The `LOCAL · host` dev badge (`nowrap`, non-shrinking) blows the row out
//     at the DEFAULT 280px width — which is why local review could never click
//     the collapse chevron.
//  2. Even with no badge at all, the row overflows at the 200px MINIMUM width
//     that `uiStore.setSidebarWidth` clamps to — so this clips in production.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

/** Drag the sidebar to `w` px via the real store, and wait for layout to settle. */
async function setSidebarWidth(page: import('@playwright/test').Page, w: number): Promise<void> {
  await page.evaluate((width) => {
    (
      window as unknown as {
        __uiStore: { getState: () => { setSidebarWidth: (n: number) => void } };
      }
    ).__uiStore
      .getState()
      .setSidebarWidth(width);
  }, w);
  await expect(page.getByTestId('sidebar')).toHaveJSProperty('offsetWidth', w);
}

/**
 * What the browser would actually deliver a click at the centre of `testId` to.
 * Returns the `data-testid` of the topmost element there, walking up from the
 * hit node so a click landing on the button's inner <svg> still resolves to the
 * button. `null` when the point belongs to something else entirely.
 */
async function hitTestId(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<string | null> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return page.evaluate(
    ([x, y]) => {
      let el = document.elementFromPoint(x, y);
      while (el) {
        const id = el.getAttribute('data-testid');
        if (id) return id;
        el = el.parentElement;
      }
      return null;
    },
    [box.x + box.width / 2, box.y + box.height / 2] as const,
  );
}

test.describe('sidebar brand-row overflow', () => {
  test('the header controls stay inside the sidebar at the default width', async ({ page }) => {
    await page.goto(HARNESS);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // The dev badge is present here (the harness IS the vite dev server), which
    // is exactly the condition that used to push the cluster out of the box.
    await expect(page.getByTestId('dev-source-badge')).toBeVisible();

    const sbBox = (await sidebar.boundingBox())!;
    const rightCluster = page.locator('.sb-brand-right');
    const clusterBox = (await rightCluster.boundingBox())!;

    // The whole cluster is within the sidebar's own box. Before the fix its
    // right edge measured ~420 inside a 280px sidebar.
    expect(clusterBox.x).toBeGreaterThanOrEqual(sbBox.x);
    expect(clusterBox.x + clusterBox.width).toBeLessThanOrEqual(sbBox.x + sbBox.width);
  });

  test('the collapse chevron and new-window button are really clickable, not just laid out', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // Hit-testing is the assertion that matters: `overflow: hidden` means an
    // out-of-bounds button can still report a bounding box while receiving no
    // pointer events at all.
    expect(await hitTestId(page, 'sidebar-open-window')).toBe('sidebar-open-window');
    expect(await hitTestId(page, 'sidebar-collapse')).toBe('sidebar-collapse');

    // And the click round-trips, without `force`.
    await page.getByTestId('sidebar-collapse').click();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-expand')).toBeVisible();
  });

  test('the dev badge yields width instead of pushing the controls out', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    const badge = page.getByTestId('dev-source-badge');

    // The badge is the flexible one: it truncates itself rather than growing
    // the row. Its title attribute still carries the full origin, so nothing
    // is actually lost.
    await expect(badge).toHaveAttribute('title', /Local review mode: http/);

    const brandRow = page.locator('.brand-row');
    const sbBox = (await page.getByTestId('sidebar').boundingBox())!;
    const rowBox = (await brandRow.boundingBox())!;
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(sbBox.x + sbBox.width);

    // The brand mark keeps its full size — the badge absorbs the shrink, it
    // doesn't. The product name is NOT truncated at the stock width: flex
    // splits a deficit proportionally, so when the mark had any shrink factor
    // at all it came out a fraction of a pixel under its own `scrollWidth` and
    // rendered as `pat…`. Measured against the CLIPPING row as well as against
    // itself — `.brand-row` is `overflow: hidden`, so a mark that overruns it
    // is painted away while its own `scrollWidth` looks perfectly healthy.
    const mark = page.locator('.brand-mark');
    await expect(mark).toHaveText('patch');
    expect(await mark.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const markBox = (await mark.boundingBox())!;
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  });

  test('the controls still win at the 200px MINIMUM sidebar width', async ({ page }) => {
    // The production case: no dev badge in the deployed bundle, but the cluster
    // measured 207px against a 200px floor, so it clipped there too.
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await setSidebarWidth(page, 200);

    const sbBox = (await page.getByTestId('sidebar').boundingBox())!;
    const clusterBox = (await page.locator('.sb-brand-right').boundingBox())!;
    expect(clusterBox.x + clusterBox.width).toBeLessThanOrEqual(sbBox.x + sbBox.width);

    // Still hit-testable at the narrowest the user can drag to.
    expect(await hitTestId(page, 'sidebar-collapse')).toBe('sidebar-collapse');
    expect(await hitTestId(page, 'sidebar-open-window')).toBe('sidebar-open-window');
    expect(await hitTestId(page, 'conn-dot')).toBe('conn-dot');

    // The cluster is never the thing that shrinks: all three controls keep
    // their full size at the minimum width.
    const collapseBox = (await page.getByTestId('sidebar-collapse').boundingBox())!;
    expect(collapseBox.width).toBeGreaterThanOrEqual(26);

    // By here the badge has stood down entirely rather than surviving as a
    // border-cut stub. The wordmark and its dot are the only other tenants of
    // the row (§ Chat panel header took Back / Forward), so at 200px it now
    // fits whole — and either way it is never painted past the row's right
    // edge, which is the thing that actually reads as broken.
    await expect(page.getByTestId('dev-source-badge')).toBeHidden();
    const mark = page.locator('.brand-mark');
    await expect(mark).toHaveText('patch');
    const markBox = (await mark.boundingBox())!;
    const rowBox = (await page.locator('.brand-row').boundingBox())!;
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    const dotBox = (await page.getByTestId('conn-dot').boundingBox())!;
    expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  });

  test('the badge survives at the stock width — it is the only "you are on local" signal', async ({
    page,
  }) => {
    // The badge yields width, but hiding it at the DEFAULT 280px would delete
    // the feature: it is the one thing distinguishing local-latest from the
    // deployed build. It only stands down near the 200px floor.
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('dev-source-badge')).toBeVisible();
    await setSidebarWidth(page, 260);
    await expect(page.getByTestId('dev-source-badge')).toBeVisible();
    await setSidebarWidth(page, 240);
    await expect(page.getByTestId('dev-source-badge')).toBeHidden();
  });

  test('a wide sidebar is unaffected — the badge takes its natural width back', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    const badge = page.getByTestId('dev-source-badge');

    await setSidebarWidth(page, 260);
    const narrow = (await badge.boundingBox())!.width;

    await setSidebarWidth(page, 600);
    const wide = (await badge.boundingBox())!.width;

    // Shrinking is a response to pressure, not a permanent cap.
    expect(wide).toBeGreaterThan(narrow);
    // With room to spare the badge is no longer truncated.
    expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // And the cluster is still inside the box at the maximum width.
    const sbBox = (await page.getByTestId('sidebar').boundingBox())!;
    const clusterBox = (await page.locator('.sb-brand-right').boundingBox())!;
    expect(clusterBox.x + clusterBox.width).toBeLessThanOrEqual(sbBox.x + sbBox.width);
  });
});
