// Shared scaffolding for the Settings tests (design/settings-redesign).
//
// spec/14 § Panes and tabs: Settings is now ONE pane tab, with its own pages
// as internal state rather than real `/settings/<page>` routes. This harness
// still renders at a real URL (`/settings/<page>` deep-links still work,
// via `requestSettingsPage` — see `SettingsPaneRoute`), mounting the SAME
// bridge AppShell does so the nav, the host switcher and a deep link's page
// request are all in play exactly as they are in production.

import { vi } from 'vitest';
import { render } from '@testing-library/react';
import type { JSX } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPaneRoute } from '../routes/SettingsPaneRoute.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { PromptModal } from '../components/PromptModal.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { DEFAULT_PREFERENCES, usePreferencesStore } from '../stores/preferencesStore.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { clearHosts } from './presenceHelpers.js';

export const ME_PAYLOAD = {
  account: { accountId: 'acct-123', userPublicKey: 'acct-123', createdAt: 1 },
  surface: { surfaceId: 'web-dev-1', surfaceKind: 'web', label: 'web:web-dev-1', issuedAt: 2 },
};

export const SETTINGS_PAYLOAD = {
  account: ME_PAYLOAD.account,
  devices: [
    {
      surfaceId: 'web-dev-1',
      surfaceKind: 'web',
      label: 'web:web-dev-1',
      issuedAt: 2,
      status: 'online',
      lastHeartbeat: 1000,
      isCurrent: true,
    },
    {
      surfaceId: 'mob-7',
      surfaceKind: 'mobile',
      label: 'mobile:pixel',
      issuedAt: 3,
      status: 'offline',
      lastHeartbeat: null,
      isCurrent: false,
    },
  ],
  push: { tokenCount: 2 },
  daemon: { registered: true, status: 'online', lastConnectedAt: 1700000000000 },
  projectFolders: [],
};

/** A minimal agreeing version report: nothing behind, so no nav pip. */
export const VERSION_PAYLOAD = {
  checkedAt: '2026-07-28T12:00:00.000Z',
  server: {
    version: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    startedAt: '2026-07-28T11:00:00.000Z',
  },
  web: null,
  daemon: null,
  desktop: null,
  android: null,
  clients: [],
  drift: [],
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

/**
 * Route fetch by URL to the right fixture. `overrides` patch the
 * `/api/settings` payload; `handler` answers first when it returns a Response.
 */
export function makeFetch(overrides: Record<string, unknown> = {}, handler?: Handler) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const own = handler?.(u, init);
    if (own) return own;
    if (u.includes('/api/version')) return json(VERSION_PAYLOAD);
    if (u.includes('/api/auth/me')) return json(ME_PAYLOAD);
    if (u.includes('/api/settings') && (init?.method ?? 'GET') === 'GET') {
      return json({ ...SETTINGS_PAYLOAD, ...overrides });
    }
    if (u.includes('/api/models')) return json({ models: [] });
    if (u.includes('/api/secrets')) return json({ secrets: [] });
    if (u.includes('/api/auth/daemon/pair/start') || u.includes('/pair/start')) {
      return json({ nonce: 'NONCE-abc123def456', expiresAt: Date.now() + 300_000 });
    }
    // Default OK for actions (revoke).
    return json({ ok: true });
  });
}

/** Shows where the router is, so a test can assert a redirect or a link. */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

/** The Settings shell at `path`, with the app's toasts and modals beside it. */
export function renderSettings(path = '/settings'): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/*" element={<SettingsPaneRoute ws={null} />} />
          <Route path="*" element={<div data-testid="not-settings" />} />
        </Routes>
        <LocationProbe />
        <ErrorToasts />
        <ConfirmModal />
        <PromptModal />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A live socket that records what it was asked to send. */
export function fakeWs(send: (e: unknown) => void = () => {}): {
  sent: unknown[];
  ws: PatchWs;
  forceReconnect: ReturnType<typeof vi.fn>;
} {
  const sent: unknown[] = [];
  const forceReconnect = vi.fn();
  const ws = {
    send: (e: unknown) => {
      send(e);
      sent.push(e);
    },
    forceReconnect,
  } as unknown as PatchWs;
  setActiveWs(ws);
  return { sent, ws, forceReconnect };
}

/**
 * Answers `PATCH /api/settings` as the server does — the merged preferences —
 * recording each patch, so a test can see what an account-wide control wrote.
 */
export function preferencesServer(current: () => Record<string, unknown>): {
  writes: Record<string, unknown>[];
  handler: Handler;
} {
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    handler: (url, init) => {
      if (!url.includes('/api/settings') || init?.method !== 'PATCH') return null;
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(patch);
      return json({ preferences: { ...current(), ...patch } });
    },
  };
}

/**
 * The state every Settings test starts from: no toasts, no pending modal, no
 * host chosen in the switcher, no host reported, both links up and no socket.
 */
export function resetSettingsState(): void {
  useLayoutStore.getState()._reset();
  useUiStore.getState().clearToasts();
  // Clear any confirm/prompt left pending by a prior test (resolves its promise).
  useUiStore.getState().resolveConfirm(false);
  useUiStore.getState().resolvePrompt(null);
  useUiStore.getState().setCodexSignInHost(null);
  useSettingsHostStore.setState({ selected: null });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: true, shared: null });
  clearHosts();
  usePresenceStore.getState().setConnection('connected');
  setActiveWs(null);
}
