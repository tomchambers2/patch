import { test, expect } from '@playwright/test';

// Layout glitches that only exist at a phone-width viewport, so only a
// real browser at that viewport can see them (jsdom has no layout at all):
//
//  1. Settings → Updates (was "Version & updates"): the layer / stamp /
//     timestamp columns were fixed-width, and at ~330px of row they claimed more
//     than the row had. The timestamp was squeezed to a sliver, wrapped over two
//     or three lines and spilled past the panel — a ragged block instead of a
//     row. Each row is now a name over one line of stamp and time.
//  2. The chat header's hamburger menu: an absolutely positioned box
//     shrink-to-fits against its containing block (the 28px trigger), so a
//     long item label could wrap onto two lines, leaving its icon centred
//     between them with nothing beside it.
//  3. The edit pencil on a user turn: it stacked BELOW the bubble, and since
//     `hover: none` keeps it permanently visible on touch, it read as an icon
//     floating in empty space. spec/14 § Main chat panel puts it to the turn's
//     LEFT.
//
// Every assertion here is geometric on purpose — all three elements were present
// and "visible" throughout; only their boxes were wrong.
const PHONE = { width: 390, height: 844 };

const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};
const SETTINGS_PAYLOAD = {
  account: ME.account,
  devices: [],
  push: { tokenCount: 2 },
  daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
  projectFolders: [],
};
const VERSION_REPORT = {
  checkedAt: '2026-08-26T12:00:00.000Z',
  server: {
    version: '0.1.532',
    gitSha: '9b8635f',
    builtAt: '2026-08-19T10:00:00.000Z',
    startedAt: '2026-08-25T10:00:00.000Z',
    serverSha: '9b8635f',
  },
  web: {
    version: '0.1.532',
    gitSha: '9b8635f',
    builtAt: '2026-08-19T10:00:00.000Z',
    bundle: 'assets/index-CtWBatg1.js',
    expectedServerSha: '9b8635f',
    deployedAt: '2026-08-19T10:05:00.000Z',
  },
  daemon: { version: '0.1.532', gitSha: '9b8635f', builtAt: null, online: true },
  desktop: null,
  android: null,
  clients: [],
  hosts: [],
  drift: [],
};

test.describe('Settings → Updates rows at phone width', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
    );
    await page.route('**/api/settings', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SETTINGS_PAYLOAD),
      }),
    );
    await page.route('**/api/version', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VERSION_REPORT),
      }),
    );
    await page.goto('/app/dev-harness.html?route=/settings/updates');
    await expect(page.getByTestId('version-detail-server')).toBeVisible();
  });

  test('each version row keeps its name above one line of stamp and time, inside the page', async ({
    page,
  }) => {
    const pageBox = (await page.getByTestId('settings-version').boundingBox())!;
    for (const id of ['version-app', 'version-detail-server', 'version-host-d1']) {
      const row = page.getByTestId(id);
      const rowBox = (await row.boundingBox())!;
      const name = (await row.locator('.set-row-title').boundingBox())!;
      const sub = (await row.locator('.set-sub').boundingBox())!;
      // Name first, then the stamp line under it, left-aligned together.
      expect(sub.y, id).toBeGreaterThanOrEqual(name.y + name.height - 0.5);
      expect(Math.abs(sub.x - name.x), id).toBeLessThanOrEqual(0.5);
      // "0.1.532 · 9b8635f · deployed 1w ago" is one line of text, not a wrapped
      // column of scraps.
      const lineHeight = await row
        .locator('.set-sub')
        .evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
      expect(sub.height, id).toBeLessThan(lineHeight * 1.5);
      // Nothing spills out of the row, and the row stays inside the page.
      expect(sub.x + sub.width, id).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
      expect(rowBox.x + rowBox.width, id).toBeLessThanOrEqual(pageBox.x + pageBox.width + 0.5);
      expect(rowBox.width, id).toBeLessThanOrEqual(PHONE.width);
    }
  });

  test('no page-level horizontal scroll on the settings route', async ({ page }) => {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

test.describe('chat header hamburger menu at phone width', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.locator('.chat-head')).toBeVisible();
    await page.getByTestId('action-hamburger').click();
    await expect(page.getByTestId('head-hamburger-menu')).toBeVisible();
  });

  test('every menu item is a single line, and the menu stays inside the window', async ({
    page,
  }) => {
    const menu = page.getByTestId('head-hamburger-menu');
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(PHONE.width);

    const items = menu.locator('.head-menu-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(5);
    const heights: number[] = [];
    for (let i = 0; i < count; i++) heights.push((await items.nth(i).boundingBox())!.height);
    // The wrapped item was 62px against its siblings' 37px. One line each means
    // one height, bar the snooze row's slightly taller trigger.
    expect(Math.max(...heights)).toBeLessThan(Math.min(...heights) * 1.4);

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

// `hasTouch` is what makes `@media (hover: none)` apply, which is what keeps the
// pencil permanently visible — the state Tom actually looks at on a phone.
test.describe('edit pencil on a user turn at phone width', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('sits beside the bubble, not on a line of its own below it', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_forked');
    const turn = page.locator('.msg-user').first();
    await expect(turn).toBeVisible();

    const edit = turn.getByTestId('msg-edit');
    // On touch it is always shown — so its placement is always on display.
    await expect(edit).toHaveCSS('opacity', '1');

    const bubble = (await turn.getByTestId('msg-content').boundingBox())!;
    const pencil = (await edit.boundingBox())!;

    // Beside, not below: it shares the bubble's vertical band and sits to its left.
    expect(pencil.y).toBeGreaterThanOrEqual(bubble.y - 0.5);
    expect(pencil.y + pencil.height).toBeLessThanOrEqual(bubble.y + bubble.height + 0.5);
    expect(pencil.x + pencil.width).toBeLessThanOrEqual(bubble.x);
    // And attached to it — a small gutter, not a stretch of empty row.
    expect(bubble.x - (pencil.x + pencil.width)).toBeLessThanOrEqual(12);

    // The turn is no taller than its bubble now that nothing stacks under it.
    const turnBox = (await turn.boundingBox())!;
    expect(turnBox.height).toBeLessThanOrEqual(bubble.height + 1);

    // It stays a real tap target.
    expect(pencil.width).toBeGreaterThanOrEqual(16);
    expect(pencil.height).toBeGreaterThanOrEqual(16);
  });

  test('the pencil takes its own tap, and the bubble keeps its reading measure', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_long_text');
    const turn = page.locator('.msg-user').first();
    await expect(turn).toBeVisible();

    const turnBox = (await turn.boundingBox())!;
    const bubble = (await turn.getByTestId('msg-content').boundingBox())!;
    // Reserving the pencil's gutter must not eat into the bubble: a long turn
    // still runs to the 82% cap and still ends flush with the turn's right edge.
    expect(bubble.width).toBeGreaterThan(turnBox.width * 0.75);
    expect(bubble.x + bubble.width).toBeCloseTo(turnBox.x + turnBox.width, 0);

    // The gutter is the pencil's, and it owns clicks there rather than the
    // bubble or the stream behind it.
    const edit = turn.getByTestId('msg-edit');
    const ownsItsCentre = await edit.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(ownsItsCentre).toBe(true);
  });
});
