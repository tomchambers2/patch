import { test, expect } from '@playwright/test';

// spec/14 § Sidebar → Scroll regions: the chat list is the band that yields,
// but the lifecycle group is capped so that yielding never means disappearing.
//
// Only a real browser can prove this. The sidebar is a column flex container
// whose bands negotiate height at layout time: `.sb-scroll` carries an outsized
// shrink weight (so a LONG chat list can never compress the five lifecycle
// toggles out of view) and `.sb-lifecycle` carries the matching max-height cap
// (so an EXPANDED lifecycle list can never compress the chat list out of view).
// jsdom has no layout, so neither half is observable there.
//
// Measured on the unfixed build at 1400x860: expanding all four sections took
// `.sb-lifecycle` to its old 50% cap (430px) and left `.sb-scroll` 13px — zero
// chat rows — even with every section EMPTY, because each empty section drew a
// "nothing here" line of its own.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

const TOGGLES = [
  'hidden-toggle',
  'archived-toggle',
  'snoozed-toggle',
  'deleted-toggle',
  'automations-toggle',
] as const;

/** The rendered height of a single sidebar band, in CSS px. */
async function bandHeight(page: import('@playwright/test').Page, sel: string): Promise<number> {
  return await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) throw new Error(`no element for ${s}`);
    return Math.round(el.getBoundingClientRect().height);
  }, sel);
}

/** Stub all five lifecycle endpoints with the given chat lists. */
async function stubLifecycle(
  page: import('@playwright/test').Page,
  chats: Record<'hidden' | 'archived' | 'snoozed' | 'deleted' | 'automations', unknown[]>,
): Promise<void> {
  const routes: Array<[string, unknown[]]> = [
    ['**/api/chats?hidden=only', chats.hidden],
    ['**/api/chats?archived=include', chats.archived],
    ['**/api/chats?snoozed=only', chats.snoozed],
    ['**/api/chats?deleted=only', chats.deleted],
    ['**/api/chats?automations=only', chats.automations],
  ];
  for (const [pattern, list] of routes) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: list }),
      }),
    );
  }
}

/**
 * Stub the section-count totals (spec/04 § Section counts). These are what the
 * collapsed toggles badge, and they are served independently of the lists — the
 * harness has no backend, so unstubbed the fetch 404s and no badge is drawn.
 */
async function stubCounts(
  page: import('@playwright/test').Page,
  counts: Record<'hidden' | 'archived' | 'snoozed' | 'deleted' | 'automations', number>,
): Promise<void> {
  await page.route('**/api/chats/counts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(counts),
    }),
  );
}

function chatFixture(chatId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    chatId,
    name: chatId,
    preview: null,
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status,
    pinned: false,
    pinnedAt: null,
    snoozedUntil: null,
    lastUpdated: 100,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions',
    jobId: null,
    ...extra,
  };
}

