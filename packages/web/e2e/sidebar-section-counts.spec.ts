import { test, expect } from '@playwright/test';

// spec/14 § Sidebar → Cold storage + Channels, spec/04 § Section counts.
//
// The cold-storage row is a strip of icon-only buttons (App Updates: "show as
// single icon buttons on bottom row, text and number on hover"): each one's
// label + count live in its `title` tooltip, not drawn on the row. Only a
// real browser can prove the tooltip attribute is what a user actually gets
// on hover/focus — jsdom sees the attribute too, but can't tell an attribute
// from a rendered label the way `toBeVisible`/computed-style checks here can.
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

const COUNTS = { hidden: 5, archived: 12, snoozed: 3, deleted: 1, automations: 7 } as const;

type Section = keyof typeof COUNTS;
const SECTIONS = Object.keys(COUNTS) as Section[];
// Archived alone carries a keyboard chord in its tooltip (spec/14 § Sidebar
// item 6 / § Discoverability) — jsdom's platform probe in the unit suite
// pins the non-Mac wording; this is the same machine here.
const CHORD: Partial<Record<Section, string>> = { archived: ' (Ctrl+Shift+A)' };

function expectedTitle(id: Section, count: number | null): string {
  const label = id[0]!.toUpperCase() + id.slice(1);
  const withCount = count === null ? label : `${label} · ${count}`;
  return withCount + (CHORD[id] ?? '');
}

async function stubCounts(
  page: import('@playwright/test').Page,
  counts: Record<Section, number> = COUNTS,
): Promise<void> {
  await page.route('**/api/chats/counts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(counts),
    }),
  );
}

test.describe('Sidebar section counts, icon row', () => {
  test('every icon carries its label + count in its tooltip, whether collapsed or expanded', async ({
    page,
  }) => {
    await stubCounts(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    for (const id of SECTIONS) {
      // Nothing has been expanded, so nothing has been fetched — these numbers
      // cannot have come from the rendered list.
      await expect(page.getByTestId(`${id}-section`)).toHaveCount(0);
      const toggle = page.getByTestId(`${id}-toggle`);
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('title', expectedTitle(id, COUNTS[id]));
      // Expanding the section changes nothing about the tooltip — one server
      // total, not a locally-measured one that could jump as the list loads.
      await toggle.click();
      await expect(toggle).toHaveAttribute('title', expectedTitle(id, COUNTS[id]));
      await toggle.click();
    }
  });

  test('the five icons sit in one row, evenly spread, sharing a vertical centre', async ({
    page,
  }) => {
    await stubCounts(page);
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const boxes = await Promise.all(
      SECTIONS.map(async (id) => (await page.getByTestId(`${id}-toggle`).boundingBox())!),
    );
    const centres = boxes.map((b) => b.y + b.height / 2);
    for (const c of centres) expect(Math.abs(c - centres[0]!)).toBeLessThan(1);
    // Left-to-right in the documented order (spec/14 § Sidebar item 6).
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
    }
    // No label text is painted on the row itself — an icon-only strip, not a
    // stack of text rows (App Updates: "single icon buttons").
    const icons = page.getByTestId('sb-lifecycle-icons');
    await expect(icons).not.toContainText('Archived');
    await expect(icons).not.toContainText('12');
  });

  test('a four-digit count is exactly what the tooltip reports, however long', async ({ page }) => {
    // The pathological case: Tom archives constantly, so Archived is the
    // number that grows without bound. Nothing on the row can overflow —
    // there's no text on the row to push out — but the tooltip must still be
    // exactly right.
    await stubCounts(page, { hidden: 0, archived: 4821, snoozed: 0, deleted: 0, automations: 0 });
    await page.goto(HARNESS);
    await expect(page.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 4821 (Ctrl+Shift+A)',
    );
  });

  test('Channels badges the rows it expands to, and the badge matches on expand', async ({
    page,
  }) => {
    await stubCounts(page);
    await page.goto(HARNESS);

    const badge = page.getByTestId('channels-count');
    await expect(badge).toBeVisible();
    const claimed = Number(await badge.innerText());
    expect(claimed).toBeGreaterThan(0);

    // Channels needs no server total: it is a fixed pair of links that render
    // whether or not a chat backs them. Opening it must produce exactly what
    // the badge promised.
    await page.getByTestId('channels-toggle').click();
    await expect(page.getByTestId('channels-list')).toBeVisible();
    expect(await page.locator('[data-testid^="channel-row-"]').count()).toBe(claimed);
    // And the number does not change on expand.
    await expect(badge).toHaveText(String(claimed));
  });

  test('the count refreshes when a chat is archived, without a reload', async ({ page }) => {
    // Freshness is the point: a total fetched once at boot is wrong the moment
    // Tom archives anything, and a stale tooltip is worse than none because it
    // is confidently wrong. The refetch is driven off the chat store, so it
    // covers both the optimistic local update and the server's WS echo.
    let served = 0;
    await page.route('**/api/chats/counts', (route) => {
      served += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hidden: 5,
          archived: served === 1 ? 12 : 13,
          snoozed: 3,
          deleted: 1,
          automations: 7,
        }),
      });
    });
    await page.goto(HARNESS);
    await expect(page.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 12 (Ctrl+Shift+A)',
    );

    // Archive a chat the way the app does — through the store, which is where
    // every archive path (menu action, hotkey, WS echo) lands.
    await page.evaluate(() => {
      const w = window as unknown as {
        __store?: { getState: () => { setArchived: (id: string, v: boolean) => void } };
      };
      if (w.__store === undefined) throw new Error('harness store handle missing');
      w.__store.getState().setArchived('chat_bus', true);
    });

    await expect(page.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 13 (Ctrl+Shift+A)',
    );
  });

  test('a failed counts request draws no count segment at all — never a 0', async ({ page }) => {
    // NO FALLBACK: `0` is a real value here (it is a section's whole empty
    // state), so a request that failed must not be rendered as one. No count
    // segment reads as "not known yet"; a `0` would read as "nothing in
    // there" and is exactly what would stop Tom opening a full section.
    await page.route('**/api/chats/counts', (route) => route.fulfill({ status: 500, body: '{}' }));
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    for (const id of SECTIONS) {
      await expect(page.getByTestId(`${id}-toggle`)).toHaveAttribute(
        'title',
        expectedTitle(id, null),
      );
    }
    // The row itself is untouched and still opens.
    await page.getByTestId('archived-toggle').click();
    await expect(page.getByTestId('archived-section')).toBeAttached();
  });

  test('a malformed body is treated as no answer, not as zero', async ({ page }) => {
    await page.route('**/api/chats/counts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // `deleted` missing entirely — the shape a partial server rollout gives.
        body: JSON.stringify({ hidden: 0, archived: 4, snoozed: 1, automations: 0 }),
      }),
    );
    await page.goto(HARNESS);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // All five are withheld, not just the bad one: a body that shape cannot be
    // trusted for the fields that happen to have parsed.
    for (const id of SECTIONS) {
      await expect(page.getByTestId(`${id}-toggle`)).toHaveAttribute(
        'title',
        expectedTitle(id, null),
      );
    }
  });
});
