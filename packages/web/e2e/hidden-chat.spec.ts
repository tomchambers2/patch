import { test, expect } from '@playwright/test';

// spec/04 § Hidden, spec/14 § Sidebar item 6: a hidden chat is running but out
// of the active list. It is drawn only in the cold-storage group's Hidden row —
// collapsed by default, loaded on expand from `GET /api/chats?hidden=only`,
// kept live from `chat.state` — and each row, like the hidden chat's own panel
// banner, carries a Show that POSTs `/hide { hidden: false }`.
//
// Real browser against the dev harness, which seeds `chat_hidden` (active,
// hidden). The server is stubbed with `page.route`.

const COUNTS = { hidden: 2, archived: 1, snoozed: 0, deleted: 0, automations: 0 };

function hiddenFixture(chatId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    chatId,
    name,
    preview: null,
    folder: '/home/tom/projects/portfolio',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    snoozedUntil: null,
    hidden: true,
    lastUpdated: 100,
    daemonId: 'd1',
    permissionMode: 'auto',
    jobId: null,
    statusSummary: null,
    statusKind: null,
    ...extra,
  };
}

const HIDDEN_LIST = [
  hiddenFixture('chat_hidden', 'inbox triage run'),
  hiddenFixture('hid_run', 'photo triage run', {
    activity: 'running',
    jobId: 'job_1',
    lastUpdated: 200,
  }),
];

type Page = import('@playwright/test').Page;

async function stubServer(page: Page): Promise<Array<{ chatId: string; body: unknown }>> {
  await page.route('**/api/chats/counts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(COUNTS),
    }),
  );
  await page.route('**/api/chats?hidden=only', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chats: HIDDEN_LIST }),
    }),
  );
  const posts: Array<{ chatId: string; body: unknown }> = [];
  await page.route('**/api/chats/*/hide', (route) => {
    const m = /\/api\/chats\/([^/]+)\/hide$/.exec(new URL(route.request().url()).pathname);
    posts.push({ chatId: m?.[1] ?? '', body: route.request().postDataJSON() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return posts;
}

test.describe('Hidden sidebar section', () => {
  test('is the FIRST cold-storage row, collapsed, badged from the server', async ({ page }) => {
    await stubServer(page);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('sidebar')).toBeVisible();

    const toggles = page.getByTestId('sb-lifecycle-icons').locator('.arch-toggle');
    await expect(toggles.first()).toHaveAttribute('data-testid', 'hidden-toggle');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('title', 'Hidden · 2');
    await expect(page.getByTestId('hidden-section')).toHaveCount(0);
    // Not in the active list.
    await expect(page.getByTestId('chat-row-chat_hidden')).toHaveCount(0);
  });

  test('expanding lists hidden chats with their badge; Show moves one into the active list', async ({
    page,
  }) => {
    const posts = await stubServer(page);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('hidden-toggle').click();

    const section = page.getByTestId('hidden-section');
    await expect(section.getByTestId('chat-row-chat_hidden')).toBeVisible();
    await expect(section.getByTestId('chat-row-hid_run')).toBeVisible();
    // FIFO, oldest first.
    const ids = await section
      .locator('[data-testid^="chat-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(ids).toEqual(['chat-row-chat_hidden', 'chat-row-hid_run']);
    // The status badge is what the section is for.
    await expect(
      section.getByTestId('chat-row-hid_run').getByTestId('badge-working'),
    ).toBeVisible();
    await expect(section.getByTestId('chat-row-chat_hidden').locator('.badge')).toBeVisible();

    await section.getByTestId('chat-row-hid_run').hover();
    await section.getByTestId('show-btn-hid_run').click();

    await expect.poll(() => posts).toEqual([{ chatId: 'hid_run', body: { hidden: false } }]);
    await expect(section.getByTestId('chat-row-hid_run')).toHaveCount(0);
    await expect(page.locator('.sb-scroll [data-testid="chat-row-hid_run"]')).toBeVisible();
    // Show does not open the chat.
    await expect(page.getByTestId('hidden-banner')).toHaveCount(0);
  });

  test('a failed Show puts the row back and says so', async ({ page }) => {
    await stubServer(page);
    await page.route('**/api/chats/chat_hidden/hide', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
    );
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('hidden-toggle').click();
    const section = page.getByTestId('hidden-section');
    await section.getByTestId('chat-row-chat_hidden').hover();
    await section.getByTestId('show-btn-chat_hidden').click();

    await expect(page.getByTestId('error-toasts')).toContainText('show failed');
    await expect(section.getByTestId('chat-row-chat_hidden')).toBeVisible();
    await expect(page.locator('.sb-scroll [data-testid="chat-row-chat_hidden"]')).toHaveCount(0);
  });

  test('a chat hidden over chat.state leaves the active list and joins the section', async ({
    page,
  }) => {
    await stubServer(page);
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await page.getByTestId('hidden-toggle').click();
    await expect(page.locator('.sb-scroll [data-testid="chat-row-chat_bus"]')).toBeVisible();

    await page.evaluate(() => {
      const w = window as unknown as {
        __store: {
          getState: () => {
            chats: Record<string, { folder: string; permissionMode: string }>;
            applyEvent: (e: unknown) => void;
          };
        };
      };
      const row = w.__store.getState().chats['chat_bus']!;
      w.__store.getState().applyEvent({
        type: 'chat.state',
        chatId: 'chat_bus',
        activity: 'idle',
        lastUpdated: 300,
        status: 'active',
        folder: row.folder,
        permissionMode: row.permissionMode,
        hidden: true,
      });
    });

    await expect(page.locator('.sb-scroll [data-testid="chat-row-chat_bus"]')).toHaveCount(0);
    await expect(page.getByTestId('hidden-section').getByTestId('chat-row-chat_bus')).toBeVisible();
  });
});

test.describe('Hidden chat panel', () => {
  test('shows a Hidden banner whose Show un-hides without sending', async ({ page }) => {
    const posts = await stubServer(page);
    await page.goto('/app/dev-harness.html?chat=chat_hidden');
    const banner = page.getByTestId('hidden-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Hidden');
    // Hidden is a state of running: the chat still takes messages.
    await expect(page.getByTestId('composer')).toBeVisible();

    await page.getByTestId('show-banner-btn').click();
    await expect.poll(() => posts).toEqual([{ chatId: 'chat_hidden', body: { hidden: false } }]);
    await expect(banner).toHaveCount(0);
    await expect(page.locator('.sb-scroll [data-testid="chat-row-chat_hidden"]')).toBeVisible();
  });

  test('an active, shown chat has no Hidden banner', async ({ page }) => {
    await stubServer(page);
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('hidden-banner')).toHaveCount(0);
  });
});
