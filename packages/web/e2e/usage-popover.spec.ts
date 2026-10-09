import { test, expect, type Page } from '@playwright/test';

// spec/14 § Composer — context ring, and § Usage popover. The ring sits just
// left of Send and fills with the chat's context; clicking it opens one
// popover of every usage figure (the header's own usage bar is gone — § Chat
// panel header). In a real browser because the ring's fill and the popover's
// position are things jsdom cannot judge.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

type W = {
  __store: {
    getState: () => {
      chats: Record<string, { daemonId: string; folder: string }>;
      applyEvent: (e: unknown) => void;
    };
  };
  __presenceStore: {
    getState: () => { setHostAccount: (e: unknown) => void; setHostReport: (e: unknown) => void };
  };
};

async function seed(page: Page, context: Record<string, unknown> | null): Promise<void> {
  await page.evaluate((ctx) => {
    const w = window as unknown as W;
    const row = w.__store.getState().chats['chat_md']!;
    w.__presenceStore.getState().setHostReport({
      type: 'daemon.host',
      daemonId: row.daemonId,
      hostName: 'box',
      backends: [],
      components: [],
    });
    w.__presenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: row.daemonId,
      backendId: 'claude-code',
      connected: true,
      accountEmail: 'dev@example.com',
      usage: {
        session: { status: 'allowed', utilization: 0.42, resetsAt: Date.now() + 3_600_000 },
        week: { status: 'allowed', utilization: 0.18, resetsAt: Date.now() + 86_400_000 },
      },
      accounts: [
        {
          id: 'a1',
          label: 'Default',
          connected: true,
          usage: {
            session: { status: 'allowed', utilization: 0.42 },
            week: { status: 'allowed', utilization: 0.18 },
          },
        },
        {
          id: 'a2',
          label: 'work',
          connected: true,
          usage: { session: { status: 'allowed_warning', utilization: 0.91 } },
        },
      ],
    });
    w.__store.getState().applyEvent({
      type: 'chat.state',
      chatId: 'chat_md',
      daemonId: row.daemonId,
      activity: 'idle',
      folder: row.folder,
      lastUpdated: Date.now(),
      permissionMode: 'bypassPermissions',
      context: ctx,
    });
  }, context);
}

test.describe('usage popover', () => {
  test('the context ring sits immediately left of Send and fills with the window', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await seed(page, { usedTokens: 50_000, windowTokens: 200_000, at: Date.now() });

    const ring = page.getByTestId('context-ring');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute('title', 'Context 25% · 50k / 200k');
    const r = await ring.boundingBox();
    const s = await page.getByTestId('send-btn').boundingBox();
    expect(r && s).toBeTruthy();
    expect(r!.x + r!.width).toBeLessThanOrEqual(s!.x);
    expect(s!.x - (r!.x + r!.width)).toBeLessThan(12);
    expect(Math.abs(r!.y + r!.height / 2 - (s!.y + s!.height / 2))).toBeLessThan(2);
  });

  test('the header crumb has a bar and opens every usage figure', async ({ page }) => {
    await page.goto(HARNESS);
    await seed(page, { usedTokens: 50_000, windowTokens: 200_000, at: Date.now() });
    const crumb = page.getByTestId('chat-usage');
    await expect(crumb).toBeVisible();
    await expect(crumb).toHaveAttribute('aria-label', '5-hour 42%');
    await expect(crumb.locator('.chat-usage-bar i')).toHaveAttribute('style', /width: 42%/);
    await crumb.click();
    await expect(page.getByTestId('usage-popover')).toBeVisible();
  });

  test('an unknown window still shows the ring, unfilled', async ({ page }) => {
    await page.goto(HARNESS);
    await seed(page, { usedTokens: 50_000, at: Date.now() });
    await expect(page.getByTestId('context-ring')).toHaveAttribute('title', 'Context ? · 50k / ?');
  });

  test('no ring until the chat has been measured', async ({ page }) => {
    await page.goto(HARNESS);
    await seed(page, null);
    await expect(page.getByTestId('context-ring')).toHaveCount(0);
  });

  // spec/14 § Chat panel header — the header's usage bar is gone; the
  // composer's context ring is the one door into the popover, and it shows
  // the same every-account figures regardless of which chat opened it.
  test('the ring opens every usage figure, including accounts the open chat has no context for', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await seed(page, { usedTokens: 50_000, windowTokens: 200_000, at: Date.now() });

    await page.getByTestId('context-ring').click();
    const pop = page.getByTestId('usage-popover');
    await expect(pop).toBeVisible();
    await expect(page.getByTestId('usage-pop-context')).toContainText('25%');
    await expect(page.getByTestId('usage-pop-context')).toContainText('50k / 200k');
    const accounts = page.getByTestId('usage-pop-account');
    await expect(accounts).toHaveCount(2);
    await expect(accounts.nth(0)).toContainText('Claude · Default');
    await expect(accounts.nth(0)).toContainText('42%');
    await expect(accounts.nth(1)).toContainText('Claude · work');
    await expect(accounts.nth(1)).toContainText('91%');

    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
  });

  test('the ring opens the same popover, upwards, and a click outside closes it', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await seed(page, { usedTokens: 50_000, windowTokens: 200_000, at: Date.now() });
    const ring = page.getByTestId('context-ring');
    await ring.click();
    const pop = page.getByTestId('usage-popover');
    await expect(pop).toBeVisible();
    const pb = await pop.boundingBox();
    const rb = await ring.boundingBox();
    expect(pb!.y + pb!.height).toBeLessThanOrEqual(rb!.y + 1);
    await page.mouse.click(10, 10);
    await expect(pop).toHaveCount(0);
  });
});
