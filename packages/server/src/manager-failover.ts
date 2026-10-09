// Manager failover (spec/06 § Manager failover).
//
// The Manager lives on the home host. When that host has been offline for a
// while and another host is up, the server asks the other host to run the
// Manager for the time being, giving it the recent conversation from the
// server's own copy so the Manager can pick up where it left off. When the home
// host returns, the Manager goes back, and is told what was said meanwhile.
//
// The Manager's messages keep one sequence across hosts: the stand-in numbers
// its messages from where the server's copy ends, and the home host does the
// same on its return. The stretch the home host's own log is missing is
// answered from the server's copy (`gapEvents`).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import type { ChatLogStore } from './chat-log-store.js';

/** How long the home host must be offline before another host takes over. */
export const FAILOVER_GRACE_MS = 120_000;

const MESSAGE_CHARS = 2_000;
const HANDOFF_CHARS = 24_000;
const SERVER_SURFACE = '_server';

interface Gap {
  from: number;
  to: number | null;
}

interface HostOrder {
  kind: 'adopt' | 'release';
  event: WireEvent;
}

interface State {
  acting: string | null;
  epoch: number;
  gaps: Gap[];
  orders: Record<string, HostOrder>;
}

export interface ManagerFailoverDeps {
  /** The account's home host, as the registry names it. */
  homeDaemonId: () => string | null;
  registeredDaemonIds: () => string[];
  isOnline: (daemonId: string) => boolean;
  onHostStatus: (handler: (daemonId: string, status: 'online' | 'offline') => void) => () => void;
  sendTo: (daemonId: string, surfaceId: string, event: WireEvent) => void;
  log: Pick<ChatLogStore, 'read'>;
  /** How many messages of the conversation to hand over. */
  contextWindow: () => number;
  dataDir?: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  graceMs?: number;
}

