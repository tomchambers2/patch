// Durable self-wake scheduler (spec/02-daemon.md § Self-wake).
//
// A self-wake is a chat asking the host to re-invoke ITSELF after a delay —
// "in 10 minutes, deliver this message back to me as a new turn". Distinct from
// the job system (which fires an external schedule into a usually-new chat):
// a wake is self-targeted, adaptive (the agent picks the next interval each
// tick), looping, and self-terminating (the agent stops re-arming when done).
//
// The host owns the timer; the agent declares intent via `patch_wake_me` and
// ENDS its turn (no blocking wait — that would die on a host restart). The
// wake persists to disk, so it survives restarts: on boot the host re-arms
// future wakes and fires overdue ones once (the agent's own clock-check decides
// whether a late wake is still relevant). This is the durability `CronCreate`
// can't give us — Claude Code's in-session crons die with the SDK turn (the
// host runs no resident Claude process between turns).
//
// A record's optional `every` (ms) makes it a LOOP instead of a one-shot: on
// fire the host recomputes `fireAt = now + every` and re-persists instead of
// clearing, so the cadence is mechanically guaranteed by the host rather than
// depending on the agent choosing to re-arm on every single tick (`patch_loop`,
// spec/02 § Self-wake). A plain one-shot `patch_wake_me` record has no `every`
// and keeps the original clear-on-fire behaviour.
//
// A loop's interval counts from the END of a turn, not from the tick that
// happened to come due. When a loop fires while the chat is already busy (its
// own just-started delivery, or an unrelated turn), the tick is absorbed, not
// queued: the record is marked `waiting` and left unarmed, and
// `WakeScheduler.onTurnEnd` — called by the host once the chat's pump
// actually empties — is what arms the next `fireAt = now + every`, measured
// from that moment. `waiting` is persisted, so a host that restarts
// mid-turn still re-arms (boot treats a loop found `waiting` as a turn that
// has, from the new process's point of view, ended).

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';

/** A pending self-wake, persisted at `<chatDir>/wake.json`. */
export const WakeRecord = z
  .object({
    chatId: z.string().min(1),
    message: z.string().min(1),
    /** Absolute fire time (ms epoch). */
    fireAt: z.number().int(),
    /** Optional validity cutoff (ms epoch): drop the wake if it fires past this. */
    notAfter: z.number().int().optional(),
    createdAt: z.number().int(),
    /**
     * Recurring interval (ms). When set, firing this record does NOT clear
     * it — the host recomputes `fireAt = now + every` and re-persists
     * atomically instead, mechanically re-arming the loop forever (or until
     * `cancel()`/`notAfter`) without depending on the agent (or anything
     * else) calling back in on every tick. Absent means the classic one-shot
     * wake: fire once, clear (spec/02 § Self-wake, "One-shot + loop").
     */
    every: z.number().int().positive().optional(),
    /**
     * Set when a loop's tick came due while the chat was busy (its own
     * about-to-start turn, or an unrelated one already running) and was
     * absorbed rather than delivered/enqueued. `fireAt` is stale while this
     * is true — the host arms a fresh one (`onTurnEnd`, or on boot) once it
     * knows the turn has actually ended. Meaningless without `every`: a
     * one-shot wake is never marked waiting.
     */
    waiting: z.boolean().optional(),
  })
  .strict();
export type WakeRecord = z.infer<typeof WakeRecord>;

export interface WakeSchedulerDeps {
  /** Deliver the (prefixed) wake message into the chat as a new turn. */
  deliver(chatId: string, message: string): void | Promise<void>;
  /** The chat's on-disk dir (where wake.json lives) — typically the meta dir. */
  dirForChat(chatId: string): string;
  /** Every chatId known on disk — scanned on boot to re-arm persisted wakes. */
  allChatIds(): string[];
  /** Whether the chat's pump is currently occupied by a running turn. */
  isBusy(chatId: string): boolean;
  now(): number;
  logger: Logger;
  /** Injectable timers (tests drive them deterministically). */
  setTimer?(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(t: ReturnType<typeof setTimeout>): void;
}

const WAKE_FILE = 'wake.json';
/** Metadata tag on the delivered turn — like `[voice • …]`, data not directive
 *  (principles.md § No system-prompt injection). The agent's CLAUDE.md decides
 *  what to do with it. */
export const WAKE_PREFIX = '[wake]';
/** setTimeout's signed-32-bit ms ceiling (~24.8 days). Longer delays re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_000;

export class WakeScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: WakeSchedulerDeps) {
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  private filePath(chatId: string): string {
    return join(this.deps.dirForChat(chatId), WAKE_FILE);
  }

  /**
   * Schedule (or REPLACE) the pending self-wake for a chat. One pending wake per
   * chat — re-calling overwrites, which is exactly the loop: each tick the agent
   * re-arms the next one. Persisted (atomic write) before arming.
   */
  schedule(rec: WakeRecord): void {
    this.disarm(rec.chatId);
    this.persist(rec);
    this.arm(rec);
  }

