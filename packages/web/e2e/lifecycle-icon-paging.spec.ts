import { test, expect } from '@playwright/test';

// spec/14 § Sidebar item 6 (App Updates: "show which icon is selected as
// open. load a limited number of any in the list, then load more on
// scroll"). Two things jsdom's unit suite can't prove: the selected icon's
// computed colour actually differs (not just a class name), and a REAL
// scroll — real layout, real `scrollHeight` — fetches the next page.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

function hiddenRow(chatId: string, lastUpdated: number) {
  return {
    chatId,
    name: chatId,
    preview: null,
    folder: '~/proj',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    snoozedUntil: null,
    hidden: true,
    lastUpdated,
    daemonId: 'd1',
    permissionMode: 'auto',
    jobId: 'j1',
    statusSummary: null,
    statusKind: null,
  };
}

test.describe('Sidebar lifecycle icon row — selected state + scroll paging', () => {
  test('the open section icon visibly differs from an unopened one', async ({ page }) => {
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hidden: 1, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
      }),
    );
    await page.route('**/api/chats?hidden=only*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [hiddenRow('h1', 1)], nextOffset: null }),
      }),
    );
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const hidden = page.getByTestId('hidden-toggle');
    const archived = page.getByTestId('archived-toggle');
    await expect(hidden).toHaveAttribute('aria-pressed', 'false');
    const before = await hidden.evaluate((el) => getComputedStyle(el).backgroundColor);

    await hidden.click();
    await expect(hidden).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('hidden-section')).toBeVisible();
    const after = await hidden.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after).not.toBe(before);

    // A section nobody opened stays unselected, in the same row.
    await expect(archived).toHaveAttribute('aria-pressed', 'false');
    const archivedColor = await archived.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(archivedColor).toBe(before);
  });

  test('scrolling the lifecycle band near its bottom loads the next page of Hidden', async ({
    page,
  }) => {
    const page1 = {
      chats: Array.from({ length: 30 }, (_, i) => hiddenRow(`h${i}`, i)),
      nextOffset: 30,
    };
    const page2 = { chats: [hiddenRow('h-more', 999)], nextOffset: null };
    let calls = 0;
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hidden: 31, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
      }),
    );
    await page.route('**/api/chats?hidden=only*', (route) => {
      calls += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(calls === 1 ? page1 : page2),
      });
    });
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    await page.getByTestId('hidden-toggle').click();
    await expect(page.getByTestId('chat-row-h0')).toBeVisible();
    expect(calls).toBe(1);
    await expect(page.getByTestId('chat-row-h-more')).toHaveCount(0);

    // A real scroll, in a real layout — 30 rows overflow the band's 300px cap
    // (spec/14 § Scroll regions), so this is a genuine "user scrolled" signal,
    // not a synthetic event with mocked geometry.
    const band = page.getByTestId('sb-lifecycle');
    await band.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });

    await expect(page.getByTestId('chat-row-h-more')).toBeVisible();
    expect(calls).toBe(2);
    // The first page's rows are still there.
    await expect(page.getByTestId('chat-row-h0')).toBeVisible();
  });

  test('the icon row stays pinned in view while an open section is scrolled', async ({ page }) => {
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hidden: 30, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
      }),
    );
    await page.route('**/api/chats?hidden=only*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: Array.from({ length: 30 }, (_, i) => hiddenRow(`h${i}`, i)),
          nextOffset: null,
        }),
      }),
    );
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.getByTestId('hidden-toggle').click();
    await expect(page.getByTestId('chat-row-h0')).toBeVisible();

    const band = page.getByTestId('sb-lifecycle');
    await band.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    const bandBox = await band.boundingBox();
    const iconsBox = await page.getByTestId('sb-lifecycle-icons').boundingBox();
    expect(bandBox).not.toBeNull();
    expect(iconsBox).not.toBeNull();
    // The icons must sit inside the band's visible box, not scrolled above it.
    expect(iconsBox!.y).toBeGreaterThanOrEqual(bandBox!.y - 1);
    await expect(page.getByTestId('archived-toggle')).toBeInViewport();
  });

  test('scrolled rows never show above the pinned icon bar', async ({ page }) => {
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hidden: 30, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
      }),
    );
    await page.route('**/api/chats?hidden=only*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: Array.from({ length: 30 }, (_, i) => hiddenRow(`h${i}`, i)),
          nextOffset: null,
        }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('hidden-toggle').click();
    await expect(page.getByTestId('hidden-section')).toBeVisible();

    const band = page.getByTestId('sb-lifecycle');
    await band.evaluate((el) => {
      el.scrollTop = 120;
    });
    // The element painted at the band's top edge, just above the icon bar's
    // top, must be the bar's own background, not a scrolled row.
    const leak = await page.evaluate(() => {
      const band = document.querySelector('[data-testid="sb-lifecycle"]')!;
      const bar = document.querySelector('[data-testid="sb-lifecycle-icons"]')!;
      const b = band.getBoundingClientRect();
      const x = bar.getBoundingClientRect().left + 20;
      for (let y = b.top + 1; y < bar.getBoundingClientRect().top + 4; y += 1) {
        const hit = document.elementFromPoint(x, y);
        if (hit && band.contains(hit) && !bar.contains(hit) && hit !== band)
          return hit.outerHTML.slice(0, 80);
      }
      return null;
    });
    expect(leak).toBeNull();
  });
});
