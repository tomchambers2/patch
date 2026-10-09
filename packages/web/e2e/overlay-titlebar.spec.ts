import { test, expect } from '@playwright/test';

// spec/05 § Desktop packaging (Electron) → Window chrome. The desktop shell
// opens its document windows with no native title bar, so the SPA runs to the
// window's top edge (Tom, App Updates: "clean at top, no patch top bar. window
// extends right to top of screen"). Everything that follows from that is the
// renderer's job and is measurable in a real browser: the macOS traffic lights
// now float over the app's top-left, and there is no bar left to drag by.
//
// The shell itself cannot be driven from Linux, so what is pinned here is the
// renderer's half — driven through the REAL boot path by stubbing the one
// value the preload hands over (`window.patch.overlayTitleBar`).

const HARNESS = '/app/dev-harness.html?chat=thread_manager';

// Three 12px traffic lights on a 20px pitch from x=18 (packages/desktop/src/
// window-chrome.ts) end at x=70. Nothing the app draws may start left of that.
const LIGHTS_RIGHT_EDGE = 70;
const INSET = 84;
// TRAFFIC_LIGHT_POSITION.y (31) + TRAFFIC_LIGHT_DIAMETER (12): the lights'
// bottom edge. A banner shorter than this cuts them at the seam with
// whatever renders next (Tom, App Updates: "window controls are overlapped
// by the green banner").
const LIGHTS_BOTTOM_EDGE = 43;

/** Boot the harness as if it were an Electron window with a hidden title bar. */
async function asDesktopWindow(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
  });
}

