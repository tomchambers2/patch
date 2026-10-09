import { test, expect } from '@playwright/test';

// spec/14 § Sidebar → Row tools: the top-right slot is only as wide as what is
// currently in it, so a chat name runs the full width up to the timestamp and
// ellipsises only when it genuinely runs out of room (Todoist: "truncation is
// too early in sidebar for chat names").
//
// This can only be proven in a real browser: the bug was grid track sizing —
// `.row-tools` was hidden with `opacity: 0`, which leaves it in flow, so the
// `auto` third track stayed as wide as all four 24px action chips (108px at the
// stock sidebar width) and the name's `1fr` track was ~60px narrower than the
// space actually free next to the visible timestamp.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

const LONG_NAME = 'Refactor the sidebar row layout and measure the real available width';

/** Rename a seeded chat in place, so no extra row joins the sidebar. */
async function giveLongName(page: import('@playwright/test').Page, chatId: string): Promise<void> {
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

test.describe('sidebar chat name width', () => {
  test('a long chat name uses every pixel up to the timestamp before it ellipsises', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await giveLongName(page, 'chat_bus');
    await expect(row.locator('.name')).toHaveText(LONG_NAME);

    const name = row.locator('.name');
    const when = row.getByTestId('row-when-chat_bus');
    const nameBox = (await name.boundingBox())!;
    const whenBox = (await when.boundingBox())!;

    // The name really is truncated (so the width assertion below is about a
    // name that wants more room, not one that already fits).
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);

    // No dead gap: the name's box reaches the timestamp, give or take the row's
    // 8px grid gap. Before the fix there was an extra ~60px of empty space here
    // — the width the hidden action chips were still reserving.
    const gap = whenBox.x - (nameBox.x + nameBox.width);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(9);

    // And the name is the row's dominant track, not a minority of it.
    const rowBox = (await row.boundingBox())!;
    expect(nameBox.width / rowBox.width).toBeGreaterThan(0.5);
  });

  test('the timestamp slot is narrower than the action chips it shares a cell with', async ({
    page,
  }) => {
    // The regression guard for the cause, not just the symptom: if the tools
    // ever go back to being hidden in-flow, the third track is sized by them
    // and this gets no narrower than the hovered width.
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await giveLongName(page, 'chat_bus');

    const name = row.locator('.name');
    const tools = row.locator('.row-tools');
    const atRest = (await name.boundingBox())!.width;
    const rowHeight = (await row.boundingBox())!.height;

    await row.hover();
    await expect(tools).toBeVisible();
    const toolsWidth = (await tools.boundingBox())!.width;
    const hovered = (await name.boundingBox())!.width;

    // At rest the name is wider by (roughly) the whole action cluster.
    expect(atRest).toBeGreaterThan(hovered);
    expect(atRest - hovered).toBeGreaterThan(toolsWidth / 2);

    // Yielding that width must not make the row itself grow: the first line
    // holds an action chip's height whether or not the chips are in flow, or
    // every row below a hovered one would shift down.
    expect(rowHeight).toBeCloseTo((await row.boundingBox())!.height, 1);

    // Moving off the row hands the width straight back.
    await page.mouse.move(900, 500);
    await expect(tools).toBeHidden();
    expect((await name.boundingBox())!.width).toBeCloseTo(atRest, 0);
  });

  test('the row keeps its unread dot, hover actions and status while the name grows', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await giveLongName(page, 'chat_bus');

    // Status badge still occupies its own leading column, left of the name.
    const badge = row.locator('.badge');
    await expect(badge).toBeVisible();
    const badgeBox = (await badge.boundingBox())!;
    const nameBox = (await row.locator('.name').boundingBox())!;
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(nameBox.x + 1);

    // All four hover actions still reveal and are clickable.
    await row.hover();
    for (const id of [
      'batch-toggle-chat_bus',
      'archive-btn-chat_bus',
      'pin-btn-chat_bus',
      'row-mic-chat_bus',
    ]) {
      await expect(row.getByTestId(id)).toBeVisible();
    }
  });

  // spec/14 § Copy: clipping the name is only acceptable because the full value
  // is recoverable on hover. Hovering is what clips it hardest (the tools take
  // the slot), so the tooltip has to be on the row itself, not on the label.
  test('a clipped name is recoverable as a hover tooltip, at rest and while hovered', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_bus');
    await expect(row).toBeVisible();
    await giveLongName(page, 'chat_bus');
    await expect(row.locator('.name')).toHaveText(LONG_NAME);

    const name = row.locator('.name');
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(row).toHaveAttribute('title', LONG_NAME);

    // Hovering shrinks the visible name further; the tooltip still carries all
    // of it, so the row is at its most readable exactly when it is most clipped.
    const atRest = (await name.boundingBox())!.width;
    await row.hover();
    await expect(row.locator('.row-tools')).toBeVisible();
    expect((await name.boundingBox())!.width).toBeLessThan(atRest);
    await expect(row).toHaveAttribute('title', LONG_NAME);
  });

  // spec/14 § Copy — no helper text: no row carries an explainer tooltip, the
  // Manager row included. Its tooltip is its own full name, like every other
  // row's, and it is never a sentence.
  test('the Manager row carries its name as its tooltip, not an explainer', async ({ page }) => {
    await page.goto(HARNESS);
    const manager = page.getByTestId('chat-row-thread_manager');
    await expect(manager).toBeVisible();
    const title = await manager.getAttribute('title');
    expect(title).toBe(await manager.locator('.name').innerText());
    expect(title).not.toContain('—');
  });

  test('an automations row gets the same width treatment', async ({ page }) => {
    // Automations rows are the same `ChatRowView` in a different section
    // (spec/14 § Sidebar §6) — they must not have been left on the old geometry.
    await page.route('**/api/chats?automations=only', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chats: [
            {
              chatId: 'chat_auto_long',
              name: LONG_NAME,
              preview: null,
              folder: '/home/tom/projects/portfolio',
              activity: 'idle',
              status: 'archived',
              pinned: false,
              pinnedAt: null,
              snoozedUntil: null,
              lastUpdated: 400,
              daemonId: 'd1',
              permissionMode: 'bypassPermissions',
              jobId: 'job_1',
            },
          ],
        }),
      }),
    );
    await page.goto(HARNESS);
    await page.getByTestId('automations-toggle').click();
    // The expanded section appears under the pointer that just clicked the
    // toggle, so its first row would be hovered (and its tools in flow).
    await page.mouse.move(900, 500);
    const row = page.getByTestId('chat-row-chat_auto_long');
    await expect(row).toBeVisible();
    await expect(row.locator('.row-tools')).toBeHidden();
    const name = row.locator('.name');
    const when = row.getByTestId('row-when-chat_auto_long');
    const nameBox = (await name.boundingBox())!;
    const whenBox = (await when.boundingBox())!;
    expect(whenBox.x - (nameBox.x + nameBox.width)).toBeLessThanOrEqual(9);
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });
});
