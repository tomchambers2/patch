import { test, expect } from '@playwright/test';

// Todoist: "patch chats flicker when reconnecting".
//
// Reconnect races two resync paths: the WS replay (which re-derives a row's
// live `activity`) and the `['chats']` REST refetch (`hydrate()`, driven by
// `useQuery`'s `refetchOnReconnect`). The REST snapshot can carry a stale
// `activity` that briefly disagrees with what the live WS stream already
// showed — it can flicker through `working` on a surface reload. The badge must hold its
// last-shown value through a brief stale-then-corrected sequence instead of
// visibly flipping and flipping back. `Sidebar.test.tsx`'s "badge settle"
// suite proves the timing precisely with fake timers; this proves the same
// thing in a real browser against real `setTimeout`s.
//
// Driven directly via `window.__store` (the same bridge `chat-replay-batching
// .spec.ts` uses), not a mocked WS — `hydrate`/`mergeChats` are exactly the
// two store entry points the real REST refetch and WS replay call.

const HARNESS = '/app/dev-harness.html';
const CHAT_ID = 'flicker-e2e';

interface StoreBridge {
  getState: () => {
    hydrate: (rows: unknown[]) => void;
    mergeChats: (rows: unknown[]) => void;
  };
}

function baseRow(activity: 'running' | 'idle'): unknown {
  return {
    chatId: CHAT_ID,
    daemonId: 'd1',
    permissionMode: 'auto',
    name: 'Flicker test',
    folder: '/tmp/flicker-e2e',
    activity,
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
  };
}

async function hydrate(
  page: import('@playwright/test').Page,
  activity: 'running' | 'idle',
): Promise<void> {
  await page.evaluate((row) => {
    (window as unknown as { __store: StoreBridge }).__store.getState().hydrate([row]);
  }, baseRow(activity));
}

async function mergeChats(
  page: import('@playwright/test').Page,
  activity: 'running' | 'idle',
): Promise<void> {
  await page.evaluate((row) => {
    (window as unknown as { __store: StoreBridge }).__store.getState().mergeChats([row]);
  }, baseRow(activity));
}

test.describe('sidebar badge settles through a reconnect race', () => {
  test('a stale REST snapshot does not flip the badge before the WS correction lands', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    // Cold: the chat is genuinely running.
    await hydrate(page, 'running');
    const row = page.getByTestId(`chat-row-${CHAT_ID}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('badge-working')).toBeVisible();

    // Reconnect: the REST refetch lands first, with a stale snapshot (the
    // host hasn't caught the WS stream up yet). A fresh idle row here reads
    // as `done` (lastSeq 0 > lastReadSeq -1) — the wrong badge to show.
    await hydrate(page, 'idle');

    // Bounded INSIDE the settle window (250ms) — a badge that flips
    // immediately must be caught here, before the window it would have
    // legitimately been allowed to change in.
    await expect(row.getByTestId('badge-done')).toHaveCount(0, { timeout: 150 });
    await expect(row.getByTestId('badge-working')).toBeVisible();

    // The WS replay corrects it back, still inside the settle window.
    await mergeChats(page, 'running');

    // Past the settle window: never having shown `done` in between.
    await page.waitForTimeout(400);
    await expect(row.getByTestId('badge-working')).toBeVisible();
    await expect(row.getByTestId('badge-done')).toHaveCount(0);
  });

  test('a change that holds past the settle window does still land', async ({ page }) => {
    await page.goto(HARNESS);
    await hydrate(page, 'running');
    const row = page.getByTestId(`chat-row-${CHAT_ID}`);
    await expect(row.getByTestId('badge-working')).toBeVisible();

    await hydrate(page, 'idle');
    await expect(row.getByTestId('badge-done')).toBeVisible({ timeout: 2000 });
  });
});
