import { test, expect } from '@playwright/test';

// spec/14 § Discoverability — the chat-list chords (prev/next chat, folder
// jump, jump-unread, archive, …) fire only while a chat view is showing, and
// a text field keeps its native keys except the composer's own ⌘↑/⌘↓.
//
// jsdom can't answer this: "did the app take the chord" (defaultPrevented)
// and "did it reach the real route/composer" are both real-browser facts.
// This runs the real shortcut hook (mounted by the dev harness) against the
// real routes and reads `window.__shortcutCalls` (dev-harness.tsx's
// recording handlers) to see what the app actually took.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const JOB = {
  id: 'job_bus_watch',
  name: 'Bus watch',
  enabled: true,
  filter: null,
  trigger: { type: 'cron', expression: '*/5 7-22 * * *', timezone: 'Europe/London' },
  action: { type: 'spawn', daemonId: 'd1', folder: '/home/tom/projects/bus', prompt: 'watch' },
};

async function calls(page: import('@playwright/test').Page): Promise<string[]> {
  await page.waitForFunction(
    () => (window as unknown as { __shortcutCalls?: string[] }).__shortcutCalls !== undefined,
  );
  return page.evaluate(
    () => (window as unknown as { __shortcutCalls?: string[] }).__shortcutCalls ?? [],
  );
}

/** Registered AFTER the app's own window listener, so it observes the app's
 *  `preventDefault()` on the given key — the only way to tell "handled" from
 *  "passed through to the browser" (mirrors e2e/search-shortcut.spec.ts). */
async function watchDefaultPrevented(
  page: import('@playwright/test').Page,
  key: string,
): Promise<void> {
  await page.evaluate((watchedKey) => {
    const w = window as unknown as { __prevented?: boolean[] };
    w.__prevented = [];
    window.addEventListener('keydown', (e) => {
      if (e.key === watchedKey) w.__prevented?.push(e.defaultPrevented);
    });
  }, key);
}

async function preventedFlags(page: import('@playwright/test').Page): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __prevented?: boolean[] }).__prevented ?? []);
}

async function stubJobEditorApis(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hosts: [{ daemonId: 'd1', roots: ['/home/tom/projects/bus'], recent: [] }],
      }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: [], paths: {} }),
    }),
  );
  // One job so the Jobs list draws its search field (spec/14 § Jobs view —
  // drawn only when there are jobs to search).
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [JOB] }),
    }),
  );
}

test.describe('chat-view chords do not fire outside a chat view', () => {
  test('⌘J / ⌘1 / ⌘⇧A are no-ops on the Jobs list', async ({ page }) => {
    await stubJobEditorApis(page);
    await page.goto('/app/dev-harness.html?route=/jobs');
    await expect(page.getByTestId('jobs-search')).toBeVisible();

    await page.keyboard.press(`${MOD}+j`);
    await page.keyboard.press(`${MOD}+1`);
    await page.keyboard.press(`${MOD}+Shift+a`);

    const fired = await calls(page);
    expect(fired).not.toContain('jumpOldestUnread');
    expect(fired).not.toContain('jumpManager');
    expect(fired).not.toContain('toggleArchived');
  });

  test('⌘↑ in the job editor prompt field leaves the browser free to move the caret, and does not navigate', async ({
    page,
  }) => {
    await stubJobEditorApis(page);
    await page.goto('/app/dev-harness.html?route=/jobs/new');
    const prompt = page.getByTestId('job-spawn-prompt');
    await expect(prompt).toBeVisible();
    await prompt.click();
    await watchDefaultPrevented(page, 'ArrowUp');

    await prompt.press(`${MOD}+ArrowUp`);

    // The app never called preventDefault — the keystroke reached the field
    // untouched, which is what "the browser's normal caret behaviour" means
    // from the app's side (the OS/browser decide what it does with it).
    expect(await preventedFlags(page)).toEqual([false]);
    expect(await calls(page)).not.toContain('prevChat');
    // Didn't navigate off the job editor.
    await expect(prompt).toBeVisible();
  });

  test('⌘1 / ⌘⇧A are no-ops on Settings', async ({ page }) => {
    await page.goto('/app/dev-harness.html?route=/settings');
    await page.keyboard.press(`${MOD}+1`);
    await page.keyboard.press(`${MOD}+Shift+a`);
    const fired = await calls(page);
    expect(fired).not.toContain('jumpManager');
    expect(fired).not.toContain('toggleArchived');
  });
});

test.describe('chat-view chords fire in a chat view', () => {
  test('⌘J / ⌘1 / ⌘⇧A fire on an open chat', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    // The composer autofocuses on open (spec/04 § New chat drafts / chat
    // open) — blur it so focus is in the page but NOT in a field, same setup
    // e2e/select-all.spec.ts uses for the transcript case.
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeFocused();
    await composer.evaluate((el) => (el as HTMLTextAreaElement).blur());
    await expect(composer).not.toBeFocused();

    await page.keyboard.press(`${MOD}+j`);
    await page.keyboard.press(`${MOD}+1`);
    await page.keyboard.press(`${MOD}+Shift+a`);

    const fired = await calls(page);
    expect(fired).toContain('jumpOldestUnread');
    expect(fired).toContain('jumpManager');
    expect(fired).toContain('toggleArchived');
  });

  test('⌘↑ in the composer is left to the text box, not a chat switch', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeVisible();
    await composer.click();
    await watchDefaultPrevented(page, 'ArrowUp');

    await page.keyboard.press(`${MOD}+ArrowUp`);

    expect(await calls(page)).not.toContain('prevChat');
    expect(await preventedFlags(page)).toEqual([false]);
  });

  test('⌘↑ in the sidebar search field (not the composer) is left to the browser', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const search = page.getByTestId('chat-search');
    await expect(search).toBeVisible();
    await search.click();
    await watchDefaultPrevented(page, 'ArrowUp');

    await search.press(`${MOD}+ArrowUp`);

    expect(await calls(page)).not.toContain('prevChat');
    expect(await preventedFlags(page)).toEqual([false]);
  });

  test('⌘⇧↑ (folders) does NOT fire from the composer', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeVisible();
    await composer.click();

    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);

    expect(await calls(page)).not.toContain('prevFolder');
  });
});
