// Presence + connection state. Two INDEPENDENT things are tracked and must
// never collapse into one indicator (spec/12 § Surface connection state model):
//   - the WS link to the server (`connection`)
//   - the host presence (`daemon`)
// The server can be reachable while the host is down.

import { create } from 'zustand';
import type {
  AuthOkHost,
  ClaudeMemoryEntry,
  DaemonAccountEvent,
  DaemonHostEvent,
} from '@patch/wire';

// WS link states. On first launch we are `connecting` — a neutral, quiet
// state that must NEVER render an offline/reconnecting treatment before a
// connection has ever been established (spec/12 § No offline flash on load).
/**
 * `unauthenticated` is TERMINAL and is not a connection problem: the server
 * refused this surface's credential (hub close 4401 / `auth.revoked`). The
 * others describe a link that could still come back on its own; this one
 * cannot, and no amount of retrying changes it — the user has to link the
 * device again (spec/10 § Surface).
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'unauthenticated';

// Host presence. `unknown` until the first daemon.online / daemon.offline
// greeting arrives on connect — distinct from a known `offline`.
export type DaemonPresence = 'unknown' | 'online' | 'offline';

// One backend's credential state on ONE host (`daemon.account`, spec/10 §
// Surface in Settings). Credentials are per host per backend — they live on the
// machine that runs the turns — so there is deliberately no account-wide copy of
// this anywhere in the store. Absent (no entry) means that host has not reported
// yet: Settings shows a checking state, NEVER a guessed "not connected".
//
// `seq` counts the reports seen for this (host, backend) pair. Settings'
// connect/disconnect resolve on a FRESH report, and a report can legitimately
// repeat the value it just had (a disconnect the host failed to apply reports
// `connected: true` again), so the value alone cannot distinguish "answered"
// from "never answered".
export type HostAccount = Omit<DaemonAccountEvent, 'type'> & { seq: number };

/** Why the last WebSocket closed — a diagnostics input (spec/12 § Connection diagnostics screen). */
export interface WsCloseInfo {
  code: number;
  reason: string;
  at: number;
}

/** What the surface knows about one registered host (spec/03 § `auth.ok`). */
export interface HostPresence {
  daemonId: string;
  online: boolean;
  lastSeenAt: number | null;
  host: Omit<DaemonHostEvent, 'type'> | null;
  accounts: Record<string, HostAccount>;
  /**
   * That host's Claude Code settings.json + memory entries
   * (`claude_settings.list` / `.updated`, spec/02 § Claude Code settings).
   * Absent/null until the host has reported it — Settings then draws no editor
   * rather than an empty one that would read as "this machine has none".
   */
  claudeSettings?: { drift?: string; memories: ClaudeMemoryEntry[] } | null;
}

/**
 * One backend's credential state on one host, or `null` when that host has not
 * reported it yet. The ONLY way to ask "is Claude connected?" — the question is
 * meaningless without naming a machine, so the answer always takes one.
 */
export function hostAccount(
  hosts: Record<string, HostPresence>,
  daemonId: string | null,
  backendId: string,
): HostAccount | null {
  if (daemonId === null || daemonId === '') return null;
  return hosts[daemonId]?.accounts[backendId] ?? null;
}

/**
 * The model a spawn on `daemonId` that names none will run on — that host's
 * last-used model (spec/04 § Spawn), as it reports it. `null` until the host
 * has reported one, in which case the surface has nothing to preselect and a
 * model-less spawn there is an error the host raises, never a guess made here.
 */
export function hostDefaultModel(
  hosts: Record<string, HostPresence>,
  daemonId: string | null,
): string | null {
  if (daemonId === null || daemonId === '') return null;
  return hosts[daemonId]?.host?.defaultModel ?? null;
}

interface PresenceState {
  connection: ConnectionState;
  /**
   * Whether the WS outage is worth telling the user about: the app has been in
   * the FOREGROUND with the link down for longer than the disconnect grace
   * (`DISCONNECT_GRACE_MS` in api/ws.ts). Drives the amber banner only —
   * `connection` stays the true link state for diagnostics and controls. A
   * socket Android dropped while the app sat in the background, and the
   * reconnect that follows opening it again, never set this
   * (spec/12 § Surface connection state model).
   */
  outageVisible: boolean;
  setOutageVisible(v: boolean): void;
  /**
   * Every registered host, keyed by daemonId, seeded from the `auth.ok`
   * greeting so the list is complete even for machines that are asleep.
   */
  hosts: Record<string, HostPresence>;
  /**
   * Aggregate over `hosts`: `online` while ANY host is up, matching
   * `/api/daemon/healthz` without a daemonId (spec/01 § Endpoints). `unknown`
   * until the greeting lands, so the first paint is neutral rather than a
   * false "offline" flash.
   */
  daemon: DaemonPresence;
  /**
   * Connection forensics for the diagnostics screen (spec/12 § Connection
   * diagnostics screen). `everConnected` is what separates "this surface has
   * never got a link up" (blocking error screen — there is no app behind it)
   * from "we were connected and dropped" (banner + navigable app), so it must
   * never be inferred from `connection` alone.
   */
  wsUrl: string | null;
  everConnected: boolean;
  failedAttempts: number;
  lastClose: WsCloseInfo | null;
  accountId: string | null;
  surfaceId: string | null;
  setConnection(s: ConnectionState): void;
  /**
   * Why the server refused this surface, or null when it hasn't. Drives the
   * "you were signed out" line on the pairing screen, so the user is told what
   * happened rather than meeting an unexplained sign-in prompt.
   */
  authRejected: string | null;
  setAuthRejected(reason: string | null): void;
  setDaemon(p: DaemonPresence): void;
  /** Seed the whole roster from the `auth.ok` greeting. */
  setHosts(hosts: AuthOkHost[]): void;
  /** One host's presence changed (`daemon.online` / `daemon.offline`). */
  setHostOnline(daemonId: string, online: boolean): void;
  /** One host's self-description (`daemon.host`). */
  setHostReport(report: DaemonHostEvent): void;
  /** One backend's credential state on one host (`daemon.account`). */
  setHostAccount(report: DaemonAccountEvent): void;
  /**
   * A host was removed from the account (`host.removed`, or the answer to this
   * surface's own `DELETE /api/hosts/:daemonId`): drop it and every report
   * cached for it. It cannot reconnect without being paired again.
   */
  removeHost(daemonId: string): void;
  /** One host's Claude Code settings + memory snapshot (`claude_settings.*`). */
  setClaudeSettings(
    daemonId: string,
    drift: string | undefined,
    memories: ClaudeMemoryEntry[],
  ): void;
  /** A socket reached OPEN: clears the failure counters. */
  noteWsOpen(url: string): void;
  /** A socket closed (or a connect attempt failed): records why, counts it. */
  noteWsClose(info: WsCloseInfo): void;
  setIdentity(accountId: string | null, surfaceId: string | null): void;
}

