import { test, expect } from '@playwright/test';

// spec/14 § Reserved OS chords — ⌘F (⌃F on Linux/Windows) focuses the page's
// own search field where the page has one, and is left to the browser's find
// bar where it does not.
//
// jsdom can't answer the second half: `defaultPrevented` there is decided by
// the same hook under test with no browser behind it. This runs the REAL
// shortcut hook (mounted by the dev harness, wired to the real
// `focusPageSearch`) in a real browser and reads where focus landed.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const JOBS = [
  {
    id: 'bus',
    name: 'bus-watch',
    enabled: true,
    trigger: { type: 'cron', expression: '57 8 * * 1-5' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '~/projects/nearest-bus', skill: 'bus-watch' },
    createdAt: 1,
    updatedAt: 1,
  },
];

async function stubJobs(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/jobs/*/runs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: JOBS }),
    }),
  );
}

/** Watch whether the app takes the chord. Registered AFTER the app's own
 *  window listener, so it observes the app's `preventDefault()` — the only
 *  way to tell "handled" from "passed through to the browser". */
async function watchChord(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __prevented?: boolean[] };
    w.__prevented = [];
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'f') w.__prevented?.push(e.defaultPrevented);
    });
  });
}

async function preventedFlags(page: import('@playwright/test').Page): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __prevented?: boolean[] }).__prevented ?? []);
}

async function focusedTestId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

test.describe('⌘F focuses the page search field', () => {
  test('on the Jobs page it focuses and selects the jobs search field', async ({ page }) => {
    await stubJobs(page);
    await page.goto('/app/dev-harness.html?route=/jobs');
    await expect(page.getByTestId('jobs-search')).toBeVisible();
    await watchChord(page);

    // Type a query first, then click away: ⌘F must come back to the field with
    // the existing query selected, so typing replaces it.
    await page.getByTestId('jobs-search').fill('bus');
    await page.locator('h1.display').click();
    expect(await focusedTestId(page)).not.toBe('jobs-search');

    await page.keyboard.press(`${MOD}+f`);

    expect(await focusedTestId(page)).toBe('jobs-search');
    const selected = await page.getByTestId('jobs-search').evaluate((el) => {
      const i = el as HTMLInputElement;
      return i.value.slice(i.selectionStart ?? 0, i.selectionEnd ?? 0);
    });
    expect(selected).toBe('bus');
    expect(await preventedFlags(page)).toEqual([true]);
  });

  test('over a chat transcript, the chord opens find-in-chat', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    const prose = page.locator('.msg-assistant .content p').first();
    await expect(prose).toBeVisible();
    await watchChord(page);
    await prose.click();

    await page.keyboard.press(`${MOD}+f`);

    // The chat's own find bar takes it (spec/14 § Find in chat).
    expect(await focusedTestId(page)).toBe('chat-find-input');
  });

  test('over a chat, ⌘K lands on the sidebar chat search but ⌘F opens find-in-chat', async ({
    page,
  }) => {
    // The global chat search is on screen on every chat. It answers ⌘K; ⌘F over
    // the transcript opens find-in-chat (spec/14 § Find in chat).
    await page.goto('/app/dev-harness.html?chat=chat_md');
    const prose = page.locator('.msg-assistant .content p').first();
    await expect(prose).toBeVisible();
    await expect(page.getByTestId('chat-search')).toBeVisible();
    await watchChord(page);
    await prose.click();

    await page.keyboard.press(`${MOD}+f`);
    expect(await focusedTestId(page)).toBe('chat-find-input');
    expect(await focusedTestId(page)).not.toBe('chat-search');

    // While the find bar is open it is the view's own field and ⌘K prefers it;
    // closed, ⌘K falls to the sidebar's global search.
    await page.keyboard.press('Escape');
    await page.keyboard.press(`${MOD}+k`);
    expect(await focusedTestId(page)).toBe('chat-search');
  });

  test('⌘K lands on the same field', async ({ page }) => {
    await stubJobs(page);
    await page.goto('/app/dev-harness.html?route=/jobs');
    await expect(page.getByTestId('jobs-search')).toBeVisible();
    await page.locator('h1.display').click();

    await page.keyboard.press(`${MOD}+k`);

    expect(await focusedTestId(page)).toBe('jobs-search');
  });
});
