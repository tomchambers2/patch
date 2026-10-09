import { test, expect } from '@playwright/test';

// Recent-folder selection rule (spec/04 § Folders) on the real new-chat screen.
// The harness seeds both special threads on their `.patch/threads/*`
// working dirs alongside real projects, so an unfiltered picker offers patch's
// own bookkeeping directories as if they were the user's projects.
const NEW = '/app/dev-harness.html?chat=new';

const THREAD_FOLDERS = ['/home/tom/.patch/threads/manager', '/home/tom/.patch/threads/speakers'];

test.describe('new chat folder pickers exclude special-thread folders', () => {
  test.beforeEach(async ({ page }) => {
    // No configured project roots, so every option on screen is history-derived
    // — which is exactly the list the rule governs.
    await page.route('**/api/settings*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ projectFolders: [] }),
      }),
    );
  });

  test('quick toggles offer only real projects', async ({ page }) => {
    await page.goto(NEW);
    const setup = page.getByTestId('new-chat-setup');
    await expect(setup).toBeVisible();

    // Three slots, newest first. The harness's thread dirs are more recent than
    // its `projects/patch` chat, so unfiltered the third slot reads "manager"
    // — the count alone stays 3 either way, the NAMES are the assertion.
    const quicks = setup.locator('[data-testid^="folder-quick-"]');
    await expect(quicks).toHaveCount(3);
    await expect(quicks).toHaveText(['bus', 'portfolio', 'patch']);

    for (const folder of THREAD_FOLDERS) {
      await expect(page.getByTestId(`folder-quick-${folder}`)).toHaveCount(0);
    }
  });

  test('the folder pop-up lists no thread working dir', async ({ page }) => {
    await page.goto(NEW);
    await page.getByTestId('new-chat-folder-pill').click();
    await expect(page.getByTestId('folder-popup')).toBeVisible();

    // Recents resolved to the real projects...
    await expect(page.getByTestId('folder-option-/home/tom/projects/bus')).toBeVisible();
    await expect(page.getByTestId('folder-option-/home/tom/projects/portfolio')).toBeVisible();
    // ...and none of patch's own directories.
    for (const folder of THREAD_FOLDERS) {
      await expect(page.getByTestId(`folder-option-${folder}`)).toHaveCount(0);
    }
  });
});

// The MRU default is covered in NewChatRoute.test.tsx instead: it only misfires
// when a special thread is the most recently updated chat of all, and the
// harness's seeds (shared with every other spec) put two real projects above
// the thread dirs. An e2e here would pass with or without the filter.
