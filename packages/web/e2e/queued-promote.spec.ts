import { test, expect } from '@playwright/test';

// spec/04 ## Message queueing § Promote; spec/14 § Running-turn controls —
// "should be possible to promote a queued message and interrupt, little up
// arrow on hover" (patch/todo.md).
//
// jsdom proves the wiring (chat.promote_request fires; no local reorder). This
// proves the affordance with the REAL CSS: the ↑ is always visible (it is the
// queued message's most useful control and must not depend on discovering
// hover), it sits left of the ×, and clicking it never reorders the queued
// block — turns queued above it are already scheduled to run sooner and get
// pushed along with it, not shoved behind it.
const QUEUED = '/app/dev-harness.html?chat=chat_queued';

test.describe('queued message promote (↑)', () => {
  test('the ↑ is always visible at rest, and sits left of the ×', async ({ page }) => {
    await page.goto(QUEUED);
    const second = page.locator('[data-queued="true"]').nth(1);
    await expect(second).toBeVisible();

    const promote = second.getByTestId('queued-promote');
    // Visible without hover or focus.
    await expect(promote).toHaveCSS('opacity', '1');

    // Constructive control before the destructive one.
    const up = await promote.boundingBox();
    const remove = await second.getByTestId('queued-remove').boundingBox();
    if (!up || !remove) throw new Error('missing queued control boxes');
    expect(up.x).toBeLessThan(remove.x);
    // A real, clickable target, not a 0-sized sliver.
    expect(up.width).toBeGreaterThanOrEqual(16);
    expect(up.height).toBeGreaterThanOrEqual(16);
  });

  // spec/04 ## Message queueing — the chip says WHEN the turn goes in. Position
  // is counted over the queued block as rendered, so removing the head renumbers
  // the rest immediately — the numbering never contradicts what's on screen.
  test('the queue numbers itself, and removing the head renumbers the rest', async ({ page }) => {
    await page.goto(QUEUED);
    const queued = page.locator('[data-queued="true"]');
    await expect(queued.nth(0).getByTestId('queued-badge')).toHaveText('Queued');
    await expect(queued.nth(1).getByTestId('queued-badge')).toHaveText('2nd in queue');
    await expect(queued.nth(0).getByTestId('queued-badge')).toHaveAttribute(
      'title',
      'Runs when the current turn finishes',
    );

    await queued.nth(0).hover();
    await queued.nth(0).getByTestId('queued-remove').click();

    // The second turn moves up and now owns "Queued".
    const after = page.locator('[data-queued="true"]');
    await expect(after).toHaveCount(1);
    await expect(after.nth(0)).toContainText('second queued turn');
    await expect(after.nth(0).getByTestId('queued-badge')).toHaveText('Queued');
  });

  test('clicking ↑ never reorders the queued block — the turn queued above stays above', async ({
    page,
  }) => {
    await page.goto(QUEUED);
    const queued = page.locator('[data-queued="true"]');
    await expect(queued.nth(0)).toContainText('first queued turn');
    await expect(queued.nth(1)).toContainText('second queued turn');

    await queued.nth(1).hover();
    await queued.nth(1).getByTestId('queued-promote').click();

    // Pushing the second queued turn pushes the first along with it too —
    // it is not shoved behind the one that was clicked.
    await expect(page.locator('[data-queued="true"]').nth(0)).toContainText('first queued turn');
    await expect(page.locator('[data-queued="true"]').nth(1)).toContainText('second queued turn');
    // The settled turn above them never moved.
    await expect(page.getByTestId('msg').first()).toContainText('the running turn');
  });

  // spec/04 ## Message queueing — the queued block is the last thing in the
  // stream. jsdom proves the DOM order; this proves what Tom actually sees:
  // the dots sit ABOVE the queued turns on screen.
  test('the queued block sits below the thinking indicator while the turn runs', async ({
    page,
  }) => {
    await page.goto(QUEUED);
    const indicator = page.getByTestId('thinking-indicator');
    await expect(indicator).toBeVisible();

    const dots = await indicator.boundingBox();
    const first = await page.locator('[data-queued="true"]').nth(0).boundingBox();
    const settled = await page.getByTestId('msg').first().boundingBox();
    if (!dots || !first || !settled) throw new Error('missing stream boxes');

    // Settled turn, then the dots, then the queue — top to bottom.
    expect(settled.y).toBeLessThan(dots.y);
    expect(dots.y).toBeLessThan(first.y);
  });

  // spec/14 § Discoverability — a control's tooltip carries its shortcut. ⌘↵
  // promotes the HEAD of the queue, so only the head's ↑ names the chord;
  // naming it on a chip the chord would not act on would misdescribe the key.
  test('every ↑ reads Run next — no keyboard chord promotes any more', async ({ page }) => {
    await page.goto(QUEUED);
    const promotes = page.locator('[data-queued="true"]').getByTestId('queued-promote');
    await expect(promotes.nth(0)).toHaveAttribute('title', 'Run next');
    await expect(promotes.nth(1)).toHaveAttribute('title', 'Run next');
  });

  test('↑ stays visible on keyboard focus too (visibility never regresses)', async ({ page }) => {
    await page.goto(QUEUED);
    const promote = page.locator('[data-queued="true"]').nth(0).getByTestId('queued-promote');
    await promote.focus();
    await expect(promote).toHaveCSS('opacity', '1');
  });
});

// spec/04 ## Message queueing — nothing interrupts on a timer: a queue waiting
// behind a running turn carries no countdown ring (removed 2026-09-29).
test('a running queue shows no auto-interrupt countdown', async ({ page }) => {
  await page.goto(QUEUED);
  await expect(page.locator('[data-queued="true"]').first()).toBeVisible();
  await expect(page.getByTestId('queued-countdown')).toHaveCount(0);
});
