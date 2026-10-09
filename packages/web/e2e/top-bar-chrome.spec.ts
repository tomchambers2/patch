import { test, expect } from '@playwright/test';

// The app's top row, measured (Tom, App Updates: "move the <> buttons to the
// main page, left of top bar. patch in line with window controls. < has too
// much padding on right side. put green dot like a superscript next to patch.
// cluster external window and < closer.").
//
// Which element holds which control is settled in jsdom
// (src/__tests__/topBarChrome.test.tsx); WHERE they land is only answerable in
// a real browser, and the shell's window controls are the thing everything on
// this row is positioned against. The Electron half cannot run here, so the
// lights' own geometry comes from the constants the shell pins them with
// (packages/desktop/src/window-chrome.ts, mirrored into index.css and held
// there by that package's window-chrome.test.ts).
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

// Three 12px lights on a 20px pitch from x=18: they end at x=70, and the strip
// the app keeps clear of them is 84px.
const LIGHTS_RIGHT_EDGE = 70;
const INSET = 84;
const LIGHT_DIAMETER = 12;

/** Boot the harness as if it were an Electron window with a hidden title bar. */
async function asDesktopWindow(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
  });
}

test.describe('the sidebar brand row', () => {
  test('the wordmark starts at the window controls, with nothing between them', async ({
    page,
  }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const mark = (await page.locator('.brand-mark').boundingBox())!;
    // Flush to the strip: the nav controls used to sit here and pushed the
    // wordmark 60px further in, where the brand row clipped it to "patc".
    expect(Math.round(mark.x)).toBe(INSET);
    expect(mark.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);
  });

  test('the wordmark sits on the centre-line the window controls are pinned to', async ({
    page,
  }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // The stylesheet records the centre-line; the shell reads the same number
    // (as `TRAFFIC_LIGHT_POSITION.y + radius`) to place the lights.
    const declared = await page.evaluate(() =>
      Number(
        getComputedStyle(document.documentElement)
          .getPropertyValue('--overlay-titlebar-lights-centre')
          .replace('px', '')
          .trim(),
      ),
    );
    expect(declared).toBeGreaterThan(LIGHT_DIAMETER / 2);

    const mark = (await page.locator('.brand-mark').boundingBox())!;
    // Within a pixel — the row's height comes from the wordmark's own type, so
    // a change to either has to move the declared centre-line with it.
    expect(Math.abs(mark.y + mark.height / 2 - declared)).toBeLessThanOrEqual(1);
  });

  test('the whole wordmark is drawn — the brand row no longer clips it', async ({ page }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    const mark = (await page.locator('.brand-mark').boundingBox())!;
    const row = (await page.locator('.brand-row').boundingBox())!;
    // `.brand-row` is `overflow: hidden`, so a mark running past its right edge
    // is not merely cramped — the last letters are painted away.
    expect(mark.x + mark.width).toBeLessThanOrEqual(row.x + row.width + 1);
  });

  test('the connection dot is a superscript on the wordmark', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const mark = (await page.locator('.brand-mark').boundingBox())!;
    const dot = (await page.getByTestId('conn-dot').boundingBox())!;

    // Immediately after the mark, not across the row in the icon cluster.
    expect(dot.x).toBeGreaterThanOrEqual(mark.x + mark.width);
    expect(dot.x - (mark.x + mark.width)).toBeLessThanOrEqual(6);
    // Raised: its whole box sits in the top half of the wordmark's line box.
    expect(dot.y).toBeGreaterThanOrEqual(mark.y);
    expect(dot.y + dot.height).toBeLessThanOrEqual(mark.y + mark.height / 2 + 1);
  });

  test('the two sidebar icons read as one cluster near the row edge', async ({ page }) => {
    await page.goto(HARNESS);
    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    const openWin = (await page.getByTestId('sidebar-open-window').boundingBox())!;
    const collapse = (await page.getByTestId('sidebar-collapse').boundingBox())!;

    // Clustered: the gap between them is smaller than either control.
    const gap = collapse.x - (openWin.x + openWin.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(2);
    // And close to the sidebar's own edge, not 20px off it.
    const trailing = sidebar.x + sidebar.width - (collapse.x + collapse.width);
    expect(trailing).toBeLessThanOrEqual(10);
    expect(trailing).toBeGreaterThan(0);
  });
});

test.describe('the chat panel header', () => {
  test('Back / Forward lead the header, in its own left zone ahead of the title', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-head')).toBeVisible();

    const head = (await page.getByTestId('chat-head').boundingBox())!;
    const nav = (await page.getByTestId('nav-history').boundingBox())!;
    const title = (await page.locator('.chat-head-title').boundingBox())!;

    // Gone from the sidebar entirely — one set of these controls, not two.
    await expect(page.locator('.sb-brand [data-testid="nav-history"]')).toHaveCount(0);
    expect(nav.x).toBeGreaterThanOrEqual(head.x);
    expect(nav.x + nav.width).toBeLessThanOrEqual(title.x);
    // On the header's own centre-line, like everything else in the row.
    expect(Math.abs(nav.y + nav.height / 2 - (head.y + head.height / 2))).toBeLessThanOrEqual(1);
  });

  test('taking the left zone does not pull the chat name off centre', async ({ page }) => {
    await page.goto(HARNESS);
    const head = (await page.getByTestId('chat-head').boundingBox())!;
    const title = (await page.locator('.chat-head-title').boundingBox())!;
    // The nav controls live INSIDE the left zone that carries the centring
    // share; as a fourth flex child they would shift the title by ~27px.
    expect(Math.abs(title.x + title.width / 2 - (head.x + head.width / 2))).toBeLessThanOrEqual(2);
  });

  test('in the shell the header drags the window, but Back still takes its click', async ({
    page,
  }) => {
    await asDesktopWindow(page);
    await page.goto(HARNESS);
    const region = (loc: ReturnType<typeof page.locator>): Promise<string> =>
      loc.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim());

    expect(await region(page.getByTestId('chat-head'))).toBe('drag');
    // An element inside a drag region stops hit-testing altogether, so the
    // whole left zone is punched back out.
    expect(await region(page.locator('.chat-head-left'))).toBe('no-drag');

    // Proved behaviourally: navigate, then walk back with the header's control.
    // (The harness routes through a MemoryRouter, so the chat on screen is the
    // reading of where we are, not the address bar.)
    const title = page.getByTestId('chat-title');
    await expect(title).toHaveText('Manager');
    await expect(page.getByTestId('nav-back')).toBeDisabled();
    await page.getByTestId('chat-row-chat_bus').click();
    await expect(title).not.toHaveText('Manager');
    await expect(page.getByTestId('nav-back')).toBeEnabled();
    await page.getByTestId('nav-back').click();
    await expect(title).toHaveText('Manager');
  });
});