  /** Atomic tmp-write + rename — the one place wake.json is ever written. */
  private persist(rec: WakeRecord): void {
    const dir = this.deps.dirForChat(rec.chatId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = this.filePath(rec.chatId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), 'utf8');
    renameSync(tmp, path); // atomic — a crash mid-write can't corrupt wake.json
  }

  /** Cancel the pending self-wake (disarm + remove the file). Returns whether one existed. */
  cancel(chatId: string): boolean {
    const had = this.timers.has(chatId) || existsSync(this.filePath(chatId));
    this.disarm(chatId);
    rmSync(this.filePath(chatId), { force: true });
    return had;
  }

  /** The pending wake for a chat, or null. */
  peek(chatId: string): WakeRecord | null {
    return this.read(chatId);
  }

  private disarm(chatId: string): void {
    const t = this.timers.get(chatId);
    if (t !== undefined) {
      this.clearTimer(t);
      this.timers.delete(chatId);
    }
  }

  private arm(rec: WakeRecord): void {
    const delay = Math.max(0, rec.fireAt - this.deps.now());
    if (delay > MAX_TIMEOUT_MS) {
      // Long horizon: re-arm in chunks so the 32-bit setTimeout cap can't overflow.
      const t = this.setTimer(() => this.arm(rec), MAX_TIMEOUT_MS);
      this.timers.set(rec.chatId, t);
      return;
    }
    const t = this.setTimer(() => {
      void this.fire(rec.chatId);
    }, delay);
    this.timers.set(rec.chatId, t);
  }

  private async fire(chatId: string): Promise<void> {
    this.timers.delete(chatId);
    const rec = this.read(chatId);
    if (!rec) return;
    if (rec.notAfter !== undefined && this.deps.now() > rec.notAfter) {
      this.deps.logger.info({ chatId, notAfter: rec.notAfter }, 'wake: dropped (past notAfter)');
      rmSync(this.filePath(chatId), { force: true });
      return;
    }
    if (rec.every !== undefined) {
      // Recurring + the chat is already busy with an unrelated turn: don't
      // deliver (and don't let `sendInput` enqueue it either — we just never
      // call `deliver`). Count the interval from the END of that turn instead
      // of from this tick (02-daemon.md § Self-wake): mark the loop `waiting`
      // and leave it unarmed — `onTurnEnd` (called by the host once the
      // chat's pump actually empties) is what arms the next `fireAt`, so a
      // long turn absorbs every tick that lands inside it rather than queuing
      // one behind it per tick.
      if (this.deps.isBusy(chatId)) {
        this.persist({ ...rec, waiting: true });
        this.deps.logger.info(
          { chatId },
          'wake: loop tick absorbed — turn already running, waiting for it to end',
        );
        return;
      }
      // Not busy: re-arm BEFORE delivering, same as a one-shot's "mechanically
      // guaranteed" comment below — this keeps the ordinary (non-colliding)
      // cadence exactly as before. If THIS delivery's own turn runs long
      // enough to still be going when that next fire lands, the busy branch
      // above is what catches it — and `onTurnEnd` then re-arms from when the
      // turn actually ends instead of stacking further ticks behind it.
      const next: WakeRecord = { ...rec, fireAt: this.deps.now() + rec.every };
      this.persist(next);
      this.arm(next);
    } else {
      // One-shot: clear before delivering. The agent re-arms a fresh wake
      // (the adaptive loop) if it wants to continue, or does nothing to stop.
      rmSync(this.filePath(chatId), { force: true });
    }
    try {
      await this.deps.deliver(chatId, `${WAKE_PREFIX} ${rec.message}`);
    } catch (err) {
      this.deps.logger.error({ chatId, err }, 'wake: delivery failed');
    }
  }

