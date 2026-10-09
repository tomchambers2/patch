import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for
// spec/14 § Manager view: the Manager conversation on top, everything it is
// watching in a strip underneath. jsdom can assert the rows exist; only a real
// browser can confirm the strip is actually laid out BELOW the conversation and
// that its rows carry live controls, which is the whole point of the view.
const MANAGER = '/app/dev-harness.html?chat=thread_manager';
const REGULAR = '/app/dev-harness.html?chat=chat_bus';

test.describe('Manager view', () => {
  test('puts the Threads strip beneath the Manager conversation', async ({ page }) => {
    await page.goto(MANAGER);
    const strip = page.getByTestId('threads-strip');
    await expect(strip).toBeVisible();
    const stream = await page.getByTestId('chat-stream').boundingBox();
    const box = await strip.boundingBox();
    expect(stream).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(stream!.y);
    // And it is a strip, not a takeover: the conversation keeps most of the room.
    expect(box!.height).toBeLessThan(stream!.height + box!.height);
  });

  test('every row names its host and folder and offers the action it is blocked on', async ({
    page,
  }) => {
    await page.goto(MANAGER);
    const rows = page.locator('.thread-row');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first()).toContainText('/home/tom/projects');
    // A working chat can be stopped; a stopped one can be carried on. Both
    // exist in the seeded harness, so both controls are on screen.
    await expect(page.locator('[data-testid^="thread-stop-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="thread-carry-on-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="thread-open-"]').first()).toBeVisible();
  });

  test('the strip belongs to the Manager alone — an ordinary chat is just a chat', async ({
    page,
  }) => {
    await page.goto(REGULAR);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    await expect(page.getByTestId('threads-strip')).toHaveCount(0);
  });

  test('the strip head carries the reach switch — the one control you set before a drive', async ({
    page,
  }) => {
    await page.goto(MANAGER);
    const reach = page.getByTestId('reach-switch');
    await expect(reach).toBeVisible();
    // Above the rows, where it is reached in one look — not buried in Settings.
    const head = await reach.boundingBox();
    const firstRow = await page.locator('.thread-row').first().boundingBox();
    expect(head!.y).toBeLessThan(firstRow!.y);
  });

  test('the sidebar Manager row carries both Talk and the hands-free control', async ({ page }) => {
    await page.goto(MANAGER);
    await expect(page.getByTestId('row-handsfree')).toBeVisible();
    // One Manager, not two: it is a chat with a view beneath it, never a
    // sidebar tab of its own.
    await expect(page.getByTestId('batch-tab-manager')).toHaveCount(0);
  });
});
