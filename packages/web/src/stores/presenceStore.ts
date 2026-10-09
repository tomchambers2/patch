// presenceStore — connection state to the server WS + host link state.
//
// The amber 'Reconnecting…' banner reads `connection`. The composer reads
// `connection` to decide whether to disable input. Daemon-link state is
// driven by `daemon.online` / `daemon.offline` events and shown as a
// per-chat banner per spec/14 ## Offline / error states.

import { create } from 'zustand';
import type {
  AuthOkHost,
  ClaudeMemoryEntry,
  DaemonAccountEvent,
  DaemonHostEvent,
} from '@patch/wire';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/**
 * One backend's credential state on ONE host (`daemon.account`, spec/10 §
 * Surface in Settings). Credentials are per host per backend — they live on the
 * machine that runs the turns — so there is deliberately no account-wide copy of
 * this anywhere in the store.
 *
 * `seq` counts the reports the surface has seen for this (host, backend) pair.
 * Settings' connect/disconnect resolve on a FRESH report, and a report can
 * legitimately repeat the value it just had (a disconnect the host failed to
 * apply reports `connected: true` again), so the value alone cannot distinguish
 * "answered" from "never answered".
 */
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
  /** The host's last self-description; null until it has reported one. */
  host: Omit<DaemonHostEvent, 'type'> | null;
  /** Per-backend credential state, keyed by backendId. */
  accounts: Record<string, HostAccount>;
  /**
   * That host's Claude Code settings.json + memory entries
   * (`claude_settings.list` / `.updated`, spec/02 § Claude Code settings);
   * null until the host has reported it.
   */
  claudeSettings: { drift?: string; memories: ClaudeMemoryEntry[] } | null;
  /**
   * That host's folder registry (`folders.list` / `folders.updated`, spec/04 §
   * Folders): its designated project `roots` and the folders `recent` chats ran
   * in. Null until the host has published one — an unreported registry is not
   * an empty one, and Settings says which it is.
   */
  folders: { roots: string[]; recent: string[] } | null;
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
 * The model a chat spawned on this host takes when the spawn names none — the
 * ACCOUNT's default model, mirrored to the host by the server (spec/04 § Spawn),
 * reported in `daemon.host` and replayed in the `auth.ok` greeting.
 *
 * `null` until the default has reached that host, in which case a model-less
 * spawn there is an error the host raises (`no_model_catalogue`) rather than
 * something the surface papers over.
 *
 * This used to report the host's own LAST-USED model, which was derived from
 * whatever chat last ran there and drifted accordingly.
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
   * Every registered host, keyed by daemonId. Seeded from the `auth.ok`
   * greeting so the list is complete — including machines that are asleep and
   * will never send a `daemon.online` — then kept live by presence and report
   * frames.
   */
  hosts: Record<string, HostPresence>;
  /**
   * True while ANY host is online — the same rule `/api/daemon/healthz` uses
   * without a daemonId (spec/01 § Endpoints). This is an aggregate over
   * `hosts`, not a separate source of truth: per-host banners read `hosts`.
   */
  daemonOnline: boolean;
  /**
   * Connection forensics for the diagnostics screen (spec/12 § Connection
   * diagnostics screen). `everConnected` is what separates "this surface has
   * never got a link up" (blocking error screen — there is no app behind it)
   * from "we were connected and dropped" (banner + navigable app), so it must
   * never be inferred from `connection` alone.
   */
  wsUrl: string | null;
  everConnected: boolean;
  /** True once an `auth.ok` greeting has seeded `hosts`; before that `daemonOnline` is unknown, not false. */
  hostsSeeded: boolean;
  failedAttempts: number;
  lastClose: WsCloseInfo | null;
  /** Account / surface info, populated after `auth.ok`. */
  accountId: string | null;
  surfaceId: string | null;

  setConnection(s: ConnectionState): void;
  /** Seed the whole roster from the `auth.ok` greeting, replacing what was there. */
  setHosts(hosts: AuthOkHost[]): void;
  /**
   * A host was removed from the account (`host.removed`, or Settings → Hosts →
   * Remove). Drops it and every report cached for it — its credential is
   * revoked, so nothing about it is current any more.
   */
  removeHost(daemonId: string): void;
  /** One host's presence changed (`daemon.online` / `daemon.offline`). */
  setHostOnline(daemonId: string, online: boolean): void;
  /** One host's self-description (`daemon.host`). */
  setHostReport(report: DaemonHostEvent): void;
  /** One backend's credential state on one host (`daemon.account`). */
  setHostAccount(report: DaemonAccountEvent): void;
  /** One host's Claude Code settings + memory snapshot (`claude_settings.list` / `.updated`). */
  setClaudeSettings(
    daemonId: string,
    drift: string | undefined,
    memories: ClaudeMemoryEntry[],
  ): void;
  /** One host's folder registry, replaced whole (`folders.list` / `.updated`). */
  setHostFolders(daemonId: string, roots: string[], recent: string[]): void;
  /** A socket reached OPEN: clears the failure counters. */
  noteWsOpen(url: string): void;
  /** A socket closed (or a connect attempt failed): records why, counts it. */
  noteWsClose(info: WsCloseInfo): void;
  setIdentity(accountId: string | null, surfaceId: string | null): void;
}

