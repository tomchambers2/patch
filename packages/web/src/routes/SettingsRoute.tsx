// SettingsRoute — the Settings shell (design/settings-redesign).
//
// A left nav of pages grouped Agents / Setup / System, and the chosen page
// beside it. On a phone the nav IS the first screen — a full-width list — and
// a page opens over it with a back arrow; that switch is pure CSS
// (`.settings-route.open`).
//
// spec/14 § Panes and tabs: Settings is now ONE `{kind:'page', page:'settings'}`
// pane tab, like Jobs or a job's editor — so which of its own pages is on
// screen is this component's OWN state, not a nested `/settings/<page>` route:
// there is only ever one Settings tab (`tabKey` doesn't vary by sub-page), and
// switching sub-pages inside it must not fight whatever URL opened that tab
// (a chat's deep link, a reload). This drops the old per-page bookmarkable
// address in exchange for behaving like every other tab's own internal nav
// (e.g. a file tab's diff toggle) — a deliberate trade, not an oversight.
//
// The pages themselves live in ./settings/, one file each. This file owns only
// what every page shares: the account settings poll that keeps the
// preferences store in step with the server, and the nav.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/rest.js';
import { NavHistoryControls } from '../components/NavHistoryControls.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { DEFAULT_SETTINGS_PAGE, SETTINGS_PAGES, type SettingsPageId } from './settings/pages.js';
import { SettingsBackContext } from './settings/ui.js';
import { useBehind } from './settings/UpdatesPage.js';
import { UsagePage } from './settings/UsagePage.js';
import { AgentPage } from './settings/AgentPage.js';
import { McpPage } from './settings/McpPage.js';
import { MemoriesPage } from './settings/MemoriesPage.js';
import { ManagerPage } from './settings/ManagerPage.js';
import { GoalsPage } from './settings/GoalsPage.js';
import { VoicePage } from './settings/VoicePage.js';
import { HooksPage } from './settings/HooksPage.js';
import { HostsPage } from './settings/HostsPage.js';
import { JobsPage } from './settings/JobsPage.js';
import { KeysPage } from './settings/KeysPage.js';
import { DevicesPage } from './settings/DevicesPage.js';
import { UpdatesPage } from './settings/UpdatesPage.js';
import { AccountPage } from './settings/AccountPage.js';

const PAGE_COMPONENTS: Record<SettingsPageId, () => JSX.Element> = {
  usage: UsagePage,
  agent: AgentPage,
  mcp: McpPage,
  memories: MemoriesPage,
  manager: ManagerPage,
  goals: GoalsPage,
  voice: VoicePage,
  hooks: HooksPage,
  jobs: JobsPage,
  hosts: HostsPage,
  keys: KeysPage,
  devices: DevicesPage,
  updates: UpdatesPage,
  account: AccountPage,
};