test.describe('overlay title bar', () => {
  test('a plain browser is untouched — it still has a real title bar', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    const brand = page.locator('.sb-brand');
    // The ordinary sidebar padding, not the traffic-light inset.
    await expect(brand).toHaveCSS('padding-left', '20px');
    // And no drag region: dragging a browser page by its header would only
    // start a text selection.
    const region = await brand.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region'),
    );
    expect(region.trim()).not.toBe('drag');
  });

  test('in the shell the brand row clears the traffic lights', async ({ page }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    await expect(page.locator('.sb-brand')).toHaveCSS('padding-left', `${INSET}px`);

    // The measurement that actually matters: nothing in the top row is left of
    // where the lights are drawn. The lights are native and paint OVER the web
    // content, so an un-inset wordmark is not merely cramped — it is covered.
    const mark = await page.locator('.brand-mark').boundingBox();
    expect(mark).not.toBeNull();
    expect(mark!.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);
    for (const btn of await page.locator('.sb-brand button').all()) {
      const box = await btn.boundingBox();
      if (box) expect(box.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);
    }

    // Still flush to the top of the window — the point of the change is that
    // the content starts at y=0, not that it was pushed down by an inset.
    const brandBox = await page.locator('.sb-brand').boundingBox();
    expect(brandBox!.y).toBe(0);
  });

  test('the brand row drags the window, but its buttons still take their clicks', async ({
    page,
  }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const region = (loc: ReturnType<typeof page.locator>): Promise<string> =>
      loc.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim());

    // With no title bar there is nothing else to move the window by.
    expect(await region(page.locator('.sb-brand'))).toBe('drag');
    // An element inside a drag region stops receiving clicks unless it opts
    // out, so every control in the row must be punched back out. Without this
    // the collapse chevron and the open-in-new-window button go dead.
    for (const testId of ['sidebar-collapse', 'sidebar-open-window']) {
      expect(await region(page.getByTestId(testId))).toBe('no-drag');
    }

    // Proven behaviourally too: the collapse chevron still works.
    await page.getByTestId('sidebar-collapse').click();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(page.getByTestId('sidebar-expand')).toBeVisible();
  });

  test('with the sidebar collapsed the chevron and chat header clear the lights', async ({
    page,
  }) => {
    // `?sidebar=hidden` is exactly how the shell opens a chat in its own
    // window (spec/14 § New windows), so this is that window's layout.
    await asDesktopWindow(page);
    await page.goto(`${HARNESS}&sidebar=hidden`);

    const expand = page.getByTestId('sidebar-expand');
    await expect(expand).toBeVisible();
    await expect(expand).toHaveCSS('left', `${INSET}px`);

    const expandBox = await expand.boundingBox();
    expect(expandBox!.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);

    // The header then clears the chevron rather than printing under it.
    const head = page.getByTestId('chat-head');
    await expect(head).toBeVisible();
    const left = await page.locator('.chat-head-left').boundingBox();
    expect(left!.x).toBeGreaterThanOrEqual(expandBox!.x + expandBox!.width);
  });

  // Tom, App Updates: "expand sidebar doesn't work". `.chat-head` drags the
  // window in overlay-titlebar mode (only its left/title/actions zones are
  // punched out, not its blank padding), and the collapsed expand chevron sits
  // — visually on top, but as an unrelated sibling — right inside that
  // padding at x=84..112, y=18..46. A drag region is native OS hit-testing,
  // not paint order: an element only stays clickable inside one if IT
  // explicitly says `no-drag`, the same rule `sidebar-open-window` and
  // `chat-head-actions` already follow. The chevron never got that rule, so
  // in the real desktop shell every click there starts a window-drag instead
  // of expanding the sidebar.
  test('the collapsed chevron is punched out of the chat header drag region', async ({ page }) => {
    await asDesktopWindow(page);
    await page.goto(`${HARNESS}&sidebar=hidden`);

    const expand = page.getByTestId('sidebar-expand');
    await expect(expand).toBeVisible();
    await expect(page.getByTestId('chat-head')).toHaveCSS('-webkit-app-region', 'drag');

    const region = await expand.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region').trim(),
    );
    expect(region).toBe('no-drag');
  });

  test('the chat header drags without swallowing the crumb, title or actions', async ({ page }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    const region = (loc: ReturnType<typeof page.locator>): Promise<string> =>
      loc.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim());

    await expect(page.getByTestId('chat-head')).toBeVisible();
    expect(await region(page.getByTestId('chat-head'))).toBe('drag');
    // The crumb and the title are plain spans, not buttons — punched out as
    // whole zones so a rename click still lands. The left zone is the unit,
    // not the crumb: it also holds Back / Forward (§ Chat panel header).
    for (const sel of ['.chat-head-left', '.chat-head-title', '.chat-head-actions']) {
      expect(await region(page.locator(sel))).toBe('no-drag');
    }
    // `-webkit-app-region` does NOT inherit — everything inside a punched-out
    // zone computes `none`, which is not a region of its own and so takes the
    // zone's. Asserting `no-drag` on a child would fail while the child works
    // perfectly, so the check on what is INSIDE a zone is behavioural.
    expect(await region(page.locator('.chat-head-title-row'))).toBe('none');
    // `chat_bus` is an ordinary chat, so it has a crumb to aim at and a
    // renameable title; the Manager thread has neither.
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('chat-title')).toBeVisible();
    await page.getByTestId('chat-title').click();
    await expect(page.getByTestId('chat-title-input')).toBeVisible();
  });

  test('the sidebar in its own window clears the lights too', async ({ page }) => {
    // `/sidebar-window` is a real child window, so it has traffic lights —
    // unlike the tray popover and voice overlay, which are frameless.
    await asDesktopWindow(page);
    await page.goto('/app/dev-harness.html?route=/sidebar-window');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.locator('.sb-brand')).toHaveCSS('padding-left', `${INSET}px`);
    const mark = await page.locator('.brand-mark').boundingBox();
    expect(mark!.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);
  });

  test('the wordmark survives the inset at the sidebar default width', async ({ page }) => {
    // The inset takes 84px off a 280px sidebar's brand row, which already holds
    // the nav controls, the wordmark, the connection dot and two buttons. If it
    // did not fit, the wordmark — the one element with no shrink — would be the
    // thing that visibly broke.
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    const mark = page.locator('.brand-mark');
    await expect(mark).toHaveText('patch');
    expect(await mark.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  });

  test('at the narrowest sidebar the inset never pushes a control out of reach', async ({
    page,
  }) => {
    // `.sb` is `overflow: hidden` + `contain: layout paint`, so a control
    // pushed past its right edge is not merely cramped — it stops hit-testing
    // and the only way to collapse the sidebar goes silently dead. Dragged to
    // its 200px floor with the inset applied, the controls must still be
    // inside. (The wordmark yields there, as it already does without the inset.)
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    const divider = page.getByTestId('sidebar-divider');
    const d = (await divider.boundingBox())!;
    await page.mouse.move(d.x + d.width / 2, d.y + 100);
    await page.mouse.down();
    await page.mouse.move(10, d.y + 100, { steps: 10 });
    await page.mouse.up();

    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    expect(Math.round(sidebar.width)).toBe(200);
    for (const testId of ['sidebar-open-window', 'sidebar-collapse']) {
      const box = (await page.getByTestId(testId).boundingBox())!;
      expect(box.x + box.width, testId).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    }
    // Not just inside the box — still actually clickable.
    await page.getByTestId('sidebar-collapse').click();
    await expect(page.getByTestId('sidebar')).toBeHidden();
  });
});

