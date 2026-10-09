import { test, expect } from '@playwright/test';

// Todoist: "patch: archiving the last chat in a project makes the project
// disappear from the sidebar".
//
// Repro: archive the ONLY chat in a folder, then reload. The chat is gone from
// the active roster (`GET /api/chats` excludes archived), so before the fix the
// folder had no row anywhere in the store and dropped out of Recent projects
// entirely — despite spec/14 §4b promising it stays as an entry point for
// starting a new chat there.
//
// A reload is what makes this visible, so these specs never archive anything in
// the browser: they load the harness in the POST-reload state — the archived
// chat simply absent — and assert the folder is still offered. The folder
// roster (`GET /api/chats/folders`) is the source that survives that filter.
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

/** A folder with no chat in the hydrated store — i.e. all of its chats are archived. */
const ARCHIVED_ONLY = '/home/tom/projects/retired';
const ALSO_ARCHIVED = '/home/tom/projects/mothballed';

test.describe('Recent projects survives archiving a project’s last chat', () => {
  test('a folder whose only chat is archived is still offered after a reload', async ({ page }) => {
    await page.route('**/api/chats/folders', async (route) => {
      await route.fulfill({
        json: {
          folders: [
            { folder: ARCHIVED_ONLY, daemonId: 'd1', lastUpdated: 900 },
            // The seeded active folders also come back from the real endpoint;
            // they are already drawn as open Folders sections, so they must NOT
            // be duplicated into Recent projects.
            { folder: '/home/tom/projects/bus', daemonId: 'd1', lastUpdated: 800 },
            { folder: '/home/tom/projects/portfolio', daemonId: 'd1', lastUpdated: 700 },
          ],
        },
      });
    });
    await page.goto(HARNESS);

    const recents = page.getByTestId('recent-folders');
    await expect(recents).toBeVisible();
    await expect(recents).toContainText('Recent projects');
    // The whole point: the all-archived folder is present as a row.
    await expect(page.getByTestId(`recent-folder-${ARCHIVED_ONLY}`)).toBeVisible();
    // ...and the folders already drawn above are not listed a second time.
    await expect(page.getByTestId('recent-folder-/home/tom/projects/bus')).toHaveCount(0);
    await expect(page.getByTestId('recent-folder-/home/tom/projects/portfolio')).toHaveCount(0);
  });

  test('without the roster the folder is invisible — the pre-fix behaviour this guards', async ({
    page,
  }) => {
    // No `page.route`, so the harness's roster fetch 404s and the sidebar falls
    // back to store-derived folders only. This pins WHY the roster is needed:
    // if Recent projects ever starts passing this from the store alone, the
    // roster has become dead code and the assertion above proves nothing.
    await page.goto(HARNESS);
    await expect(page.getByTestId(`recent-folder-${ARCHIVED_ONLY}`)).toHaveCount(0);
  });

  test('clicking the row starts a new chat in that project, with its host resolved', async ({
    page,
  }) => {
    // The row's whole purpose (spec/14 §4b) is to be an entry point. Its host
    // has to come from the roster too — the archived chat that would otherwise
    // supply `daemonId` is absent after the reload.
    await page.route('**/api/chats/folders', async (route) => {
      await route.fulfill({
        json: { folders: [{ folder: ARCHIVED_ONLY, daemonId: 'd1', lastUpdated: 900 }] },
      });
    });
    await page.goto(HARNESS);
    await page.getByTestId(`recent-folder-start-${ARCHIVED_ONLY}`).click();
    // Landed on the new-chat view with the project selected, not on an empty
    // "Choose a folder…" state.
    const pill = page.getByTestId('new-chat-folder-pill');
    // The new-chat route mounts the editor stack behind it, which on a loaded
    // machine takes longer than the 5s default to first paint.
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toContainText('retired');
    await expect(pill).not.toContainText('Choose a folder');
  });

  test('the × still forgets a roster-derived project', async ({ page }) => {
    // The forget list is localStorage-only (`patch.sidebar.forgottenFolders`),
    // so it has to keep working against folders the store has never seen.
    await page.route('**/api/chats/folders', async (route) => {
      await route.fulfill({
        json: {
          folders: [
            { folder: ARCHIVED_ONLY, daemonId: 'd1', lastUpdated: 900 },
            { folder: ALSO_ARCHIVED, daemonId: 'd1', lastUpdated: 850 },
          ],
        },
      });
    });
    await page.goto(HARNESS);
    await expect(page.getByTestId(`recent-folder-${ARCHIVED_ONLY}`)).toBeVisible();
    await expect(page.getByTestId(`recent-folder-${ALSO_ARCHIVED}`)).toBeVisible();

    // The × is hover-revealed (opacity 0 at rest), so the row has to be hovered
    // before the button is clickable.
    await page.getByTestId(`recent-folder-${ARCHIVED_ONLY}`).hover();
    await page.getByTestId(`recent-folder-forget-${ARCHIVED_ONLY}`).click();
    await expect(page.getByTestId(`recent-folder-${ARCHIVED_ONLY}`)).toHaveCount(0);
    // Forgetting one must not take the rest of the list with it.
    await expect(page.getByTestId(`recent-folder-${ALSO_ARCHIVED}`)).toBeVisible();
  });

  test('recents are ordered most-recently-active first', async ({ page }) => {
    await page.route('**/api/chats/folders', async (route) => {
      await route.fulfill({
        json: {
          folders: [
            { folder: ALSO_ARCHIVED, daemonId: 'd1', lastUpdated: 10 },
            { folder: ARCHIVED_ONLY, daemonId: 'd1', lastUpdated: 990 },
          ],
        },
      });
    });
    await page.goto(HARNESS);
    // Wait for the roster fetch to land before reading the order — a bare
    // `evaluateAll` has no auto-retry and would sample the empty pre-fetch DOM.
    await expect(page.getByTestId(`recent-folder-${ALSO_ARCHIVED}`)).toBeVisible();
    const names = await page
      .locator('.recent-folder-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')));
    expect(names).toEqual([`recent-folder-${ARCHIVED_ONLY}`, `recent-folder-${ALSO_ARCHIVED}`]);
  });
});