test.describe('Sidebar lifecycle group cannot starve the chat list', () => {
  // The harness always seeds one archived chat (`chat_archived`) and one hidden
  // chat (`chat_hidden`), shared with other specs, so Archived and Hidden are
  // the sections that cannot be made empty here. The other three are, and they are what this measures: an empty
  // section must add ZERO height, not a "nothing here" line.
  test('expanding an EMPTY section costs the chat list nothing', async ({ page }) => {
    await stubLifecycle(page, {
      hidden: [],
      archived: [],
      snoozed: [],
      deleted: [],
      automations: [],
    });
    // Archived and Hidden are 1: the harness seeds `chat_archived` and
    // `chat_hidden`. The other three really are empty, and the badge is what
    // says so before anything is opened.
    await stubCounts(page, { hidden: 1, archived: 1, snoozed: 0, deleted: 0, automations: 0 });
    // 900, not 860: the fifth lifecycle row (Hidden) took the chat list at 860
    // to exactly the sanity floor below.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const scrollBefore = await bandHeight(page, '.sb-scroll');
    const lifecycleBefore = await bandHeight(page, '.sb-lifecycle');
    // Sanity: the harness is tall enough for this measurement to mean anything.
    expect(scrollBefore).toBeGreaterThan(250);

    for (const id of ['snoozed', 'deleted', 'automations'] as const) {
      await page.getByTestId(`${id}-toggle`).click();
      await expect(page.getByTestId(`${id}-section`)).toBeAttached();
      // The count IS the empty state, and it lives in the icon's tooltip, not
      // in a body below it — and an empty section grows no "open in main
      // window" head either (LifecyclePanel withholds it for a `0` count).
      await expect(page.getByTestId(`${id}-toggle`)).toHaveAttribute('title', /· 0$/);
      await expect(page.getByTestId(`${id}-open-main`)).toHaveCount(0);
      expect(await bandHeight(page, `.sb-${id}`), `${id} section must be zero-height`).toBe(0);
    }

    // Three sections open and the group has not grown by a pixel, so the chat
    // list has not lost one. (Unfixed: 272px -> 13px with all four open.)
    expect(await bandHeight(page, '.sb-lifecycle')).toBe(lifecycleBefore);
    expect(await bandHeight(page, '.sb-scroll')).toBe(scrollBefore);
    expect(await page.locator('.sb-scroll [data-testid^="chat-row-"]').count()).toBeGreaterThan(1);

    // The count does not depend on the row being open. Collapse them again and
    // the tooltips stay, unchanged — one server-served number, not a
    // measurement of whichever list happens to be loaded.
    for (const id of ['snoozed', 'deleted', 'automations'] as const) {
      await page.getByTestId(`${id}-toggle`).click();
      await expect(page.getByTestId(`${id}-section`)).toHaveCount(0);
      await expect(page.getByTestId(`${id}-toggle`)).toBeVisible();
      await expect(page.getByTestId(`${id}-toggle`)).toHaveAttribute('title', /· 0$/);
    }
    // Archived and Hidden were never opened at all, and still report what they
    // hold.
    await expect(page.getByTestId('archived-section')).toHaveCount(0);
    await expect(page.getByTestId('archived-toggle')).toHaveAttribute('title', /· 1 /);
    await expect(page.getByTestId('hidden-section')).toHaveCount(0);
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('title', /· 1$/);
  });

  test('expanding all five FULL sections leaves the chat list several rows', async ({ page }) => {
    const many = (prefix: string, status: string, extra?: Record<string, unknown>): unknown[] =>
      Array.from({ length: 12 }, (_, i) => chatFixture(`${prefix}_${i}`, status, extra));
    await stubLifecycle(page, {
      hidden: many('hid', 'active', { hidden: true }),
      archived: many('arch', 'archived'),
      snoozed: many('snoo', 'archived', { snoozedUntil: 9_999_999_999_999 }),
      deleted: many('del', 'deleted'),
      automations: many('auto', 'archived', { jobId: 'job_1' }),
    });
    await stubCounts(page, { hidden: 12, archived: 12, snoozed: 12, deleted: 12, automations: 12 });
    await page.setViewportSize({ width: 1400, height: 860 });
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    for (const id of TOGGLES) await page.getByTestId(id).click();
    await expect(page.getByTestId('archived-section').getByTestId('chat-row-arch_0')).toBeVisible();
    // A populated section reports its size in the icon's tooltip, from the
    // server total.
    await expect(page.getByTestId('archived-toggle')).toHaveAttribute('title', /· 12 /);

    const lifecycle = await bandHeight(page, '.sb-lifecycle');
    const scroll = await bandHeight(page, '.sb-scroll');

    // Capped at min(33%, 300px) of an 860px sidebar — nowhere near the 430px
    // the old 50% cap allowed, and it scrolls its own overflow internally.
    expect(lifecycle).toBeLessThanOrEqual(300);
    expect(
      await page.evaluate(() => {
        const el = document.querySelector('.sb-lifecycle') as HTMLElement;
        return el.scrollHeight > el.clientHeight;
      }),
    ).toBe(true);
    // The chat list survives with real rows in it.
    expect(scroll).toBeGreaterThanOrEqual(150);
    expect(await page.locator('.sb-scroll [data-testid^="chat-row-"]').count()).toBeGreaterThan(1);
  });

  test('a long chat list still cannot clip the five lifecycle toggles', async ({ page }) => {
    await stubLifecycle(page, {
      hidden: [],
      archived: [],
      snoozed: [],
      deleted: [],
      automations: [],
    });
    // Short enough that the bands genuinely compete for room.
    await page.setViewportSize({ width: 1400, height: 620 });
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // The seeded harness list overflows its band at this height.
    expect(
      await page.evaluate(() => {
        const el = document.querySelector('.sb-scroll') as HTMLElement;
        return el.scrollHeight > el.clientHeight;
      }),
    ).toBe(true);

    for (const id of TOGGLES) {
      await expect(page.getByTestId(id)).toBeVisible();
      // Not merely painted — the sidebar clips its own overflow, so a clipped
      // control still reports a box while receiving no clicks.
      const hit = await page.evaluate((testid) => {
        const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at !== null && el.contains(at);
      }, id);
      expect(hit, `${id} must be clickable`).toBe(true);
    }
  });
});
