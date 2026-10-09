import { test, expect } from '@playwright/test';

// Real-browser e2e for narrow-width layout (spec/14 § Layout → Narrow widths).
// Todoist: "stop the ugly horizontal scrolling at narrower widths".
//
// `.three-col` is a flex row where `.sb` (sidebar) is `flex-shrink: 0`; only
// `.chat-main` shrinks. At narrow viewports that used to force the page wider
// than the window — a page-level horizontal scrollbar. The fix: below 768px
// the sidebar auto-collapses (reusing the existing manual `sidebarCollapsed`
// toggle), and the chat header's action-icon row is allowed to shrink instead
// of imposing a hard floor on `.chat-main`. (The docked editor rail this
// suite also used to narrow-collapse is gone — spec/14 § Panes and tabs: its
// panes are already flex children that shrink with the window, the same as
// `.chat-main`, so there is nothing left to auto-close.) The invariant this
// suite exists to prove: at NO width down to ~375px does
// `document.documentElement.scrollWidth` exceed `window.innerWidth`.
//
// The action-icon row itself used to scroll within its own bounds once it
// couldn't fit; App Updates later asked for that to become a hamburger
// dropdown instead (`.chat-head-actions`'s `@container` rule in index.css) —
// covered below in "the chat-header action icons collapse into a hamburger".

function noHorizontalOverflow(page: import('@playwright/test').Page): Promise<{
  scrollWidth: number;
  innerWidth: number;
}> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

test.describe('narrow-width layout', () => {
  test('no page-level horizontal scroll at 375px, 700px or 900px, with the sidebar open at load', async ({
    page,
  }) => {
    for (const width of [375, 700, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/app/dev-harness.html?chat=chat_bus');
      await expect(page.locator('.chat-head')).toBeVisible();
      const { scrollWidth, innerWidth } = await noHorizontalOverflow(page);
      expect(scrollWidth, `width=${width}`).toBeLessThanOrEqual(innerWidth);
    }
  });

  test('below 768px the sidebar auto-collapses on load', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
  });

  // The narrow case is where the expand chevron matters most: the sidebar
  // collapses without the user asking, so this button is the whole route back
  // to it, and here it floats over a chat panel that has the FULL window width
  // (drawer mode, § Narrow widths) rather than a column beside it. Its sizing
  // is locked in `sidebar-collapse.spec.ts`; what is specific to this width is
  // that a full-width `.chat-main` underneath doesn't take the click.
  test('at 375px the auto-collapsed expand chevron is still inset and takes its own click', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const expand = page.getByTestId('sidebar-expand');
    await expect(expand).toBeVisible();

    const box = await expand.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.width).toBeGreaterThanOrEqual(28);

    const ownsItsCentre = await expand.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(ownsItsCentre).toBe(true);

    // And it really does restore the sidebar from here, without `force`.
    await expand.click();
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('resizing live below 768px collapses the sidebar, and resizing back above does not fight a manual re-expand', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // Live resize below the breakpoint auto-collapses.
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.getByTestId('sidebar')).toHaveCount(0);

    // The user deliberately reopens it while still narrow — the same call the
    // real ⌘/ toggle makes (`window.__uiStore`, exposed by the harness; the
    // harness's own shortcut wiring only records calls for other specs, so
    // this drives the actual store the way the real toggle would).
    await page.evaluate(() => {
      (
        window as unknown as {
          __uiStore: { getState: () => { setSidebarCollapsed(v: boolean): void } };
        }
      ).__uiStore
        .getState()
        .setSidebarCollapsed(false);
    });
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // A further resize that stays on the SAME (narrow) side of the breakpoint
    // must not immediately re-collapse the manual choice.
    await page.setViewportSize({ width: 690, height: 800 });
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('the chat-header action icons collapse into a hamburger at 375px rather than shrinking or scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const actions = page.getByTestId('chat-head-actions');
    await expect(actions).toBeVisible();
    const actionsBox = (await actions.boundingBox())!;
    // The action row itself never exceeds the viewport width.
    expect(actionsBox.width).toBeLessThanOrEqual(375);

    // Too narrow for the full rail: the individual icons are hidden and a
    // single hamburger trigger takes their place.
    await expect(page.getByTestId('head-action-rail')).not.toBeVisible();
    const hamburger = page.getByTestId('action-hamburger');
    await expect(hamburger).toBeVisible();
    // It keeps the same real tap size as any other header icon (32px), not squashed.
    const iconBox = (await hamburger.boundingBox())!;
    expect(iconBox.width).toBeGreaterThanOrEqual(28);

    // Opening it reveals every action, labelled.
    await hamburger.click();
    await expect(page.getByTestId('head-hamburger-menu')).toBeVisible();
    await expect(page.getByTestId('hamburger-archive')).toBeVisible();
  });

  test('at 1280px (plenty of room) the full icon rail shows directly and the hamburger stays hidden', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('head-action-rail')).toBeVisible();
    await expect(page.getByTestId('action-archive')).toBeVisible();
    await expect(page.getByTestId('action-hamburger')).not.toBeVisible();
  });
});

