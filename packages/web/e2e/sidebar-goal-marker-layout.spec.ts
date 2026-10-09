import { test, expect } from '@playwright/test';

// spec/04 § Goals, spec/14 § Sidebar — a chat working toward a goal carries a
// marker beside its badge, purely informational.
//
// REGRESSION (Todoist "patch goal sidebar broken", screenshot attached): the
// goal marker used to render as a GRID-ITEM SIBLING of `.name`, but `.sb-row`
// is a 3-column grid (badge · name · top-right slot) with no column reserved
// for an extra sibling. CSS auto-placement dropped the marker into the name's
// own cell (column 2) and shoved `.name` itself into an implicit next grid
// row — cramming the title into the 18px badge column, so a chat named "July
// Seasonal Food" rendered as "H…" on a line of its own below the badge/marker
// row. Only a real browser lays out CSS grid; jsdom applies no stylesheet, so
// a unit test asserting `goal-marker` is merely present (Sidebar.test.tsx)
// passed throughout and never caught this.

async function seedGoal(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => '__store' in window);
  await page.evaluate(() => {
    const w = window as unknown as {
      __store: { getState: () => { setGoal: (chatId: string, goal: string | null) => void } };
    };
    w.__store.getState().setGoal('chat_md', 'Ship the release by Friday');
  });
}

test.describe('sidebar goal marker — does not break the row layout', () => {
  test('the chat title still renders full-width, on the same line as the badge', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await seedGoal(page);

    const row = page.locator('[data-testid="chat-row-chat_md"]');
    const marker = row.locator('[data-testid="goal-marker-chat_md"]');
    const name = row.locator('.name');

    await expect(marker).toBeVisible();
    await expect(name).toBeVisible();

    // The title must render in full, not truncated to the 18px badge column.
    await expect(name).toHaveText('July Seasonal Food');

    const [markerBox, nameBox] = await Promise.all([marker.boundingBox(), name.boundingBox()]);
    expect(markerBox).not.toBeNull();
    expect(nameBox).not.toBeNull();

    // Marker and title sit on the same visual line (same row of the grid) —
    // the bug put the title on an implicit SECOND row, well below the marker.
    expect(Math.abs(markerBox!.y - nameBox!.y)).toBeLessThanOrEqual(8);

    // The title's own box must be wide enough to hold its text, not squeezed
    // into the 18px track reserved for the status badge.
    expect(nameBox!.width).toBeGreaterThan(40);

    // The row itself stays a single text-line tall — the bug's wrapped title
    // grew the row to two lines.
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.height).toBeLessThanOrEqual(42);
  });
});