  /**
   * Called by the host once a chat's turn has settled (its pump is empty
   * again). If that chat has a loop marked `waiting` — a tick was absorbed
   * while it ran, or it's the turn the loop's own delivery just started —
   * arm the next `fireAt` from NOW, measuring the interval from the end of
   * the turn rather than from whenever it fired. A no-op for any chat
   * without a waiting loop (the overwhelmingly common case: nothing to do).
   * Returns whether it actually re-armed something, so callers that emit
   * state on change know whether this changed anything.
   */
  onTurnEnd(chatId: string): boolean {
    const rec = this.read(chatId);
    if (!rec || rec.every === undefined || rec.waiting !== true) return false;
    this.rearmFresh(rec, rec.every);
    return true;
  }

  /** `waiting`'s way out: persist + arm a fresh `fireAt = now + every`, dropping `waiting`. */
  private rearmFresh(rec: WakeRecord, every: number): void {
    const next: WakeRecord = {
      chatId: rec.chatId,
      message: rec.message,
      createdAt: rec.createdAt,
      every,
      fireAt: this.deps.now() + every,
      ...(rec.notAfter !== undefined ? { notAfter: rec.notAfter } : {}),
    };
    this.persist(next);
    this.arm(next);
  }

  private read(chatId: string): WakeRecord | null {
    const p = this.filePath(chatId);
    if (!existsSync(p)) return null;
    try {
      return WakeRecord.parse(JSON.parse(readFileSync(p, 'utf8')));
    } catch (err) {
      this.deps.logger.warn({ chatId, err }, 'wake: corrupt wake.json, dropping');
      rmSync(p, { force: true });
      return null;
    }
  }

  /**
   * Boot: load every persisted wake. Fire overdue ones once (per the chosen
   * restart policy — a wake whose time passed during downtime fires once at
   * startup; the agent's clock-check decides if it's still relevant). Arm the rest.
   */
  loadAll(): void {
    for (const chatId of this.deps.allChatIds()) {
      const rec = this.read(chatId);
      if (!rec) continue;
      if (rec.notAfter !== undefined && this.deps.now() > rec.notAfter) {
        this.deps.logger.info({ chatId }, 'wake: dropped on boot (past notAfter)');
        rmSync(this.filePath(chatId), { force: true });
        continue;
      }
      if (rec.waiting === true && rec.every !== undefined) {
        // A loop left `waiting` on a turn that was running when the host
        // died. From this fresh process's point of view that turn is over —
        // there is nothing left to wait on — so boot IS the turn ending:
        // re-arm a fresh interval from now rather than re-delivering the
        // absorbed tick (the turn itself, if genuinely interrupted, is
        // resumed separately via the chat's own pending-turn replay).
        this.deps.logger.info({ chatId }, 'wake: waiting loop re-armed on boot');
        this.rearmFresh(rec, rec.every);
        continue;
      }
      if (rec.fireAt <= this.deps.now()) {
        this.deps.logger.info(
          { chatId, overdueMs: this.deps.now() - rec.fireAt },
          'wake: firing overdue wake on boot',
        );
        void this.fire(chatId);
      } else {
        this.arm(rec);
      }
    }
  }

  /** Stop all timers (host shutdown). */
  dispose(): void {
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
  }
}

/**
 * Parse a relative `in` duration → milliseconds. Accepts `"10m"`, `"1h30m"`,
 * `"90s"`, `"2h"`, a bare number (seconds), or ISO-8601 `"PT10M"`. Throws on
 * anything else (NO silent fallback).
 */
export function parseDelayMs(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid delay: ${input}`);
    return Math.round(input * 1000);
  }
  const s = input.trim();
  if (s === '') throw new Error('invalid delay: empty');
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(s);
  if (iso && (iso[1] ?? iso[2] ?? iso[3])) {
    return (Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)) * 1000;
  }
  const compact = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(s);
  if (compact && (compact[1] ?? compact[2] ?? compact[3])) {
    return (
      (Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0)) *
      1000
    );
  }
  // Bare number = seconds (must be a pure numeric string, not "" or "1x").
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  throw new Error(`invalid delay: ${input}`);
}
