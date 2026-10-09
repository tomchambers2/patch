import { test, expect, type Page } from '@playwright/test';
import {
  PIXEL_7,
  addSecondHost,
  reportHost,
  setClaudeSettings,
  setHostAccount,
  settingsUrl,
  stubSettingsApi,
  wsSent,
} from './settingsHarness.js';

// design/settings-redesign: Settings is a nav of twelve pages grouped Agents /
// Setup / System, each at its own address, /settings/<page>. On a wide window
// the chosen page sits beside the nav (Usage when the address names none); on a
// phone the nav IS the first screen, a full-width list, and a page opens over
// it with a ← back to the list. That switch is pure CSS, so only a real browser
// at a real phone size can show it.
//
// The harness runs a MemoryRouter, so there is no address bar to read; the
// route's own `data-page` (what the router's address names) and the nav's
// `aria-current` stand in for the URL.

const PAGES = [
  { id: 'usage', title: 'Usage', testid: 'settings-usage' },
  { id: 'agent', title: 'Agent', testid: 'settings-agent' },
  { id: 'mcp', title: 'MCP', testid: 'settings-mcp' },
  { id: 'memories', title: 'Memories', testid: 'settings-memories' },
  { id: 'manager', title: 'Manager', testid: 'settings-manager-page' },
  { id: 'voice', title: 'Voice', testid: 'settings-voice' },
  { id: 'hooks', title: 'Hooks', testid: 'settings-hooks-page' },
  { id: 'hosts', title: 'Hosts', testid: 'settings-hosts' },
  { id: 'keys', title: 'Keys', testid: 'settings-keys' },
  { id: 'devices', title: 'Devices', testid: 'settings-devices' },
  { id: 'updates', title: 'Updates', testid: 'settings-version' },
  { id: 'account', title: 'Account', testid: 'settings-account' },
] as const;

const MEMORIES = [
  {
    project: '-home-tom-portfolio',
    projectDir: '/home/tom/portfolio',
    file: 'feedback_tests.md',
    name: 'Write real tests',
    description: 'not manual clicking',
    memoryType: 'feedback',
    body: 'Always write unit, integration and playwright tests.',
    updatedAt: Date.UTC(2026, 8, 20),
  },
  {
    project: '-home-tom-portfolio',
    projectDir: '/home/tom/portfolio',
    file: 'user_role.md',
    name: 'Tom',
    description: 'builds personal prototypes',
    memoryType: 'user',
    body: 'Tom builds quick personal apps.',
  },
  {
    project: '-home-tom-patch',
    projectDir: '/home/tom/patch',
    file: 'deploy.md',
    name: 'Deploying patch',
    description: 'bin/publish from the Mac',
    memoryType: 'reference',
    body: 'Build releases on the Mac.',
  },
];

const PLAYWRIGHT_MCP = {
  name: 'playwright',
  command: 'npx',
  args: ['@playwright/mcp', '--headless'],
  env: {},
  enabled: true,
};

/** Content on every page that could push a phone-width layout sideways. */
async function seedEverything(page: Page): Promise<void> {
  await reportHost(page, {
    harnessMcpServers: [PLAYWRIGHT_MCP],
    harnessMemoryEnabled: true,
    kokoroVoice: 'af_heart',
    chatNameInterval: 3,
    updateAvailable: true,
    backends: [{ id: 'claude-code', label: 'Claude Code', version: '2.1.0', state: 'present' }],
  });
  await setClaudeSettings(page, MEMORIES);
  await setHostAccount(page, {
    daemonId: 'd1',
    backendId: 'claude-code',
    connected: true,
    activeAccountId: 'a1',
    accounts: [
      {
        id: 'a1',
        label: 'Work',
        connected: true,
        accountEmail: 'tom.work@example.com',
        usage: {
          session: { status: 'allowed', utilization: 0.4, resetsAt: Date.now() + 3_600_000 },
          week: { status: 'allowed', utilization: 0.7, resetsAt: Date.now() + 86_400_000 },
          at: Date.now(),
        },
      },
      { id: 'a2', label: 'Personal', connected: false },
    ],
  });
}