// The sidebar reopened while narrow is a DRAWER, not a column (spec/14 § Layout
// → Narrow widths). The auto-collapse above is one-directional on purpose, so
// reopening at 375px was supported but left `.sb` in the flex flow taking its
// full 280px off a 375px window — `.chat-main` came out 95px wide and the
// composer rendered as a 55px stub with its buttons pushed out of the window.
test.describe('narrow-width sidebar drawer', () => {
  // The manual re-expand the user makes with `⌘ /` or the `›` chevron.
  async function reopenSidebar(page: import('@playwright/test').Page): Promise<void> {
    await page.evaluate(() => {
      (
        window as unknown as {
          __uiStore: { getState: () => { setSidebarCollapsed(v: boolean): void } };
        }
      ).__uiStore
        .getState()
        .setSidebarCollapsed(false);
    });
    await expect(page.getByTestId('sidebar')).toBeVisible();
  }

  test('reopened at 375px it overlays the chat panel instead of crushing it', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await reopenSidebar(page);

    const chatMain = (await page.getByTestId('chat-main').boundingBox())!;
    const sb = (await page.getByTestId('sidebar').boundingBox())!;

    // The chat column keeps the window, rather than being pushed to ~95px.
    expect(chatMain.width).toBeGreaterThan(360);
    // The sidebar is drawn OVER it (both start at the shell's left edge).
    expect(sb.x).toBeLessThan(chatMain.x + 1);
    expect(sb.x + sb.width).toBeGreaterThan(chatMain.x);
  });

  test('the composer stays usable behind the drawer rather than collapsing to a stub', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    await reopenSidebar(page);

    const composer = (await page.getByTestId('composer').boundingBox())!;
    // Was 55px wide with its buttons overflowing the window.
    expect(composer.width).toBeGreaterThan(300);
    expect(composer.x + composer.width).toBeLessThanOrEqual(375);
  });

  test('the drawer is capped so the chat stays visible beside it, however wide the sidebar was dragged', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    // Dragged out to the 600px ceiling at some earlier, wider session.
    await page.evaluate(() => {
      (
        window as unknown as {
          __uiStore: { getState: () => { setSidebarWidth(v: number): void } };
        }
      ).__uiStore
        .getState()
        .setSidebarWidth(600);
    });
    await reopenSidebar(page);

    const sb = (await page.getByTestId('sidebar').boundingBox())!;
    expect(sb.width).toBeLessThan(375);
  });

  test('a dimmed backdrop covers the chat panel and tapping it closes the drawer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    await reopenSidebar(page);

    const backdrop = page.getByTestId('sidebar-backdrop');
    await expect(backdrop).toBeVisible();
    // It sits UNDER the drawer, so the drawer stays clickable.
    const box = (await backdrop.boundingBox())!;
    expect(box.width).toBeGreaterThan(360);

    // Tap the strip of backdrop the cap leaves exposed beside the drawer.
    await backdrop.click({ position: { x: 360, y: 400 } });
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-backdrop')).not.toBeVisible();
  });

  test('the drawer is not drag-resizable — its divider is not drawn', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    await reopenSidebar(page);
    // Attached but not visible — asserting only `not.toBeVisible()` would also
    // pass if the divider were never rendered at all, proving nothing.
    await expect(page.getByTestId('sidebar-divider')).toBeAttached();
    await expect(page.getByTestId('sidebar-divider')).not.toBeVisible();
  });

  test('at 1280px the sidebar is a column again — no backdrop, divider back, chat beside it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('sidebar')).toBeVisible();

    await expect(page.getByTestId('sidebar-backdrop')).not.toBeVisible();
    await expect(page.getByTestId('sidebar-divider')).toBeVisible();

    const chatMain = (await page.getByTestId('chat-main').boundingBox())!;
    const sb = (await page.getByTestId('sidebar').boundingBox())!;
    // In flow: the chat starts after the sidebar ends, no overlap.
    expect(chatMain.x).toBeGreaterThanOrEqual(sb.x + sb.width);
  });

  test('narrowing live to 375px with the sidebar reopened turns the column into a drawer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar-backdrop')).not.toBeVisible();

    await page.setViewportSize({ width: 375, height: 800 });
    // Crossing the breakpoint auto-collapses it; the user reopens it anyway.
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await reopenSidebar(page);

    await expect(page.getByTestId('sidebar-backdrop')).toBeVisible();
    const chatMain = (await page.getByTestId('chat-main').boundingBox())!;
    expect(chatMain.width).toBeGreaterThan(360);
  });
});
