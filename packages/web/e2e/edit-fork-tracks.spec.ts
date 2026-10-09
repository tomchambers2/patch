import { test, expect } from '@playwright/test';

// spec/04 § Branching; spec/14 § Main chat panel — "need to be able to
// edit/fork a message, then switch between tracks" (patch/todo.md).
//
// jsdom proves the wiring (fork_request / branch_switch_request + store). This
// proves the affordances with the REAL CSS: the pencil is invisible until the
// user turn is hovered (and reachable by keyboard), only user turns carry it,
// and the fork point's track switcher renders as arrows + a count.
const FORKED = '/app/dev-harness.html?chat=chat_forked';

test.describe('edit a turn / switch tracks', () => {
  test('the pencil is hidden until the user turn is hovered, and focus reveals it too', async ({
    page,
  }) => {
    await page.goto(FORKED);
    const userTurn = page.locator('.msg-user').first();
    await expect(userTurn).toBeVisible();

    const edit = userTurn.getByTestId('msg-edit');
    await expect(edit).toHaveCSS('opacity', '0');

    await userTurn.locator('.content').hover();
    await expect(edit).toHaveCSS('opacity', '1');

    // A real, clickable target — not a 0-sized sliver.
    const box = await edit.boundingBox();
    if (!box) throw new Error('missing edit control box');
    expect(box.width).toBeGreaterThanOrEqual(16);
    expect(box.height).toBeGreaterThanOrEqual(16);

    // Never hover-only: keyboard focus reveals it.
    await page.locator('.msg-user').nth(1).getByTestId('msg-edit').focus();
    await expect(page.locator('.msg-user').nth(1).getByTestId('msg-edit')).toHaveCSS(
      'opacity',
      '1',
    );
  });

  test('assistant replies carry no edit affordance', async ({ page }) => {
    await page.goto(FORKED);
    await expect(page.locator('.msg-assistant').first()).toBeVisible();
    await expect(page.locator('.msg-assistant').getByTestId('msg-edit')).toHaveCount(0);
  });

  test('clicking the pencil opens the turn in an editable field pre-filled with its text', async ({
    page,
  }) => {
    await page.goto(FORKED);
    const userTurn = page.locator('.msg-user').nth(1);
    await userTurn.locator('.content').hover();
    await userTurn.getByTestId('msg-edit').click();

    const field = userTurn.getByTestId('msg-edit-input');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('the edited turn');
    // The static bubble is replaced, not duplicated.
    await expect(userTurn.getByTestId('msg-content')).toHaveCount(0);

    await userTurn.getByTestId('msg-edit-cancel').click();
    await expect(userTurn.getByTestId('msg-edit-input')).toHaveCount(0);
    await expect(userTurn.getByTestId('msg-content')).toContainText('the edited turn');
  });

  test('the fork point shows a track switcher: arrows either side of the count', async ({
    page,
  }) => {
    await page.goto(FORKED);
    const switcher = page.getByTestId('track-switcher');
    await expect(switcher).toHaveCount(1);
    await expect(switcher.getByTestId('track-count')).toHaveText('2/2');

    const prev = await switcher.getByTestId('track-prev').boundingBox();
    const count = await switcher.getByTestId('track-count').boundingBox();
    const next = await switcher.getByTestId('track-next').boundingBox();
    if (!prev || !count || !next) throw new Error('missing switcher boxes');
    expect(prev.x).toBeLessThan(count.x);
    expect(count.x).toBeLessThan(next.x);

    // On the LAST track there is nowhere further forward to go.
    await expect(switcher.getByTestId('track-next')).toBeDisabled();
    await expect(switcher.getByTestId('track-prev')).toBeEnabled();
  });

  test('a turn that is not a fork point shows no switcher', async ({ page }) => {
    await page.goto(FORKED);
    // Four turns in the fixture, exactly one fork point.
    await expect(page.getByTestId('msg')).toHaveCount(4);
    await expect(page.getByTestId('track-switcher')).toHaveCount(1);
  });
});