async function expectOnPage(page: Page, p: (typeof PAGES)[number]): Promise<void> {
  const route = page.getByTestId('settings-route');
  await expect(route).toHaveAttribute('data-page', p.id);
  await expect(page.getByTestId(p.testid)).toBeVisible();
  await expect(
    page
      .getByTestId('settings-main')
      .getByRole('heading', { level: 1, name: p.title, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId(`settings-nav-${p.id}`)).toHaveAttribute('aria-current', 'page');
}

test.describe('Settings — desktop', () => {
  test.use({ viewport: { width: 1290, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
  });

  test('/settings shows Usage beside the nav', async ({ page }) => {
    await page.goto(settingsUrl());
    const route = page.getByTestId('settings-route');
    await expect(route).toHaveAttribute('data-page', 'index');
    await expect(route).not.toHaveClass(/\bopen\b/);
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    await expect(page.getByTestId('settings-usage')).toBeVisible();
    await expect(page.getByTestId('settings-nav-usage')).toHaveAttribute('aria-current', 'page');
    // The phone's back arrow is not drawn beside a nav that is already there.
    await expect(page.getByTestId('settings-back')).toBeHidden();
    // The nav's groups, in order.
    await expect(page.getByTestId('settings-nav').locator('h2')).toHaveText([
      'Agents',
      'Setup',
      'System',
    ]);
    await expect(
      page.getByTestId('settings-nav').locator('button[data-testid^="settings-nav-"]'),
    ).toHaveText(PAGES.map((p) => p.title));
  });

  test('the nav reaches all twelve pages, each at its own address', async ({ page }) => {
    await page.goto(settingsUrl());
    for (const p of PAGES) {
      await page.getByTestId(`settings-nav-${p.id}`).click();
      await expectOnPage(page, p);
      await expect(page.getByTestId('settings-route')).toHaveClass(/\bopen\b/);
      // Beside the nav, not over it.
      await expect(page.getByTestId('settings-nav')).toBeVisible();
      // Exactly one page is drawn, and one nav item is current.
      await expect(page.locator('.set-page')).toHaveCount(1);
      await expect(
        page.locator('[data-testid="settings-nav"] button[aria-current="page"]'),
      ).toHaveCount(1);
    }
  });

  test('every address opens its page directly', async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(settingsUrl(p.id));
      await expectOnPage(page, p);
    }
  });

  test('an unknown page goes back to /settings', async ({ page }) => {
    await page.goto(settingsUrl('nope'));
    await expect(page.getByTestId('settings-route')).toHaveAttribute('data-page', 'index');
    await expect(page.getByTestId('settings-usage')).toBeVisible();
  });
});

test.describe('Settings — phone', () => {
  test.use(PIXEL_7);

  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
  });

  async function noSidewaysScroll(page: Page, what: string): Promise<void> {
    const m = await page.evaluate(() => {
      const route = document.querySelector('.settings-route') as HTMLElement;
      return {
        doc: document.documentElement.scrollWidth,
        route: route.scrollWidth,
        routeClient: route.clientWidth,
        vw: window.innerWidth,
      };
    });
    expect(m.doc, `${what}: document`).toBeLessThanOrEqual(m.vw);
    expect(m.route, `${what}: settings route`).toBeLessThanOrEqual(m.routeClient);
  }

  test('/settings is the list alone — no page beside it', async ({ page }) => {
    await page.goto(settingsUrl());
    await expect(page.getByTestId('settings-route')).toHaveAttribute('data-page', 'index');
    const nav = page.getByTestId('settings-nav');
    await expect(nav).toBeVisible();
    await expect(page.getByTestId('settings-main')).toBeHidden();
    await expect(page.getByTestId('settings-usage')).toBeHidden();
    // Full-width rows, not a 220px sidebar.
    const row = (await page.getByTestId('settings-nav-usage').boundingBox())!;
    expect(row.width).toBeGreaterThan(PIXEL_7.viewport.width * 0.85);
    await noSidewaysScroll(page, 'list');
  });

  test('tapping a row opens its page; ← goes back to the list', async ({ page }) => {
    await page.goto(settingsUrl());
    await seedEverything(page);
    for (const p of PAGES) {
      await page.getByTestId(`settings-nav-${p.id}`).tap();
      await expect(page.getByTestId('settings-route')).toHaveAttribute('data-page', p.id);
      await expect(page.getByTestId(p.testid)).toBeVisible();
      // The page is drawn over the list, not beside it.
      await expect(page.getByTestId('settings-nav')).toBeHidden();
      await expect(
        page.getByTestId('settings-main').getByRole('heading', { level: 1, name: p.title }),
      ).toBeVisible();
      await noSidewaysScroll(page, p.id);

      const back = page.getByTestId(p.testid).getByTestId('settings-back');
      await expect(back).toBeVisible();
      await back.tap();
      await expect(page.getByTestId('settings-route')).toHaveAttribute('data-page', 'index');
      await expect(page.getByTestId('settings-nav')).toBeVisible();
      await expect(page.getByTestId('settings-main')).toBeHidden();
    }
  });
});