export class ManagerFailover {
  private state: State = { acting: null, epoch: 0, gaps: [], orders: {} };
  private readonly path: string | null;
  private readonly graceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ManagerFailoverDeps) {
    this.graceMs = deps.graceMs ?? FAILOVER_GRACE_MS;
    this.path = deps.dataDir ? join(deps.dataDir, 'manager-failover.json') : null;
    this.load();
  }

  /** Begin watching host presence. */
  start(): void {
    this.unsubscribe = this.deps.onHostStatus((daemonId, status) =>
      this.onStatus(daemonId, status),
    );
    // A server restart while the home host was already down.
    if (this.homeOffline() && this.state.acting === null) this.armTimer();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  /** The host currently standing in for the home host, or null. */
  acting(): string | null {
    return this.state.acting;
  }

  /** The host that owns the Manager and Speakers right now. */
  specialThreadHost(): string | null {
    return this.state.acting ?? this.deps.homeDaemonId();
  }

  /**
   * The Manager's events from the stretches the home host's own log is missing,
   * after `fromSeq`. Empty when no takeover has happened.
   */
  gapEvents(fromSeq: number): WireEvent[] {
    if (this.state.gaps.length === 0) return [];
    return this.deps.log.read(SPECIAL_THREAD_IDS.manager, fromSeq).filter((e) => {
      const seq = (e as { seq: number }).seq;
      return this.state.gaps.some((g) => seq >= g.from && (g.to === null || seq <= g.to));
    });
  }

  private onStatus(daemonId: string, status: 'online' | 'offline'): void {
    const home = this.deps.homeDaemonId();
    if (status === 'online') {
      // A host that missed an order while it was away is told again; it acts on
      // each takeover once.
      const order = this.state.orders[daemonId];
      if (order) this.deps.sendTo(daemonId, SERVER_SURFACE, order.event);
      if (daemonId === home) {
        this.clearTimer();
        if (this.state.acting !== null) this.handBack(this.state.acting, daemonId);
      } else if (this.homeOffline() && this.state.acting === null) {
        this.armTimer();
      }
      return;
    }
    if (daemonId === home) {
      if (this.state.acting === null) this.armTimer();
    } else if (daemonId === this.state.acting) {
      // The stand-in went away: another may take over, or the home host returns.
      this.state.acting = null;
      this.closeGap();
      this.save();
      if (this.homeOffline()) this.activate();
    }
  }

  private homeOffline(): boolean {
    const home = this.deps.homeDaemonId();
    return home !== null && !this.deps.isOnline(home);
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.homeOffline() && this.state.acting === null) this.activate();
    }, this.graceMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private maxSeq(): number {
    const events = this.deps.log.read(SPECIAL_THREAD_IDS.manager, -1);
    const last = events.at(-1) as { seq: number } | undefined;
    return last ? last.seq : -1;
  }

  private activate(): void {
    const home = this.deps.homeDaemonId();
    const candidate = this.deps
      .registeredDaemonIds()
      .find((id) => id !== home && this.deps.isOnline(id));
    if (candidate === undefined) {
      this.deps.logger.warn({}, 'manager-failover: home host offline and no other host is up');
      return;
    }
    const nextSeq = this.maxSeq() + 1;
    this.state.epoch += 1;
    this.state.acting = candidate;
    this.state.gaps.push({ from: nextSeq, to: null });
    const event: WireEvent = {
      type: 'host.manager_adopt',
      daemonId: candidate,
      epoch: this.state.epoch,
      handoff: this.handoffText(-1, 'the home machine is offline'),
      nextSeq,
    };
    this.state.orders[candidate] = { kind: 'adopt', event };
    this.save();
    this.deps.logger.info(
      { daemonId: candidate, epoch: this.state.epoch },
      'manager-failover: stand-in chosen',
    );
    this.deps.sendTo(candidate, SERVER_SURFACE, event);
  }

  private handBack(standIn: string, home: string): void {
    const gapFrom = this.state.gaps.at(-1)?.from ?? 0;
    this.state.acting = null;
    this.closeGap();
    this.state.epoch += 1;
    this.state.orders[standIn] = {
      kind: 'release',
      event: { type: 'host.manager_release', daemonId: standIn, epoch: this.state.epoch },
    };
    const gap = this.state.gaps.at(-1);
    const nextSeq = this.maxSeq() + 1;
    // The home host is told what it missed only when something was said.
    if (gap && gap.to !== null && gap.to >= gap.from) {
      this.state.orders[home] = {
        kind: 'adopt',
        event: {
          type: 'host.manager_adopt',
          daemonId: home,
          epoch: this.state.epoch,
          handoff: this.handoffText(
            gapFrom - 1,
            'it was run on another machine while you were away',
          ),
          nextSeq,
        },
      };
    } else {
      delete this.state.orders[home];
    }
    this.save();
    this.deps.logger.info({ standIn, home }, 'manager-failover: handed back to the home host');
    this.deps.sendTo(standIn, SERVER_SURFACE, this.state.orders[standIn]!.event);
    const toHome = this.state.orders[home];
    if (toHome) this.deps.sendTo(home, SERVER_SURFACE, toHome.event);
  }

  /** The stretch being recorded ends at the last event the server holds. */
  private closeGap(): void {
    const gap = this.state.gaps.at(-1);
    if (gap && gap.to === null) gap.to = this.maxSeq();
  }

  private handoffText(afterSeq: number, why: string): string {
    const lines: string[] = [];
    for (const e of this.deps.log.read(SPECIAL_THREAD_IDS.manager, afterSeq)) {
      if (e.type !== 'chat.message' || e.role === 'system') continue;
      lines.push(`${e.role}: ${e.content.slice(0, MESSAGE_CHARS)}`);
    }
    const recent = lines.slice(-this.deps.contextWindow());
    let body = recent.join('\n\n');
    if (body.length > HANDOFF_CHARS) body = body.slice(body.length - HANDOFF_CHARS);
    return (
      `[handoff] You are the Manager, and ${why}. This is the recent conversation, oldest first, ` +
      `for you to carry on from:\n\n${body === '' ? '(nothing yet)' : body}`
    );
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      this.state = { ...this.state, ...(JSON.parse(readFileSync(this.path, 'utf8')) as State) };
    } catch (err) {
      this.deps.logger.warn({ err }, 'manager-failover: could not read its state; starting clean');
    }
  }

  private save(): void {
    if (this.path === null) return;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.path);
    } catch (err) {
      this.deps.logger.warn({ err }, 'manager-failover: could not write its state');
    }
  }
}
