// In-memory presence tracker keyed by (accountId, surfaceId).
//
// Surfaces heartbeat every 10s (per spec/01). Connections that don't
// heartbeat within 30s are marked stale.
//
// Whether the user is AT A COMPUTER is a separate question, answered by input,
// not by heartbeats (spec/09 § Presence heuristic). A web or desktop window
// heartbeats whenever it is visible, which says nothing about whether anyone
// is sitting in front of it — a window left open on an empty desk used to hold
// every push back. Web and desktop surfaces report `surface.input` instead:
// the desktop app the whole machine's idle time, a browser tab its own page's.

export type PresenceStatus = 'online' | 'stale' | 'offline';

export type SurfaceKind = 'terminal' | 'web' | 'desktop' | 'mobile' | 'voice-device';

/**
 * What a client told us about its own build at hello time (spec/11 § Version
 * reporting). Recorded so `GET /api/version` can answer "what is my phone
 * actually running?" — the published artifact on the box says nothing about
 * whether a device ever installed it.
 *
 * `gitSha`/`builtAt` are absent on clients installed before build stamping
 * existed; absent means unknown, and the update panel renders it as unknown
 * rather than assuming current.
 */
export interface ClientBuildInfo {
  version: string;
  gitSha?: string;
  builtAt?: string;
}

export interface PresenceRecord {
  accountId: string;
  surfaceId: string;
  surfaceKind: SurfaceKind;
  status: PresenceStatus;
  lastHeartbeat: number;
  lastFocusedChatId?: string;
  /** Build the client reported at hello. Absent only for pre-check-in clients. */
  build?: ClientBuildInfo;
  /** When the user last touched this computer, per the surface's last `surface.input`. */
  lastInputAt?: number;
  /** When that report arrived — a surface that stops reporting says nothing. */
  inputReportedAt?: number;
}

/**
 * Wire shape returned by `GET /api/presence` (consumed by the CLI
 * `patch surfaces list`). Carries the surface `kind` (known at auth) plus a
 * derived `online` boolean so a live, heartbeating surface renders as online —
 * the CLI reads `surfaceKind`/`online`, not the internal `status` string.
 */
export interface PresenceView extends PresenceRecord {
  online: boolean;
}

export const PRESENCE_STALE_MS = 30_000;

/** Input within this long means the user is at the computer. */
export const AT_COMPUTER_IDLE_MS = 120_000;

/** Surfaces report input every 15s; three missed reports and it is no evidence. */
export const INPUT_REPORT_STALE_MS = 45_000;

/** Surfaces whose presence is judged by input rather than by heartbeat. */
function isComputerSurface(kind: SurfaceKind): boolean {
  return kind === 'web' || kind === 'desktop';
}

function key(accountId: string, surfaceId: string): string {
  return `${accountId}::${surfaceId}`;
}

export class PresenceTracker {
  private readonly records = new Map<string, PresenceRecord>();

  online(
    accountId: string,
    surfaceId: string,
    surfaceKind: SurfaceKind,
    nowMs: number = Date.now(),
    build?: ClientBuildInfo,
  ): void {
    this.records.set(key(accountId, surfaceId), {
      accountId,
      surfaceId,
      surfaceKind,
      status: 'online',
      lastHeartbeat: nowMs,
      ...(build ? { build } : {}),
    });
  }

  offline(accountId: string, surfaceId: string): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) return;
    this.records.set(k, { ...r, status: 'offline' });
  }

  drop(accountId: string, surfaceId: string): void {
    this.records.delete(key(accountId, surfaceId));
  }

  heartbeat(accountId: string, surfaceId: string, nowMs: number = Date.now()): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) {
      // Unknown surface — caller must call online() first. NO FALLBACK.
      throw new Error(`PresenceTracker.heartbeat: unknown surface ${surfaceId}`);
    }
    this.records.set(k, { ...r, status: 'online', lastHeartbeat: nowMs });
  }

  /** Record a `surface.input` report: the user last touched this computer `idleMs` ago. */
  input(accountId: string, surfaceId: string, idleMs: number, nowMs: number = Date.now()): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) {
      throw new Error(`PresenceTracker.input: unknown surface ${surfaceId}`);
    }
    this.records.set(k, { ...r, lastInputAt: nowMs - idleMs, inputReportedAt: nowMs });
  }

  setFocus(accountId: string, surfaceId: string, chatId: string | null): void {
    const k = key(accountId, surfaceId);
    const r = this.records.get(k);
    if (!r) {
      throw new Error(`PresenceTracker.setFocus: unknown surface ${surfaceId}`);
    }
    if (chatId === null) {
      const { lastFocusedChatId: _ignored, ...rest } = r;
      void _ignored;
      this.records.set(k, rest);
    } else {
      this.records.set(k, { ...r, lastFocusedChatId: chatId });
    }
  }

  /** Mark records as `stale` if their last heartbeat is older than `staleMs`. */
  sweep(nowMs: number = Date.now(), staleMs: number = PRESENCE_STALE_MS): void {
    for (const [k, r] of this.records.entries()) {
      if (r.status === 'online' && nowMs - r.lastHeartbeat > staleMs) {
        this.records.set(k, { ...r, status: 'stale' });
      }
    }
  }

  get(accountId: string, surfaceId: string): PresenceRecord | undefined {
    return this.records.get(key(accountId, surfaceId));
  }

  /**
   * spec/09 ## Presence heuristic — true when the user is somewhere a chat is
   * already in front of them: at a computer (see `isComputerActive`), or on a
   * phone with Patch open. Used by the push router to hold back an ordinary
   * push.
   */
  isActive(accountId: string, nowMs: number = Date.now()): boolean {
    if (this.isComputerActive(accountId, nowMs)) return true;
    for (const r of this.records.values()) {
      if (r.accountId !== accountId) continue;
      if (isComputerSurface(r.surfaceKind)) continue;
      if (r.status === 'offline') continue;
      if (nowMs - r.lastHeartbeat <= PRESENCE_STALE_MS) return true;
    }
    return false;
  }

  /**
   * spec/09 ## Presence heuristic — true when the user has touched a computer
   * Patch runs on within the last two minutes: any input on the machine when
   * the desktop app is reporting, input on the page for a browser tab. A
   * visible window on its own is not enough — only input says someone is
   * there. The terminal never reports, so it never counts.
   */
  isComputerActive(accountId: string, nowMs: number = Date.now()): boolean {
    for (const r of this.records.values()) {
      if (r.accountId !== accountId) continue;
      if (!isComputerSurface(r.surfaceKind)) continue;
      if (r.status === 'offline') continue;
      if (r.lastInputAt === undefined || r.inputReportedAt === undefined) continue;
      if (nowMs - r.inputReportedAt > INPUT_REPORT_STALE_MS) continue;
      if (nowMs - r.lastInputAt <= AT_COMPUTER_IDLE_MS) return true;
    }
    return false;
  }

  /**
   * Presence rows for the wire (`GET /api/presence`). Each row carries
   * `surfaceKind` and a derived `online` boolean (true iff status is 'online'),
   * so the CLI can render kind/online without re-deriving from `status`.
   */
  snapshot(): PresenceView[] {
    return Array.from(this.records.values()).map((r) => ({ ...r, online: r.status === 'online' }));
  }
}