/**
 * The host a host-scoped action targets when the user has not picked one.
 *
 * The account's HOME host wins, because that is the machine the special
 * threads and the account's defaults live on. Failing that, a single
 * registered host is unambiguous. With several and no home marked, there is no
 * right answer, so this returns null and the caller refuses with a message
 * rather than picking one — sending a host-scoped edit to a guessed machine is
 * the exact failure `daemonId` was added to the wire to prevent.
 *
 * E1's Hosts UI replaces this with an explicit selection; until then it is the
 * single place that decides, so there is one thing to change.
 */
export function defaultDaemonId(hosts: Record<string, HostPresence>): string | null {
  const all = Object.values(hosts);
  const home = all.find((h) => h.host?.isHomeHost === true);
  if (home) return home.daemonId;
  return all.length === 1 ? (all[0] as HostPresence).daemonId : null;
}

/** A host row for a daemonId the store has not seen described yet. */
function blankHost(daemonId: string): HostPresence {
  return {
    daemonId,
    online: false,
    lastSeenAt: null,
    host: null,
    accounts: {},
    claudeSettings: null,
    folders: null,
  };
}

const anyOnline = (hosts: Record<string, HostPresence>): boolean =>
  Object.values(hosts).some((h) => h.online);

export const usePresenceStore = create<PresenceState>((set) => ({
  connection: 'offline',
  hosts: {},
  daemonOnline: false,
  wsUrl: null,
  everConnected: false,
  hostsSeeded: false,
  failedAttempts: 0,
  lastClose: null,
  accountId: null,
  surfaceId: null,
  setConnection(s) {
    set({ connection: s });
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
        claudeSettings: null,
        folders: null,
      };
    }
    set({ hosts, daemonOnline: anyOnline(hosts), hostsSeeded: true });
  },
  removeHost(daemonId) {
    set((s) => {
      if (!(daemonId in s.hosts)) return {};
      const hosts = { ...s.hosts };
      delete hosts[daemonId];
      return { hosts, daemonOnline: anyOnline(hosts) };
    });
  },
  setHostOnline(daemonId, online) {
    set((s) => {
      const prev = s.hosts[daemonId] ?? blankHost(daemonId);
      const hosts = {
        ...s.hosts,
        [daemonId]: { ...prev, online, ...(online ? { lastSeenAt: Date.now() } : {}) },
      };
      return { hosts, daemonOnline: anyOnline(hosts) };
    });
  },
  setHostReport(report) {
    set((s) => {
      // Strip the wire envelope; the store holds the payload.
      const { type: _envelope, ...host } = report;
      void _envelope;
      const prev = s.hosts[report.daemonId] ?? blankHost(report.daemonId);
      const hosts = { ...s.hosts, [report.daemonId]: { ...prev, host } };
      return { hosts };
    });
  },
  setHostAccount(report) {
    set((s) => {
      const { type: _envelope, ...account } = report;
      void _envelope;
      const prev = s.hosts[report.daemonId] ?? blankHost(report.daemonId);
      const seq = (prev.accounts[report.backendId]?.seq ?? 0) + 1;
      const hosts = {
        ...s.hosts,
        [report.daemonId]: {
          ...prev,
          accounts: { ...prev.accounts, [report.backendId]: { ...account, seq } },
        },
      };
      return { hosts };
    });
  },
  setClaudeSettings(daemonId, drift, memories) {
    set((s) => {
      const prev = s.hosts[daemonId] ?? blankHost(daemonId);
      const hosts = {
        ...s.hosts,
        [daemonId]: {
          ...prev,
          claudeSettings: { ...(drift !== undefined ? { drift } : {}), memories },
        },
      };
      return { hosts };
    });
  },
  setHostFolders(daemonId, roots, recent) {
    set((s) => {
      const prev = s.hosts[daemonId] ?? blankHost(daemonId);
      // Both events carry the COMPLETE registry for ONE host, so it replaces
      // that host's lists outright and leaves every other host's alone.
      return { hosts: { ...s.hosts, [daemonId]: { ...prev, folders: { roots, recent } } } };
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
