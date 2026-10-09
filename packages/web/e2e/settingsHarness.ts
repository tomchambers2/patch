import { devices, type Page, type Route } from '@playwright/test';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';

// Shared set-up for the Settings specs (design/settings-redesign): every page
// has its own address, so a spec boots the harness straight onto the page it
// is about — `/settings/<page>` — with the account APIs stubbed. The harness
// seeds one host, `d1` "dev-host", and records outbound socket frames on
// `window.__wsSent`.

export const ME = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web:web-1', issuedAt: 2 },
};

/** The shared settings (spec/01 § Settings) as the server starts them. */
export const PREFERENCES: Record<string, unknown> = { ...DEFAULT_SHARED_SETTINGS };

type Secrets = {
  claude: Array<Record<string, unknown>>;
  codex: Array<Record<string, unknown>>;
  providerKeys: Array<{ id: string; set: boolean; last4?: string }>;
};

export const NO_SECRETS: Secrets = {
  claude: [],
  codex: [],
  providerKeys: [
    { id: 'gemini', set: false },
    { id: 'openai', set: false },
    { id: 'groq', set: false },
  ],
};

export const SETTINGS_PAYLOAD = {
  account: ME.account,
  devices: [
    {
      surfaceId: 'web-1',
      surfaceKind: 'web',
      label: 'web:web-1',
      status: 'online',
      isCurrent: true,
    },
  ],
  push: { tokenCount: 2 },
  daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
  projectFolders: [],
  preferences: PREFERENCES,
};

export const VERSION_REPORT = {
  checkedAt: '2026-09-07T12:00:00.000Z',
  server: {
    version: '0.1.900',
    gitSha: '9b8635f',
    builtAt: '2026-09-07T10:00:00.000Z',
    startedAt: '2026-09-07T11:00:00.000Z',
    serverSha: '9b8635f',
  },
  web: {
    version: '0.1.900',
    gitSha: '9b8635f',
    builtAt: '2026-09-07T10:00:00.000Z',
    bundle: 'assets/index-CtWBatg1.js',
    expectedServerSha: '9b8635f',
    deployedAt: '2026-09-07T10:05:00.000Z',
  },
  daemon: null,
  desktop: null,
  android: null,
  clients: [],
  hosts: [],
  drift: [],
};

/**
 * The Pixel 7 descriptor (Tom's phone class), minus `defaultBrowserType`, which
 * a describe-level `test.use` may not set.
 */
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
void _browser;
export const PIXEL_7 = pixel7;

/** `/settings` itself, or one page of it. */
export function settingsUrl(page?: string): string {
  return `/app/dev-harness.html?route=/settings${page ? `/${page}` : ''}`;
}

/** What the fake server recorded: preference patches and every shared-settings write. */
export interface SettingsServer {
  patches: Array<Record<string, unknown>>;
  writes: Array<{ method: string; path: string; body: unknown }>;
  /** The secrets as the server now holds them (summaries, never values). */
  secrets: Secrets;
}

/**
 * Stub what every Settings page reads, and the shared-settings writes (spec/03
 * § Settings) as the server answers them: `/api/settings` PATCH merges and
 * answers the preferences; an account or key write is recorded and answered
 * with the committed state `answer` returns (the current state by default).
 */