test.describe('Settings — behaviour', () => {
  test.use({ viewport: { width: 1290, height: 900 } });

  let server: Awaited<ReturnType<typeof stubSettingsApi>>;
  test.beforeEach(async ({ page }) => {
    server = await stubSettingsApi(page);
  });

  // Only what belongs to a machine is chosen per host (spec/01 § Settings):
  // Memories and MCP. Usage, Agent, Voice and Keys are the account's.
  test('the host switcher appears on per-host pages once two hosts have reported', async ({
    page,
  }) => {
    await page.goto(settingsUrl('memories'));
    await expect(page.getByTestId('host-d1-memory-unreported')).toBeVisible();
    await expect(page.getByTestId('settings-host-switch')).toHaveCount(0);

    await addSecondHost(page);
    const sw = page.getByTestId('settings-host-switch');
    await expect(sw).toBeVisible();
    await expect(sw.getByRole('tab')).toHaveText(['dev-host', 'mac']);
    await expect(page.getByTestId('settings-host-d1')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('settings-host-d2').click();
    await expect(page.getByTestId('host-d2-memory-unreported')).toBeVisible();

    // The choice is shared across the per-host pages…
    await page.getByTestId('settings-nav-mcp').click();
    await expect(page.getByTestId('settings-host-d2')).toHaveAttribute('aria-selected', 'true');
    // …and a page of shared settings draws no switcher at all.
    await page.getByTestId('settings-nav-agent').click();
    await expect(page.getByTestId('permission-default')).toBeVisible();
    await expect(page.getByTestId('settings-host-switch')).toHaveCount(0);
    await page.getByTestId('permission-default').selectOption('plan');
    await expect.poll(() => server.patches).toContainEqual({ permissionModeDefault: 'plan' });
    expect(await wsSent(page)).toEqual([]);
  });

  test('dragging a Claude account above another writes the new order to the server', async ({
    page,
  }) => {
    const accounts = [
      { id: 'a1', label: 'Work', connected: true, email: 'tom.work@example.com' },
      { id: 'a2', label: 'Personal', connected: false },
    ];
    const s2 = await stubSettingsApi(page, {
      secrets: { claude: accounts },
      answer: (w, srv) => {
        if (w.path.endsWith('/order'))
          srv.secrets = { ...srv.secrets, claude: [accounts[1]!, accounts[0]!] };
      },
    });
    await page.goto(settingsUrl('usage'));
    const rank = page.getByTestId('accounts-rank-claude-code');
    await expect(rank.locator('.set-ranked-item')).toHaveCount(2);
    await page
      .getByTestId('accounts-rank-claude-code-item-a2')
      .dragTo(page.getByTestId('accounts-rank-claude-code-item-a1'), {
        targetPosition: { x: 40, y: 4 },
      });
    await expect
      .poll(() => s2.writes.filter((w) => w.path.endsWith('/order')).map((w) => w.body))
      .toEqual([{ accountIds: ['a2', 'a1'] }]);
    await expect(rank).not.toHaveAttribute('data-pending', 'true');
    await expect(rank.locator('.set-ranked-item').first()).toHaveAttribute(
      'data-testid',
      'accounts-rank-claude-code-item-a2',
    );
    expect(await wsSent(page)).toEqual([]);
  });

  test('the strategy pills write the account strategy', async ({ page }) => {
    const s2 = await stubSettingsApi(page, {
      secrets: { claude: [{ id: 'a1', label: 'Work', connected: true }] },
    });
    await page.goto(settingsUrl('usage'));
    await page.getByTestId('strategy-claude-code-least-used').click();
    await expect
      .poll(() => s2.writes.filter((w) => w.path.endsWith('/strategy')).map((w) => w.body))
      .toEqual([{ strategy: 'least-used' }]);
  });

  test('an account’s ⋯ reveals its actions in place, and Disconnect names the account', async ({
    page,
  }) => {
    const s2 = await stubSettingsApi(page, {
      secrets: { claude: [{ id: 'a1', label: 'Work', connected: true }] },
    });
    await page.goto(settingsUrl('usage'));
    await expect(page.getByTestId('account-disconnect-claude-code-a1')).toHaveCount(0);
    await page.getByTestId('account-menu-claude-code-a1').click();
    await page.getByTestId('account-disconnect-claude-code-a1').click();
    await expect(page.getByTestId('confirm-modal')).toContainText('Work');
    await page.getByTestId('confirm-ok').click();
    await expect
      .poll(() => s2.writes.map((w) => `${w.method} ${w.path}`))
      .toContain('POST /api/accounts/claude-code/a1/disconnect');
  });

  test('MCP: toggling and adding send the whole list; a bad name is refused here', async ({
    page,
  }) => {
    await page.goto(settingsUrl('mcp'));
    await expect(page.getByTestId('mcp-unsupported')).toBeVisible();
    await reportHost(page, { harnessMcpServers: [PLAYWRIGHT_MCP] });
    await expect(page.getByTestId('mcp-server-patch')).toContainText('Always on');
    await expect(page.getByTestId('mcp-server-playwright')).toContainText(
      'npx @playwright/mcp --headless',
    );

    await page.getByTestId('mcp-server-playwright-enabled').click({ force: true });
    expect(await wsSent(page)).toContainEqual({
      type: 'host.settings',
      daemonId: 'd1',
      harnessMcpServers: [{ ...PLAYWRIGHT_MCP, enabled: false }],
    });

    await page.getByTestId('mcp-add').click();
    await page.getByTestId('mcp-editor-name').fill('bad name!');
    await page.getByTestId('mcp-editor-command').fill('uvx mcp-server-fetch');
    await page.getByTestId('mcp-editor-save').click();
    await expect(page.getByTestId('mcp-editor-error')).toHaveText(
      'Name may only use letters, digits, - and _ (at most 64)',
    );
    const before = (await wsSent(page)).length;

    await page.getByTestId('mcp-editor-name').fill('fetch');
    await page.getByTestId('mcp-editor-env').fill('FETCH_UA=patch');
    await page.getByTestId('mcp-editor-save').click();
    await expect(page.getByTestId('mcp-editor')).toHaveCount(0);
    const sent = await wsSent(page);
    expect(sent).toHaveLength(before + 1);
    expect(sent[sent.length - 1]).toEqual({
      type: 'host.settings',
      daemonId: 'd1',
      harnessMcpServers: [
        PLAYWRIGHT_MCP,
        {
          name: 'fetch',
          command: 'uvx',
          args: ['mcp-server-fetch'],
          env: { FETCH_UA: 'patch' },
          enabled: true,
        },
      ],
    });
  });

  test('Memories: search and type filter narrow the list; editing the text saves it', async ({
    page,
  }) => {
    await page.goto(settingsUrl('memories'));
    await setClaudeSettings(page, MEMORIES);
    const list = page.getByTestId('host-d1-memory-list');
    const items = list.locator('.set-mem-item');
    await expect(items).toHaveCount(3);
    // Grouped by project, as a person names it.
    await expect(list.locator('.set-mem-proj .set-label')).toHaveText(['portfolio', 'patch']);

    await page.getByTestId('memory-search').fill('mac');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Deploying patch');
    await expect(page.getByTestId('memory-detail')).toContainText('Deploying patch');

    await page.getByTestId('memory-search').fill('');
    await page.getByTestId('memory-filter-user').click();
    await expect(page.getByTestId('memory-filter-user')).toHaveAttribute('aria-pressed', 'true');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Tom');

    await page.getByTestId('memory-search').fill('zzz-nothing');
    await expect(page.getByTestId('memory-no-match')).toBeVisible();
    await page.getByTestId('memory-search').fill('');
    await page.getByTestId('memory-filter-All').click();
    await expect(items).toHaveCount(3);

    await page.getByTestId('host-d1-memory--home-tom-portfolio-feedback_tests.md').click();
    await expect(page.getByTestId('memory-rendered')).toHaveText(
      'Always write unit, integration and playwright tests.',
    );
    await page.getByTestId('memory-edit').click();
    const body = page.getByTestId('memory-body');
    await expect(body).toHaveValue('Always write unit, integration and playwright tests.');
    await expect(page.getByTestId('memory-meta')).toContainText('feedback · portfolio');
    await body.fill('Always write real tests.');
    await body.press('Control+Enter');
    expect(await wsSent(page)).toContainEqual({
      type: 'host.claude_memory_set',
      daemonId: 'd1',
      project: '-home-tom-portfolio',
      file: 'feedback_tests.md',
      body: 'Always write real tests.',
    });
  });

  test('Memories: the browser fills the settings panel on a wide window', async ({ page }) => {
    await page.setViewportSize({ width: 1290, height: 900 });
    await page.goto(settingsUrl('memories'));
    await setClaudeSettings(page, MEMORIES);
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    await expect(page.getByTestId('host-d1-memory-list')).toBeVisible();
    const main = await box('.set-main');
    const mem = await box('.set-mem');
    // The panel's full width less its padding (not the old 720px column), and
    // down to its bottom edge.
    expect(main.width - mem.width).toBeLessThan(90);
    expect(main.y + main.height - (mem.y + mem.height)).toBeLessThan(60);
    expect(mem.height).toBeGreaterThan(520);
  });

  test('Keys: adding a secret PUTs it and the list re-reads from the server', async ({ page }) => {
    let secrets: Array<{ key: string; value: string }> = [];
    const puts: Array<{ key: string; body: unknown }> = [];
    await page.route('**/api/secrets', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ secrets }),
      }),
    );
    await page.route('**/api/secrets/*', (r) => {
      expect(r.request().method()).toBe('PUT');
      const key = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()!);
      const body = r.request().postDataJSON() as { value: string };
      puts.push({ key, body });
      secrets = [...secrets, { key, value: body.value }];
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(settingsUrl('keys'));
    await expect(page.getByTestId('secrets-empty')).toBeVisible();

    await page.getByTestId('secret-add').click();
    await page.getByTestId('secret-editor-key').fill('TODOIST_TOKEN');
    const value = page.getByTestId('secret-editor-value');
    await expect(value).toHaveAttribute('type', 'password');
    await value.fill('tok-123');
    await page.getByTestId('secret-editor-save').click();

    await expect(page.getByTestId('secret-TODOIST_TOKEN')).toBeVisible();
    expect(puts).toEqual([{ key: 'TODOIST_TOKEN', body: { value: 'tok-123' } }]);
    await expect(page.getByTestId('secret-editor')).toHaveCount(0);
    await expect(page.getByTestId('secrets-empty')).toHaveCount(0);
    // Masked in the list.
    await expect(page.getByTestId('secret-TODOIST_TOKEN')).not.toContainText('tok-123');
  });

  test('Hosts: removing a host asks, DELETEs it, and drops it from the list', async ({ page }) => {
    const deletes: string[] = [];
    await page.route('**/api/hosts/d2', (r) => {
      deletes.push(r.request().method());
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, hosts: [] }),
      });
    });
    await page.goto(settingsUrl('hosts'));
    await addSecondHost(page);
    await expect(page.getByTestId('host-d1')).toBeVisible();
    await expect(page.getByTestId('host-d2')).toBeVisible();

    await page.getByTestId('host-d2').locator('.set-row-open').click();
    const detail = page.getByTestId('host-detail-d2');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('host-d2-name-input')).toHaveValue('mac');

    await page.getByTestId('host-d2-remove').click();
    const dialog = page.getByTestId('confirm-modal');
    await expect(dialog).toContainText('Remove mac');
    await page.getByTestId('confirm-ok').click();

    await expect(page.getByTestId('host-d2')).toHaveCount(0);
    await expect(detail).toHaveCount(0);
    await expect(page.getByTestId('host-d1')).toBeVisible();
    expect(deletes).toEqual(['DELETE']);
  });

  test('Updates: the nav’s pip shows when a host has an update waiting', async ({ page }) => {
    await page.goto(settingsUrl('agent'));
    await expect(page.getByTestId('settings-nav-updates')).toBeVisible();
    await expect(page.getByTestId('settings-nav-updates-pip')).toHaveCount(0);

    await reportHost(page, { updateAvailable: true });
    await expect(page.getByTestId('settings-nav-updates-pip')).toBeVisible();

    await page.getByTestId('settings-nav-updates').click();
    await expect(page.getByTestId('version-behind-d1')).toContainText('dev-host');
    await page.getByTestId('host-d1-update').click();
    expect(await wsSent(page)).toContainEqual({ type: 'host.update', daemonId: 'd1' });

    await reportHost(page, { updateAvailable: false });
    await expect(page.getByTestId('settings-nav-updates-pip')).toHaveCount(0);
    await expect(page.getByTestId('version-drift')).toHaveCount(0);
  });
});