test('an offline banner clears the lights too, top edge and bottom edge alike', async ({
  page,
}) => {
  await asDesktopWindow(page);
  await page.goto(HARNESS);
  await page.evaluate(() => {
    (
      window as unknown as {
        __presenceStore: { getState: () => { setConnection: (s: string) => void } };
      }
    ).__presenceStore
      .getState()
      .setConnection('reconnecting');
  });

  const banner = page.getByTestId('offline-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveCSS('padding-left', `${INSET}px`);
  const bannerBox = (await banner.boundingBox())!;
  expect(bannerBox.y).toBe(0);
  expect(bannerBox.height).toBeGreaterThanOrEqual(LIGHTS_BOTTOM_EDGE);
});

test('a staged update banner clears the lights too, and its button still clicks', async ({
  page,
}) => {
  // The banner sits in flow at the very top of the shell, same as .sb-brand —
  // without the inset its coloured background draws straight under the
  // lights (Tom, live screenshot: "banner is not clean, messes up").
  await page.addInitScript(() => {
    (window as unknown as { patch: unknown }).patch = {
      overlayTitleBar: true,
      getUpdaterState: () =>
        Promise.resolve({
          currentVersion: '0.1.899',
          gitSha: '9b8635f',
          builtAt: '2026-09-07T09:00:00.000Z',
          feedUrl: 'https://patch.tomchambers.me/api/desktop/',
          disabledReason: null,
          lastCheckedAt: '2026-09-07T11:55:00.000Z',
          lastResult: 'downloaded',
          lastError: null,
          availableVersion: '0.1.900',
          downloaded: true,
          checking: false,
          staleSince: new Date().toISOString(),
        }),
      checkForUpdates: () => Promise.resolve(undefined),
      onUpdaterState: () => () => {},
      installUpdate: () => {},
    };
  });
  await page.goto(HARNESS);

  const banner = page.getByTestId('desktop-update-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveCSS('padding-left', `${INSET}px`);
  // The banner itself spans the full width regardless of its own padding —
  // same as .sb-brand above, the measurement that matters is where its
  // CONTENT starts, since that is what the lights would otherwise cover.
  const dot = (await banner.locator('.dot').boundingBox())!;
  expect(dot.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);
  // And tall enough to fully contain them — the banner sits at y=0, same as
  // the lights, so its own box height must clear their bottom edge or it cuts
  // them at the seam with whatever renders next.
  const bannerBox = (await banner.boundingBox())!;
  expect(bannerBox.y).toBe(0);
  expect(bannerBox.height).toBeGreaterThanOrEqual(LIGHTS_BOTTOM_EDGE);

  // Drags like the rest of the top row, but the button is punched back out —
  // same shape as .chat-head-actions above.
  const region = (loc: ReturnType<typeof page.locator>): Promise<string> =>
    loc.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim());
  expect(await region(banner)).toBe('drag');
  expect(await region(page.getByTestId('desktop-update-restart'))).toBe('no-drag');
  await page.getByTestId('desktop-update-restart').click();
});

test('the signed-out desktop keeps a full-width drag strip and usable sign-in controls', async ({
  page,
}) => {
  await asDesktopWindow(page);
  await page.goto('/app/');
  await expect(page.getByTestId('pairing-screen')).toBeVisible();
  const grip = page.getByTestId('pairing-window-drag');
  await expect(grip).toBeVisible();
  await expect(grip).toHaveCSS('-webkit-app-region', 'drag');
  const box = await grip.boundingBox();
  expect(box!.y).toBe(0);
  expect(box!.width).toBe(1280);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const input = page.getByTestId('pairing-input');
  await input.fill('not-a-token');
  await page.getByTestId('pairing-submit').click();
  await expect(page.getByTestId('pairing-error')).toBeVisible();
});

test('the browser sign-in screen adds no desktop drag strip', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.getByTestId('pairing-screen')).toBeVisible();
  await expect(page.getByTestId('pairing-window-drag')).toBeHidden();
});