export function SettingsRoute(): JSX.Element {
  // `null` is the phone-width "nav list, no page open yet" state — desktop
  // still shows `DEFAULT_SETTINGS_PAGE` beside the nav regardless, exactly as
  // bare `/settings` used to (see the `current ?? DEFAULT_SETTINGS_PAGE` below).
  const [current, setCurrent] = useState<SettingsPageId | null>(null);
  // Whether `current` was seeded by a deep link (below) and never left for
  // the list since — i.e. the user has not actually "drilled into" this page
  // from Settings' own nav, so its Back has nowhere inside Settings to step
  // back TO. `back-returns-to-origin.spec.ts`: a chat's "Usage" banner link
  // replaces the chat's own tab with Settings already open on that page
  // (spec/14 § Opening things — a plain click replaces the active tab), so
  // Back here has to leave the Settings tab and return to the chat, the same
  // as the old per-page URL's Back did via browser history — not fall back
  // to the page list, which the user never asked to see.
  const [arrivedViaDeepLink, setArrivedViaDeepLink] = useState(false);
  const navigate = useNavigate();
  const { key: locationKey } = useLocation();

  // A banner/link elsewhere (OutOfUsageBanner, a chat's "Sign in" prompt, …)
  // asked Settings to land on a specific page — see `SettingsPaneRoute`'s
  // note. Consumed once, then cleared, so returning to this tab later leaves
  // whatever page the user was last actually looking at.
  const settingsPageRequest = useUiStore((s) => s.settingsPageRequest);
  const clearSettingsPageRequest = useUiStore((s) => s.clearSettingsPageRequest);
  useEffect(() => {
    if (!settingsPageRequest) return;
    setCurrent(settingsPageRequest);
    setArrivedViaDeepLink(true);
    clearSettingsPageRequest();
  }, [settingsPageRequest, clearSettingsPageRequest]);

  function selectPage(page: SettingsPageId): void {
    setArrivedViaDeepLink(false);
    setCurrent(page);
  }

  function goBack(): void {
    if (!arrivedViaDeepLink) {
      setCurrent(null);
      return;
    }
    setArrivedViaDeepLink(false);
    // No real history behind this tab (a direct `/settings/<page>` load) —
    // same "nothing earlier to return to" fallback `useGoBack` used to make,
    // just landing on the in-tab list instead of a URL.
    if (locationKey === 'default') setCurrent(null);
    else navigate(-1);
  }

  const {
    data: settings,
    error,
    refetch,
  } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings(), refetchInterval: 15_000 });

  // One source of truth for the account preferences: whatever this poll last
  // saw. The store is what the Manager, Agent and Voice pages' controls and a
  // quiet voice call all read, so it must not drift from the server behind them.
  const setPreferences = usePreferencesStore((s) => s.set);
  const preferences = settings?.preferences;
  useEffect(() => {
    if (preferences) setPreferences(preferences);
  }, [preferences, setPreferences]);

  if (error) {
    return (
      <div className="route-error" data-testid="settings-error">
        Failed to load settings: {(error as Error).message}
        <button type="button" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const Current = PAGE_COMPONENTS[current ?? DEFAULT_SETTINGS_PAGE];
  return (
    <SettingsBackContext.Provider value={goBack}>
      <main
        className={`settings-route${current ? ' open' : ''}`}
        data-testid="settings-route"
        data-page={current ?? 'index'}
      >
        <SettingsNav current={current ?? DEFAULT_SETTINGS_PAGE} onSelect={selectPage} />
        <div className="set-main" data-testid="settings-main">
          <SecretsProblem />
          <Current />
        </div>
      </main>
    </SettingsBackContext.Provider>
  );
}

/** The server cannot read its stored accounts and keys, so no host is sent settings. */
function SecretsProblem(): JSX.Element | null {
  const problem = usePreferencesStore((s) => s.shared?.problem);
  if (!problem) return null;
  return (
    <p className="set-warning" role="alert" data-testid="settings-secrets-problem">
      {problem}
    </p>
  );
}

function SettingsNav({
  current,
  onSelect,
}: {
  current: SettingsPageId;
  onSelect: (p: SettingsPageId) => void;
}): JSX.Element {
  const behind = useBehind();
  let lastGroup = '';
  return (
    <nav className="set-nav" data-testid="settings-nav" aria-label="Settings">
      <div className="route-head-title">
        <NavHistoryControls />
        <h1 className="display">Settings</h1>
      </div>
      {SETTINGS_PAGES.map((p) => {
        const heading =
          p.group !== lastGroup ? (
            <h2 className="set-label" key={`g-${p.group}`}>
              {p.group}
            </h2>
          ) : null;
        lastGroup = p.group;
        return [
          heading,
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={p.id === current ? 'on' : undefined}
            aria-current={p.id === current ? 'page' : undefined}
            data-testid={`settings-nav-${p.id}`}
          >
            <span>{p.title}</span>
            {p.id === 'updates' && behind.length > 0 ? (
              <i className="set-pip" data-testid="settings-nav-updates-pip" aria-label="Behind" />
            ) : null}
          </button>,
        ];
      })}
    </nav>
  );
}