export async function stubSettingsApi(
  page: Page,
  opts: {
    payload?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    secrets?: Partial<Secrets>;
    answer?: (
      write: { method: string; path: string; body: unknown },
      server: SettingsServer,
    ) => { status?: number; body?: unknown } | void;
  } = {},
): Promise<SettingsServer> {
  const server: SettingsServer = {
    patches: [],
    writes: [],
    secrets: { ...NO_SECRETS, ...(opts.secrets ?? {}) },
  };
  let version = 1;
  let preferences: Record<string, unknown> = { ...PREFERENCES, ...(opts.preferences ?? {}) };
  const payload = { ...SETTINGS_PAYLOAD, ...(opts.payload ?? {}) };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const state = () => ({ version, settings: preferences, secrets: server.secrets, hosts: [] });
  await page.route('**/api/auth/me', (r) => r.fulfill(json(ME)));
  await page.route('**/api/settings', (r) => {
    if (r.request().method() === 'PATCH') {
      const patch = r.request().postDataJSON() as Record<string, unknown>;
      server.patches.push(patch);
      preferences = { ...preferences, ...patch };
      version += 1;
      return r.fulfill(json({ preferences }));
    }
    const { settings: _s, ...shared } = state();
    void _s;
    return r.fulfill(json({ ...payload, preferences, shared }));
  });
  await page.route('**/api/settings/shared', (r) => r.fulfill(json(state())));
  const write = (r: Route) => {
    const req = r.request();
    const w = {
      method: req.method(),
      path: new URL(req.url()).pathname,
      body: req.postData() ? req.postDataJSON() : undefined,
    };
    server.writes.push(w);
    const custom = opts.answer?.(w, server);
    version += 1;
    if (custom && custom.status !== undefined && custom.status >= 400) {
      return r.fulfill(json(custom.body ?? {}, custom.status));
    }
    return r.fulfill(json(custom?.body ?? state()));
  };
  await page.route('**/api/accounts/**', write);
  await page.route('**/api/providers/keys/**', write);
  await page.route('**/api/settings/claude/adopt', write);
  await page.route('**/api/healthz', (r) =>
    r.fulfill(json({ ok: true, version: '0.0.0', gitSha: 'abc1234' })),
  );
  await page.route('**/api/version', (r) => r.fulfill(json(VERSION_REPORT)));
  await page.route('**/api/secrets', (r) => r.fulfill(json({ secrets: [] })));
  return server;
}

type Store = {
  getState(): {
    hosts: Record<string, { host: Record<string, unknown> | null }>;
    setHostReport(r: Record<string, unknown>): void;
    setHostOnline(daemonId: string, online: boolean): void;
    setHostAccount(r: Record<string, unknown>): void;
    setClaudeSettings(daemonId: string, drift: string | undefined, memories: unknown[]): void;
  };
};

/** Play a fresh `daemon.host` for `daemonId`: d1's report with `patch` applied. */
export async function reportHost(
  page: Page,
  patch: Record<string, unknown>,
  daemonId = 'd1',
): Promise<void> {
  await page.evaluate(
    ({ p, id }) => {
      const store = (window as unknown as { __presenceStore: Store }).__presenceStore;
      const base = store.getState().hosts['d1']!.host!;
      store.getState().setHostReport({ ...base, type: 'daemon.host', daemonId: id, ...p });
    },
    { p: patch, id: daemonId },
  );
}

/** A second host, `d2` "mac", online and reported. */
export async function addSecondHost(
  page: Page,
  patch: Record<string, unknown> = {},
): Promise<void> {
  await reportHost(page, { hostName: 'mac', isHomeHost: false, ...patch }, 'd2');
  await page.evaluate(() =>
    (window as unknown as { __presenceStore: Store }).__presenceStore
      .getState()
      .setHostOnline('d2', true),
  );
}

/** Play a host's `claude_settings.list`: its memories, and any settings.json drift. */
export async function setClaudeSettings(
  page: Page,
  memories: unknown[] = [],
  opts: { drift?: string; daemonId?: string } = {},
): Promise<void> {
  await page.evaluate(
    ({ mems, drift, id }) =>
      (window as unknown as { __presenceStore: Store }).__presenceStore
        .getState()
        .setClaudeSettings(id, drift ?? undefined, mems),
    { mems: memories, drift: opts.drift ?? null, id: opts.daemonId ?? 'd1' },
  );
}

export async function setHostAccount(page: Page, report: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (r) =>
      (window as unknown as { __presenceStore: Store }).__presenceStore
        .getState()
        .setHostAccount({ type: 'daemon.account', ...r }),
    report,
  );
}

export async function wsSent(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () => (window as unknown as { __wsSent: Array<Record<string, unknown>> }).__wsSent,
  );
}
