import { test, expect } from '@playwright/test';

// Real-browser e2e for the sidebar changes, driven against the dev harness
// (real Sidebar + real CSS, no backend). Covers: folder basename header,
// time + row-tools placement/hover, archive-a-whole-project, and drafts.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

test.describe('sidebar', () => {
  test('folder header shows the project BASENAME, full path on hover', async ({ page }) => {
    await page.goto(HARNESS);
    // Seeded folders: /home/tom/projects/bus and /home/tom/projects/portfolio.
    // (`.folder-head` is text-transform: uppercase, so innerText comes back
    // upper-cased — the underlying label is still the basename.)
    const labels = (await page.locator('.folder-head-label').allInnerTexts()).map((l) =>
      l.toLowerCase(),
    );
    expect(labels).toContain('bus');
    expect(labels).toContain('portfolio');
    // Never the old two-segment "…/projects/…" tail.
    for (const l of labels) expect(l).not.toContain('…/');
    // Full path stays on the header's title attribute.
    const busHead = page.locator('.sb-folder', { hasText: 'bus' }).locator('.folder-head');
    await expect(busHead).toHaveAttribute('title', '/home/tom/projects/bus');
  });

  test('relative time is visible at rest; row tools reveal on hover and go OVER the time', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    const time = row.locator('.when-time');
    const tools = row.locator('.row-tools');
    // Time visible before any hover.
    await expect(time).toBeVisible();
    // Tools are out of flow until the row is hovered — an opacity-only hide
    // would keep the slot as wide as all four chips and truncate the name
    // early (see sidebar-name-width.spec.ts).
    await expect(tools).toBeHidden();
    await row.hover();
    await expect(tools).toBeVisible();
    // The three actions live in the tools cluster.
    await expect(row.getByTestId('archive-btn-chat_bus')).toBeVisible();
    await expect(row.getByTestId('pin-btn-chat_bus')).toBeVisible();
    await expect(row.getByTestId('row-mic-chat_bus')).toBeVisible();
    // …and they take the time's place rather than sitting beside it
    // (todo: "chat options go over").
    await expect(time).toBeHidden();
    // Cluster sits on the row's first line (top), not below the preview.
    const rowBox = (await row.boundingBox())!;
    const toolsBox = (await tools.boundingBox())!;
    expect(toolsBox.y - rowBox.y).toBeLessThan(28);
  });

  test('time + chat options share ONE top-right slot — the options overlay the time, nothing moves', async ({
    page,
  }) => {
    // spec/14 § Row tools: both live top-right on the row's first line, in the
    // SAME slot — the actions are not a second column beside the time, so
    // revealing them never shifts the row's anchors (todo: "time since and chat
    // options should be top right, chat options go over").
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    const when = row.getByTestId('row-when-chat_bus');
    const tools = row.locator('.row-tools');
    const name = row.locator('.name');

    const rowBox = (await row.boundingBox())!;
    const whenBox = (await when.boundingBox())!;
    const nameBefore = (await name.boundingBox())!;
    expect(whenBox.y - rowBox.y).toBeLessThan(16);

    await row.hover();
    await expect(tools).toBeVisible();
    const toolsBox = (await tools.boundingBox())!;
    const nameAfter = (await name.boundingBox())!;

    // Both are anchored to the row's TOP…
    expect(Math.abs(whenBox.y - toolsBox.y)).toBeLessThanOrEqual(2);
    // …and to the same RIGHT edge, so the actions land ON the time's slot
    // rather than in a column beside it.
    expect(Math.abs(whenBox.x + whenBox.width - (toolsBox.x + toolsBox.width))).toBeLessThanOrEqual(
      1,
    );
    expect(toolsBox.x).toBeLessThan(whenBox.x + whenBox.width);
    // The `when` slot did not move to make room.
    expect((await when.boundingBox())!.x).toBeCloseTo(whenBox.x, 0);
    // Neither did the badge column or the name's left edge — only the name's
    // own clip width yields, and only while the pointer is on the row.
    expect(nameAfter.x).toBeCloseTo(nameBefore.x, 0);
    expect(nameAfter.y).toBeCloseTo(nameBefore.y, 0);
  });

  test('a DELETED row keeps its Restore control on hover (the tools overlay never applies)', async ({
    page,
  }) => {
    // Guard for the overlay rule: deleted rows have no `.row-tools`, so hiding
    // the time on hover must not swallow their inline Restore button.
    //
    // Expanding Deleted lazily loads soft-deleted chats, and a failed load
    // replaces the list with its error — so without this stub the harness's
    // absent backend answered 500 and the row under test vanished a moment
    // after it appeared. Same stub the Archived cases already carry.
    await page.route('**/api/chats?deleted=only', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [] }),
      }),
    );
    await page.goto(HARNESS);
    await page.evaluate(() => {
      const store = (window as unknown as { __store: { getState: () => Record<string, unknown> } })
        .__store;
      (store.getState().setDeleted as (id: string, v: boolean) => void)('chat_bus', true);
    });
    await page.getByTestId('deleted-toggle').click();
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await row.hover();
    await expect(row.getByTestId('restore-btn-chat_bus')).toBeVisible();
    await expect(row.locator('.when-time')).toBeVisible();
  });

  test('archive-a-whole-project confirms via the CUSTOM modal (not native) and drops the folder', async ({
    page,
  }) => {
    // Make the per-chat archive REST call succeed so the optimistic archive sticks.
    await page.route('**/api/chats/**', (r) => r.fulfill({ status: 200, body: '{"ok":true}' }));
    // If a NATIVE dialog ever fires, fail loudly — the whole point of this todo
    // is that confirmations are the app's own modal, never the OS one.
    let nativeDialogFired = false;
    page.on('dialog', (d) => {
      nativeDialogFired = true;
      void d.dismiss();
    });
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await page
      .getByTestId('chat-row-chat_bus')
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await page.getByTestId('folder-archive-/home/tom/projects/bus').click({ force: true });

    // The app's own modal appears — a real DOM dialog with a fixed-position
    // overlay, not the Mac-native confirm().
    const modal = page.getByTestId('confirm-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toContainText('Archive the "bus" project?');
    const overlayPosition = await page
      .getByTestId('confirm-modal-overlay')
      .evaluate((el) => getComputedStyle(el).position);
    expect(overlayPosition).toBe('fixed');
    expect(nativeDialogFired).toBe(false);

    await page.getByTestId('confirm-ok').click();
    // The folder's only chat is archived → its row leaves the active list, and
    // the modal closes.
    await expect(page.getByTestId('chat-row-chat_bus')).toHaveCount(0);
    await expect(modal).toHaveCount(0);
  });

  test('archive-a-whole-project: cancelling the custom modal keeps the folder', async ({
    page,
  }) => {
    await page.route('**/api/chats/**', (r) => r.fulfill({ status: 200, body: '{"ok":true}' }));
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await page.getByTestId('folder-archive-/home/tom/projects/bus').click({ force: true });
    await expect(page.getByTestId('confirm-modal')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-modal')).toHaveCount(0);
    // Nothing archived — the row is still there.
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
  });

  test('the cold-storage icon row is pinned to the BOTTOM of the sidebar, above the nav', async ({
    page,
  }) => {
    // Give the sidebar plenty of vertical slack so, if the row were in normal
    // flow, it would float up in the middle rather than sit at the bottom.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(HARNESS);

    const sidebar = page.getByTestId('sidebar');
    const archivedToggle = page.getByTestId('archived-toggle');
    const deletedToggle = page.getByTestId('deleted-toggle');
    const automationsToggle = page.getByTestId('automations-toggle');
    const bottomNav = page.getByTestId('bottom-nav');

    await expect(archivedToggle).toBeVisible();
    await expect(deletedToggle).toBeVisible();
    await expect(automationsToggle).toBeVisible();

    const sbBox = (await sidebar.boundingBox())!;
    const archBox = (await archivedToggle.boundingBox())!;
    const delBox = (await deletedToggle.boundingBox())!;
    const autoBox = (await automationsToggle.boundingBox())!;
    const navBox = (await bottomNav.boundingBox())!;

    // The icon row sits directly above the bottom nav — the free space is
    // ABOVE the row, not between it and the nav.
    const gapBelow = navBox.y - (archBox.y + archBox.height);
    expect(gapBelow).toBeLessThan(24);

    // And the row is pushed down into the lower portion of the sidebar rather
    // than following the folders in the middle.
    expect(archBox.y).toBeGreaterThan(sbBox.y + sbBox.height * 0.5);

    // Archived, Deleted and Automations are ONE row now (spec/14 § Sidebar
    // item 6 — "single icon buttons on bottom row"), not a vertical stack:
    // they share a vertical centre, left-to-right in the documented order,
    // all above the nav.
    expect(Math.abs(archBox.y - delBox.y)).toBeLessThan(1);
    expect(Math.abs(delBox.y - autoBox.y)).toBeLessThan(1);
    expect(archBox.x).toBeLessThan(delBox.x);
    expect(delBox.x).toBeLessThan(autoBox.x);
    expect(autoBox.y).toBeLessThan(navBox.y);
  });

  test('the cold-storage row is separated from the chat list by a visible divider', async ({
    page,
  }) => {
    // App Updates: "clear divider between open list and the main chats" — a
    // hairline the user can see, not merely the space that already sat there.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(HARNESS);

    const lifecycle = page.getByTestId('sb-lifecycle');
    const scroller = page.getByTestId('sb-scroll');
    const archived = page.getByTestId('archived-toggle');
    await expect(archived).toBeVisible();

    const border = await lifecycle.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: parseFloat(s.borderTopWidth), style: s.borderTopStyle };
    });
    expect(border.width).toBeGreaterThan(0);
    expect(border.style).not.toBe('none');

    // The divider sits between the scrolling chat list and the icon row, not
    // buried somewhere inside either of them.
    const scBox = (await scroller.boundingBox())!;
    const lcBox = (await lifecycle.boundingBox())!;
    expect(lcBox.y).toBeGreaterThanOrEqual(scBox.y + scBox.height - 1);
  });

  test('an EXPANDED lifecycle section sits directly below the icon row, closer to it than the row is to the chat list', async ({
    page,
  }) => {
    // The list belongs to the icon row that opened it: it must sit closer to
    // that row than the row itself sits to the chat list above.
    await page.route('**/api/chats?archived=include', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: [
            {
              chatId: 'arch_1',
              name: 'archived one',
              preview: 'preview',
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              lastUpdated: 1,
            },
          ],
        }),
      }),
    );
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(HARNESS);

    const icons = page.getByTestId('sb-lifecycle-icons');

    await page.getByTestId('archived-toggle').click();
    const section = page.getByTestId('archived-section');
    await expect(section).toBeVisible();

    const iconsBox = (await icons.boundingBox())!;
    const secBox = (await section.boundingBox())!;
    const scroller = page.getByTestId('sb-scroll');
    const scBox = (await scroller.boundingBox())!;

    // Order: chat list, icon row, then the opened list.
    expect(scBox.y + scBox.height).toBeLessThanOrEqual(iconsBox.y + 1);
    expect(iconsBox.y).toBeLessThan(secBox.y);

    const gapToOwnList = secBox.y - (iconsBox.y + iconsBox.height);
    const gapAboveRow = iconsBox.y - (scBox.y + scBox.height);
    expect(gapToOwnList).toBeLessThan(gapAboveRow);
  });

  test('+ New chat sits at the TOP of the sidebar, under the brand row and above everything else', async ({
    page,
  }) => {
    // patch/todo.md: "new chat should be at the top of the sidebar" — starting a
    // chat is the most-reached-for action, so it leads the fixed top band rather
    // than trailing the bottom nav (spec/14 § Sidebar §8).
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(HARNESS);

    const sidebar = page.getByTestId('sidebar');
    const brand = sidebar.locator('.sb-brand');
    const fab = page.getByTestId('new-chat-fab');
    const tabs = page.getByTestId('batch-tabs');
    const attention = page.getByTestId('attention-toggle');
    const scroller = page.getByTestId('sb-scroll');
    const bottomNav = page.getByTestId('bottom-nav');

    await expect(fab).toBeVisible();

    const brandBox = (await brand.boundingBox())!;
    const fabBox = (await fab.boundingBox())!;
    const tabsBox = (await tabs.boundingBox())!;
    const attBox = (await attention.boundingBox())!;
    const scBox = (await scroller.boundingBox())!;
    const navBox = (await bottomNav.boundingBox())!;

    // Directly under the brand row…
    expect(fabBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height - 1);
    expect(fabBox.y - (brandBox.y + brandBox.height)).toBeLessThan(24);
    // …and above every other sidebar band.
    expect(fabBox.y).toBeLessThan(tabsBox.y);
    expect(fabBox.y).toBeLessThan(attBox.y);
    expect(fabBox.y).toBeLessThan(scBox.y);
    expect(fabBox.y).toBeLessThan(navBox.y);
    // In the top quarter of the sidebar, not the bottom.
    const sbBox = (await sidebar.boundingBox())!;
    expect(fabBox.y).toBeLessThan(sbBox.y + sbBox.height * 0.25);

    // Still the New chat entry point: it navigates to the new-chat route.
    await fab.click();
    await expect(page.getByTestId('new-chat-setup')).toBeVisible();
  });

  test('chrome (brand, Archived/Deleted, nav, + New chat) is FIXED; only the chat list scrolls', async ({
    page,
  }) => {
    // A short viewport guarantees the chat list overflows. Previously the whole
    // `aside` scrolled, so the Archived/Deleted controls and the + New chat
    // button scrolled off the bottom and had to be hunted for (spec/14 § Sidebar
    // → Scroll regions).
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto(HARNESS);

    const sidebar = page.getByTestId('sidebar');
    const scroller = page.getByTestId('sb-scroll');
    const brand = sidebar.locator('.sb-brand');
    const archivedToggle = page.getByTestId('archived-toggle');
    const bottomNav = page.getByTestId('bottom-nav');
    const fab = page.getByTestId('new-chat-fab');

    // The aside itself never scrolls — its chrome is fixed.
    const sbMetrics = await sidebar.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(sbMetrics.scrollHeight).toBeLessThanOrEqual(sbMetrics.clientHeight + 1);

    // The chat list is a real scroll region and, at this height, overflows.
    const scMetrics = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(scMetrics.overflowY).toBe('auto');
    expect(scMetrics.scrollHeight).toBeGreaterThan(scMetrics.clientHeight);

    // Every piece of chrome is fully inside the sidebar's visible box.
    const sbBox = (await sidebar.boundingBox())!;
    for (const el of [brand, archivedToggle, bottomNav, fab]) {
      const box = (await el.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(sbBox.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(sbBox.y + sbBox.height + 1);
    }

    // Scrolling the chat list to the bottom moves the chats but NOTHING else.
    const before = {
      brand: (await brand.boundingBox())!.y,
      archived: (await archivedToggle.boundingBox())!.y,
      nav: (await bottomNav.boundingBox())!.y,
      fab: (await fab.boundingBox())!.y,
    };
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect((await brand.boundingBox())!.y).toBeCloseTo(before.brand, 0);
    expect((await archivedToggle.boundingBox())!.y).toBeCloseTo(before.archived, 0);
    expect((await bottomNav.boundingBox())!.y).toBeCloseTo(before.nav, 0);
    expect((await fab.boundingBox())!.y).toBeCloseTo(before.fab, 0);
  });

  // Seed `count` extra active chats into the real store the harness exposes,
  // so the chat list is far taller than the sidebar.
  async function seedManyChats(page: import('@playwright/test').Page, count: number) {
    await page.evaluate((n) => {
      const store = (window as unknown as { __store: { getState: () => Record<string, unknown> } })
        .__store;
      const merge = store.getState().mergeChats as (rows: unknown[]) => void;
      merge(
        Array.from({ length: n }, (_v, i) => ({
          chatId: `bulk_${i}`,
          name: `bulk chat ${i}`,
          preview: null,
          folder: `/home/tom/projects/proj${i % 5}`,
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 1000 + i,
        })),
      );
    }, count);
  }

  test('a long chat list scrolls within the window height — it never squeezes or clips Archived/Deleted', async ({
    page,
  }) => {
    // The regression: `.sb-lifecycle` was allowed to SHRINK, so once the chat
    // list overflowed the flexbox compressed the lifecycle group to a few
    // pixels and both toggles were clipped out of view — the user could no
    // longer reach Archived or Deleted at all (spec/14 § Sidebar → Scroll
    // regions: the chat list is the only band that yields).
    await page.goto(HARNESS);
    await seedManyChats(page, 60);

    const lifecycle = page.getByTestId('sb-lifecycle');
    const archivedToggle = page.getByTestId('archived-toggle');
    const deletedToggle = page.getByTestId('deleted-toggle');
    const fab = page.getByTestId('new-chat-fab');
    const scroller = page.getByTestId('sb-scroll');
    const sidebar = page.getByTestId('sidebar');

    // The chat list really is overflowing (otherwise this proves nothing).
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);

    // Collapsed, the lifecycle group hides NOTHING inside itself.
    const lcMetrics = await lifecycle.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(lcMetrics.scrollHeight).toBeLessThanOrEqual(lcMetrics.clientHeight + 1);

    // Both toggles sit fully inside the group's visible box…
    const lcBox = (await lifecycle.boundingBox())!;
    for (const el of [archivedToggle, deletedToggle]) {
      const box = (await el.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(lcBox.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(lcBox.y + lcBox.height + 1);
    }

    // …and inside the sidebar, along with + New chat.
    const sbBox = (await sidebar.boundingBox())!;
    for (const el of [archivedToggle, deletedToggle, fab]) {
      const box = (await el.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(sbBox.y + sbBox.height + 1);
    }

    // The controls are genuinely reachable, not merely positioned. Playwright's
    // actionability check before the click is what proves that — it refuses a
    // control that is covered, off-screen or not hit-testable. The timeout is
    // only how long we wait for it to become actionable, NOT part of the claim:
    // at 2s this failed on a loaded box (four workers sharing it) and reported a
    // clipped-sidebar regression that wasn't there.
    await deletedToggle.click({ timeout: 10_000 });
    await expect(page.getByTestId('deleted-section')).toBeVisible();
  });

  test('an EXPANDED archived list caps at half the sidebar and scrolls itself, nav still fixed', async ({
    page,
  }) => {
    await page.route('**/api/chats?archived=include', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: Array.from({ length: 40 }, (_v, i) => ({
            chatId: `arch_${i}`,
            name: `archived ${i}`,
            preview: 'preview',
            folder: '/home/tom/projects/portfolio',
            activity: 'idle',
            status: 'archived',
            pinned: false,
            pinnedAt: null,
            lastUpdated: i,
          })),
        }),
      }),
    );
    await page.goto(HARNESS);
    await seedManyChats(page, 60);

    const sidebar = page.getByTestId('sidebar');
    const lifecycle = page.getByTestId('sb-lifecycle');
    const bottomNav = page.getByTestId('bottom-nav');
    const fab = page.getByTestId('new-chat-fab');

    await page.getByTestId('archived-toggle').click();
    await expect(page.getByTestId('archived-section')).toBeVisible();

    const sbBox = (await sidebar.boundingBox())!;
    // Capped at half the sidebar, and scrolling within itself.
    await expect
      .poll(async () => (await lifecycle.boundingBox())!.height)
      .toBeLessThanOrEqual(sbBox.height * 0.5 + 1);
    const lcMetrics = await lifecycle.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(lcMetrics.overflowY).toBe('auto');
    expect(lcMetrics.scrollHeight).toBeGreaterThan(lcMetrics.clientHeight);

    // Nav + New chat still fully on screen.
    for (const el of [bottomNav, fab]) {
      const box = (await el.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(sbBox.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(sbBox.y + sbBox.height + 1);
    }
  });

  test('Drafts section lists drafts with text and switching a draft restores its composer text', async ({
    page,
  }) => {
    // Seed two persisted drafts BEFORE the app boots (draftStore reads
    // localStorage on module load).
    await page.addInitScript(() => {
      const drafts = {
        'draft-a': {
          id: 'draft-a',
          folder: '/home/tom/projects/garden',
          text: 'wildflower meadow plan',
          updatedAt: 2,
        },
        'draft-b': {
          id: 'draft-b',
          folder: '/home/tom/projects/bus',
          text: 'check the bus thresholds',
          updatedAt: 1,
        },
      };
      window.localStorage.setItem(
        'patch.drafts.v1',
        JSON.stringify({ drafts, order: ['draft-a', 'draft-b'] }),
      );
    });
    await page.goto(HARNESS);
    const section = page.getByTestId('drafts-section');
    await expect(section).toBeVisible();
    await expect(section.getByTestId('draft-row-draft-a')).toContainText('wildflower meadow plan');
    await expect(section.getByTestId('draft-row-draft-b')).toContainText(
      'check the bus thresholds',
    );
    // Open draft-b → its unsent text is restored into the composer.
    await section.getByTestId('draft-row-draft-b').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('check the bus thresholds');
  });

  // The discard × lives inside `.row-when`, the slot the row-hover rule hides so
  // the tools can cover the time. Draft rows have no `.row-tools`, so hiding that
  // slot on hover took the × with it: it vanished at the exact moment you moved
  // the mouse to click it (spec/14 § New chat drafts — "a hover × discards it").
  test('a draft row × is visible AND clickable while the row is hovered, and discards that draft', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const drafts = {
        'draft-a': {
          id: 'draft-a',
          folder: '/home/tom/projects/garden',
          text: 'wildflower meadow plan',
          updatedAt: 2,
        },
        'draft-b': {
          id: 'draft-b',
          folder: '/home/tom/projects/bus',
          text: 'check the bus thresholds',
          updatedAt: 1,
        },
      };
      window.localStorage.setItem(
        'patch.drafts.v1',
        JSON.stringify({ drafts, order: ['draft-a', 'draft-b'] }),
      );
    });
    await page.goto(HARNESS);
    const section = page.getByTestId('drafts-section');
    const row = section.getByTestId('draft-row-draft-a');
    const discard = section.getByTestId('draft-discard-draft-a');
    await expect(row).toBeVisible();

    // Hovering the row must REVEAL the ×, not hide it. `toBeVisible()` fails on
    // a `visibility: hidden` ancestor, which is exactly the regression.
    await row.hover();
    await expect(discard).toBeVisible();
    await expect.poll(async () => discard.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    // The ancestor slot must not be hidden out from under it.
    expect(await discard.evaluate((el) => getComputedStyle(el.parentElement!).visibility)).toBe(
      'visible',
    );

    // A REAL click (no force): an unclickable button fails here rather than
    // being clicked through by the test harness.
    await discard.click();

    await expect(section.getByTestId('draft-row-draft-a')).toHaveCount(0);
    // The other draft is untouched.
    await expect(section.getByTestId('draft-row-draft-b')).toBeVisible();
  });
});