/** A host row for a daemonId the store has not seen described yet. */
function blankHost(daemonId: string): HostPresence {
  return { daemonId, online: false, lastSeenAt: null, host: null, accounts: {} };
}

const anyOnline = (hosts: Record<string, HostPresence>): boolean =>
  Object.values(hosts).some((h) => h.online);

/**
 * The host a host-scoped action targets when the user has not picked one: the
 * account's HOME host, else the only registered one. With several and no home
 * marked there is no right answer, so this returns null and the caller refuses
 * — sending a host-scoped edit to a guessed machine is precisely what
 * `daemonId` exists to prevent.
 */
export function defaultDaemonId(hosts: Record<string, HostPresence>): string | null {
  const all = Object.values(hosts);
  const home = all.find((h) => h.host?.isHomeHost === true);
  if (home) return home.daemonId;
  return all.length === 1 ? (all[0] as HostPresence).daemonId : null;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  // NO offline flash on load: start `connecting` with `unknown` host
  // presence so the first paint shows a neutral, quiet indicator.
  connection: 'connecting',
  outageVisible: false,
  authRejected: null,
  hosts: {},
  daemon: 'unknown',
  wsUrl: null,
  everConnected: false,
  failedAttempts: 0,
  lastClose: null,
  accountId: null,
  surfaceId: null,
  setAuthRejected(reason) {
    set({ authRejected: reason });
  },

  setConnection(s) {
    set({ connection: s });
  },
  setOutageVisible(v) {
    set({ outageVisible: v });
  },
  setDaemon(p) {
    set({ daemon: p });
  },
  setHosts(list) {
    const hosts: Record<string, HostPresence> = {};
    for (const h of list) {
      const accounts: Record<string, HostAccount> = {};
      for (const a of h.accounts) accounts[a.backendId] = { ...a, seq: 1 };
      hosts[h.daemonId] = {
        daemonId: h.daemonId,
        online: h.online,
        lastSeenAt: h.lastSeenAt,
        host: h.host,
        accounts,
        // The greeting carries no settings snapshot; the server replays it as
        // a separate frame right after. Keep one already received.
        claudeSettings: get().hosts[h.daemonId]?.claudeSettings ?? null,
      };
    }
    set({ hosts, daemon: anyOnline(hosts) ? 'online' : 'offline' });
  },
  setHostOnline(daemonId, online) {
    set((s) => {
      const prev = s.hosts[daemonId] ?? blankHost(daemonId);
      const hosts = {
        ...s.hosts,
        [daemonId]: { ...prev, online, ...(online ? { lastSeenAt: Date.now() } : {}) },
      };
      return { hosts, daemon: anyOnline(hosts) ? 'online' : 'offline' };
    });
  },
  setHostReport(report) {
    set((s) => {
      // Strip the wire envelope; the store holds the payload.
      const { type: _envelope, ...host } = report;
      void _envelope;
      const prev = s.hosts[report.daemonId] ?? blankHost(report.daemonId);
      return { hosts: { ...s.hosts, [report.daemonId]: { ...prev, host } } };
    });
  },
  setHostAccount(report) {
    set((s) => {
      const { type: _envelope, ...account } = report;
      void _envelope;
      const prev = s.hosts[report.daemonId] ?? blankHost(report.daemonId);
      const seq = (prev.accounts[report.backendId]?.seq ?? 0) + 1;
      return {
        hosts: {
          ...s.hosts,
          [report.daemonId]: {
            ...prev,
            accounts: { ...prev.accounts, [report.backendId]: { ...account, seq } },
          },
        },
      };
    });
  },
  removeHost(daemonId) {
    set((s) => {
      if (!s.hosts[daemonId]) return {};
      const hosts = { ...s.hosts };
      delete hosts[daemonId];
      return { hosts, daemon: anyOnline(hosts) ? 'online' : 'offline' };
    });
  },
  setClaudeSettings(daemonId, drift, memories) {
    set((s) => {
      const prev = s.hosts[daemonId] ?? blankHost(daemonId);
      return {
        hosts: {
          ...s.hosts,
          [daemonId]: {
            ...prev,
            claudeSettings: { ...(drift !== undefined ? { drift } : {}), memories },
          },
        },
      };
    });
  },
  noteWsOpen(url) {
    set({ wsUrl: url, everConnected: true, failedAttempts: 0 });
  },
  noteWsClose(info) {
    set((s) => ({ lastClose: info, failedAttempts: s.failedAttempts + 1 }));
  },
  setIdentity(accountId, surfaceId) {
    set({ accountId, surfaceId });
  },
}));
