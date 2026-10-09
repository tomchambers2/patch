import { test, expect } from '@playwright/test';

// spec/14 § Sidebar §3 (Pinned chats): a pinned row is drawn exactly like an
// in-folder row — its top-right slot shows the relative time at rest and yields
// to the action icons only on hover — with a small accent pin glyph beside the
// name carrying the pinned state instead.
//
// The regression this guards is layout, so it can only be proven in a real
// browser. Pinning used to hold `.row-tools` open at rest (`.sb-row.pinned
// .row-tools { display: inline-flex }`) and blank the time (`.sb-row.pinned
// .row-when { visibility: hidden }`). Because the time and the tools share ONE
// `auto` grid track, holding four 24px chips in it both hid the timestamp
// outright and left the name's `1fr` track about half its normal width — so the
// chats singled out as important were the only ones whose titles could not be
// read.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

const LONG_NAME = 'Sync everything to hetzner and then check the deploy logs afterwards';

type Page = import('@playwright/test').Page;

/** Rename a seeded chat in place, so no extra row joins the sidebar. */
async function giveLongName(page: Page, chatId: string): Promise<void> {
  await page.evaluate(
    ([id, name]) => {
      (
        window as unknown as {
          __store: { getState: () => { setName: (c: string, n: string | null) => void } };
        }
      ).__store
        .getState()
        .setName(id, name);
    },
    [chatId, LONG_NAME] as const,
  );
}

/** Pin/unpin a seeded chat through the store, as the REST round-trip would. */
async function setPinned(page: Page, chatId: string, pinned: boolean): Promise<void> {
  await page.evaluate(
    ([id, next]) => {
      (
        window as unknown as {
          __store: { getState: () => { setPinned: (c: string, p: boolean) => void } };
        }
      ).__store
        .getState()
        .setPinned(id as string, next as boolean);
    },
    [chatId, pinned] as const,
  );
}

/** Park the pointer clear of the sidebar so no row is hovered. */
async function unhover(page: Page): Promise<void> {
  await page.mouse.move(900, 500);
}

test.describe('pinned sidebar row', () => {
  test('pinning a chat costs its title none of its width', async ({ page }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await giveLongName(page, 'chat_bus');
    await unhover(page);
    await expect(row.locator('.row-tools')).toBeHidden();

    const unpinnedWidth = (await row.locator('.name').boundingBox())!.width;
    const unpinnedHeight = (await row.boundingBox())!.height;

    await setPinned(page, 'chat_bus', true);
    // The row is re-drawn in the Pinned section; wait for it to land there.
    await expect(page.getByTestId('pinned-section').getByTestId('chat-row-chat_bus')).toBeVisible();
    await unhover(page);
    await expect(row.locator('.row-tools')).toBeHidden();

    const pinnedWidth = (await row.locator('.name').boundingBox())!.width;

    // The name track is the SAME width pinned as unpinned. Before the fix this
    // was roughly halved (97px against 157px at the stock sidebar width)
    // because the held-open action chips sized the shared third track.
    expect(pinnedWidth).toBeCloseTo(unpinnedWidth, 0);

    // Seating the glyph turns `.name` into a flex container — that must not
    // make the row taller, or pinning a chat would shunt the whole list down.
    expect((await row.boundingBox())!.height).toBeCloseTo(unpinnedHeight, 1);
  });

  test('a pinned row shows its timestamp at rest and hides it under the tools on hover', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await setPinned(page, 'chat_bus', true);
    const row = page.getByTestId('pinned-section').getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await unhover(page);

    // At rest: the time is readable, exactly as on any other row.
    const when = row.getByTestId('row-when-chat_bus');
    await expect(when).toBeVisible();
    await expect(when.locator('.when-time')).not.toBeEmpty();
    expect((await when.boundingBox())!.width).toBeGreaterThan(0);

    // On hover the tools take the slot over and the time steps out of sight,
    // rather than showing through the gaps between the chips.
    await row.hover();
    await expect(row.locator('.row-tools')).toBeVisible();
    await expect(when).toBeHidden();

    // And leaving hands the time straight back.
    await unhover(page);
    await expect(row.locator('.row-tools')).toBeHidden();
    await expect(when).toBeVisible();
  });

  test('a pinned row marks its state at rest and keeps its full tool cluster on hover', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await giveLongName(page, 'chat_bus');
    await setPinned(page, 'chat_bus', true);
    const row = page.getByTestId('pinned-section').getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await unhover(page);

    // Pinned state still reads without hovering — the glyph sits left of the
    // title, inside the name's own column rather than in the top-right slot.
    const glyph = row.getByTestId('name-pin-chat_bus');
    await expect(glyph).toBeVisible();
    const glyphBox = (await glyph.boundingBox())!;
    const textBox = (await row.locator('.name-text').boundingBox())!;
    expect(glyphBox.x + glyphBox.width).toBeLessThanOrEqual(textBox.x + 1);

    // The title still ellipsises on the inner text element (the outer `.name`
    // is a flex container once it carries the glyph, so it is the inner span
    // that overflows).
    expect(await row.locator('.name-text').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      true,
    );
    await expect(row.locator('.name')).toHaveText(LONG_NAME);

    // Hovering reveals all four actions, same as any other row, with the pin
    // reading as active.
    await row.hover();
    for (const id of [
      'batch-toggle-chat_bus',
      'archive-btn-chat_bus',
      'pin-btn-chat_bus',
      'row-mic-chat_bus',
    ]) {
      await expect(row.getByTestId(id)).toBeVisible();
    }
    await expect(row.getByTestId('pin-btn-chat_bus')).toHaveClass(/is-pinned/);
  });

  test('a pinned row leaves no dead gap between its title and its timestamp', async ({ page }) => {
    // The cause-level guard: if the tools ever go back to being held open (or
    // hidden in-flow) on pinned rows, the shared third track is sized by them
    // again and this gap reopens.
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    await giveLongName(page, 'chat_bus');
    await setPinned(page, 'chat_bus', true);
    const row = page.getByTestId('pinned-section').getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await unhover(page);

    const nameBox = (await row.locator('.name').boundingBox())!;
    const whenBox = (await row.getByTestId('row-when-chat_bus').boundingBox())!;
    const gap = whenBox.x - (nameBox.x + nameBox.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(9);

    // The name is the row's dominant track, not a minority of it.
    const rowBox = (await row.boundingBox())!;
    expect(nameBox.width / rowBox.width).toBeGreaterThan(0.5);
  });

  test('the Manager row still keeps its tools open at rest', async ({ page }) => {
    // Manager is the one row that legitimately owns the slot outright
    // (spec/14 § Row tools) — the pinned change must not have swept it up.
    await page.goto(HARNESS);
    const manager = page.getByTestId('chat-row-thread_manager');
    await expect(manager).toBeVisible();
    await unhover(page);
    await expect(manager.locator('.row-tools')).toBeVisible();
    await expect(manager.getByTestId('name-pin-thread_manager')).toHaveCount(0);
  });
});
