import { test, expect, type Page } from '@playwright/test';

// spec/14 § Row tools: the hover-revealed row actions and the folder header's
// archive buttons must be reachable by keyboard, and must not be firable while
// invisible.
//
// This can only be proven in a real browser. `.row-tools` is `display: none` at
// rest, so nothing inside it is tabbable — a rule keyed on the cluster's own
// focus can never fire, and the reveal has to hang off the row (which is a
// link, and is therefore the thing Tab reaches first). `.folder-archive-btn` had
// the mirror-image bug: `opacity: 0` leaves it in flow AND in the tab order, so
// "Archive all in this project" was reachable on a button with nothing painted.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

/** Whatever currently holds focus, by `data-testid`. */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

/**
 * Tab forward until `testId` holds focus. Real key presses, not `.focus()`:
 * the reveal is keyed on `:focus-visible`, which only matches once the browser
 * has seen keyboard interaction.
 *
 * `max` is only a runaway guard, but it has to clear the WHOLE seeded sidebar:
 * every fixture chat in `dev-harness.tsx` contributes several tab stops (the
 * row plus its revealed tools) ahead of the row being walked to. It was 80,
 * which was under the real cost of the fixture list and blew up — as
 * "never reached chat-row-chat_bus in 80 tabs" — the next time anyone added a
 * chat to the harness, in a spec with nothing to do with that chat. Keep it
 * comfortably above the list's cost rather than trimmed to it.
 */
async function tabTo(page: Page, testId: string, max = 300): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if ((await focusedTestId(page)) === testId) return;
  }
  throw new Error(
    `never reached ${testId} in ${max} tabs (stopped on ${await focusedTestId(page)})`,
  );
}

/** The pointer parked far from the sidebar, so nothing is revealed by hover. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(900, 500);
}

test.describe('sidebar row tools — keyboard', () => {
  test('tabbing to a row reveals its tools, and Tab then walks through them', async ({ page }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await parkPointer(page);

    const tools = row.locator('.row-tools');
    await expect(tools).toBeHidden();

    await tabTo(page, 'chat-row-chat_bus');

    // Focusing the row is what brings the cluster into existence — before the
    // fix this stayed `display: none` and the four actions below were simply
    // skipped by Tab, unreachable without a pointer.
    await expect(tools).toBeVisible();

    // …and the actions really are in the tab order now, in row-tools order.
    for (const id of [
      'batch-toggle-chat_bus',
      'archive-btn-chat_bus',
      'pin-btn-chat_bus',
      'row-mic-chat_bus',
    ]) {
      await page.keyboard.press('Tab');
      expect(await focusedTestId(page)).toBe(id);
      // The cluster stays revealed while focus is inside it: the button holding
      // focus is on screen at the moment it could be activated.
      await expect(row.getByTestId(id)).toBeVisible();
      await expect(tools).toBeVisible();
    }
  });

  test('a focused row hides its time, exactly as a hovered one does', async ({ page }) => {
    // The tools overlay the time in one shared slot (§ Row tools). If focus
    // revealed the tools without hiding the time, the timestamp would show
    // through the gaps between the chips.
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await parkPointer(page);

    const time = row.locator('.when-time');
    await expect(time).toBeVisible();
    await tabTo(page, 'chat-row-chat_bus');
    await expect(time).toBeHidden();
  });

  test('tabbing away puts the row back to rest', async ({ page }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await parkPointer(page);

    const tools = row.locator('.row-tools');
    await tabTo(page, 'chat-row-chat_bus');
    await expect(tools).toBeVisible();

    // Past the four chips and on to the next row.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    await expect(tools).toBeHidden();
    await expect(row.locator('.when-time')).toBeVisible();
  });

  test('CLICKING a row does not leave its tools stuck open', async ({ page }) => {
    // A click focuses the link, so a plain `:focus-within` reveal would leave
    // the open chat's row permanently showing its chips with its time hidden —
    // the reveal is deliberately `:focus-visible` (keyboard) only.
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();

    await row.click();
    await parkPointer(page);

    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'chat-row-chat_bus',
    );
    await expect(row.locator('.row-tools')).toBeHidden();
    await expect(row.locator('.when-time')).toBeVisible();
  });

  test('a deleted row can be restored from the keyboard', async ({ page }) => {
    // A deleted row's ONLY control is the inline Restore, and it is
    // display-toggled on hover too — so it had the same defect.
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
    await parkPointer(page);

    const restore = page.getByTestId('restore-btn-chat_bus');
    await expect(restore).toBeHidden();

    await tabTo(page, 'chat-row-chat_bus');
    await expect(restore).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await focusedTestId(page)).toBe('restore-btn-chat_bus');
    await expect(restore).toBeVisible();
  });
});

test.describe('folder archive buttons — keyboard', () => {
  const ARCHIVE = 'folder-archive-/home/tom/projects/bus';
  const ARCHIVE_ALL = 'folder-archive-all-/home/tom/projects/bus';

  /** Settled opacity — these fade over 120ms, so a bare read catches it mid-way. */
  async function expectOpacity(page: Page, testId: string, want: number): Promise<void> {
    await expect
      .poll(async () =>
        Number(await page.getByTestId(testId).evaluate((el) => getComputedStyle(el).opacity)),
      )
      .toBe(want);
  }

  test('a focused folder-archive button paints itself instead of firing invisibly', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId(ARCHIVE)).toBeAttached();
    await parkPointer(page);

    // At rest they are transparent — but still focusable, which is precisely
    // why they have to reveal on focus rather than stay unpainted.
    await expectOpacity(page, ARCHIVE, 0);
    await expectOpacity(page, ARCHIVE_ALL, 0);

    await tabTo(page, ARCHIVE);
    await expectOpacity(page, ARCHIVE, 1);

    // Tab on: the destructive "archive ALL in this project" is likewise never
    // focused-but-invisible.
    await page.keyboard.press('Tab');
    expect(await focusedTestId(page)).toBe(ARCHIVE_ALL);
    await expectOpacity(page, ARCHIVE_ALL, 1);
  });

  test('hover still reveals the whole cluster', async ({ page }) => {
    // Regression guard: the focus rule is per-button, so the section-hover rule
    // that shows BOTH must survive alongside it.
    await page.goto(HARNESS);
    const folder = page.locator('.sb-folder', { hasText: 'bus' }).first();
    await folder.locator('.folder-head').hover();
    await expectOpacity(page, ARCHIVE, 1);
    await expectOpacity(page, ARCHIVE_ALL, 1);
  });
});
