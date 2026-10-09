// Scheduled special-thread session rotation (spec/06 § Session rotation).
//
// Deterministic here, the actual rotation mechanics (`rotateThread`) live on
// the host — same split as the Manager watch loop: the server is the one
// component that always runs regardless of which surface is open, so it owns
// the clock; the host owns the session it's rotating.
//
// This exists because auto-compaction alone isn't a rotation policy — it
// fires whenever the SDK's own context window happens to fill, which moved by
// 4-5x just from a model change (Manager sat on ~750k cached tokens a turn
// for 18 days without a single compaction under opus-5, having compacted
// three times around ~170k under the previous model). A scheduled rotation
// makes the cost and freshness predictable instead of riding whatever the
// window happens to be this week, and does it overnight rather than at a
// random point in an active conversation.

import type { Logger } from 'pino';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { AccountSettings } from './settings.js';

const SPECIAL_THREAD_LIST: readonly string[] = Object.values(SPECIAL_THREAD_IDS);

export interface ThreadRotatorDeps {
  chats: ChatRegistry;
  settings: () => AccountSettings;
  /** Ask this chat's host to rotate it (fire-and-forget, same shape as the
   *  Manager watcher's `deliver` — the daemon-link forwards it to whichever
   *  host runs the special threads). */
  rotate: (chatId: string) => void;
  logger: Pick<Logger, 'info'>;
  clock?: () => Date;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function hhmm(at: Date): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function isoDay(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

export class ThreadRotator {
  private readonly deps: ThreadRotatorDeps;
  private readonly clock: () => Date;
  /**
   * The local calendar day (YYYY-MM-DD) each thread last had a rotation
   * ATTEMPTED, so the once-a-minute tick doesn't re-fire for the whole minute
   * the clock matches `rotationTime`, and a thread that was mid-turn during
   * that minute simply waits for tomorrow rather than being retried in a tight
   * loop for the rest of the day.
   */
  private readonly lastAttemptedDay = new Map<string, string>();

  constructor(deps: ThreadRotatorDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Called on a steady tick (mirrors `ManagerSweeper.tick`). Returns whether
   * any thread was rotated this call, which is what tests assert on.
   */
  tick(): boolean {
    const settings = this.deps.settings();
    if (!settings.rotationEnabled) return false;
    const at = this.clock();
    if (hhmm(at) !== settings.rotationTime) return false;
    const today = isoDay(at);
    let rotatedAny = false;
    for (const chatId of SPECIAL_THREAD_LIST) {
      if (this.lastAttemptedDay.get(chatId) === today) continue;
      const chat = this.deps.chats.get(chatId);
      // Not registered yet (a fresh install whose host hasn't bootstrapped
      // it) — nothing to rotate, and not "handled" either, so it's picked up
      // the moment it does exist rather than waiting for tomorrow's minute.
      if (!chat) continue;
      this.lastAttemptedDay.set(chatId, today);
      // Disabled (spec/06 § Disabled) — an intentionally-off thread has no
      // conversation accumulating, so there is nothing to rotate away from.
      if (chat.disabled) continue;
      // Mid-turn: the host's own guard would refuse this anyway, but
      // checking here avoids sending a request that can only be rejected —
      // and per the day-key above, this thread simply waits for tomorrow's
      // window rather than being hammered for the rest of today's minute.
      if (chat.activity === 'running' || chat.activity === 'awaiting-permission') continue;
      this.deps.rotate(chatId);
      this.deps.logger.info({ chatId }, 'thread-rotation: rotation requested');
      rotatedAny = true;
    }
    return rotatedAny;
  }
}
