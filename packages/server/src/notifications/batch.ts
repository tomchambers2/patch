// Batch notifier (spec/14 § Batch mode, spec/09 § Batch check-in).
//
// The live half of batch mode: `BatchStore` (`../batch/store.js`) is pure
// bookkeeping, and this is what drives it off the real chat stream —
// auto-membership, the check-in triggers, and ending. It observes the SAME
// `chat.state` stream `chat-complete.ts` does, at the same subscription point
// (after the chat registry), for the same reason: both need the mirror
// already caught up to the frame they are reading.
//
// Suppression itself (spec/09 § Chat completion) is NOT here — it is a gate
// `chat-complete.ts` consults directly off `BatchStore.isSuppressedMember`,
// the same shape as the existing job gate. This class only decides WHEN to
// check in and WHEN to end, and sends the one check-in notification.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import { BATCH_NOTIFY_CHAT_ID, isReservedSpecialThread } from '@patch/wire';
import type { ChatRegistry } from '../chat-registry.js';
import type { BatchStore } from '../batch/store.js';
import type { NotificationRouter } from './router.js';

export interface BatchNotifierDeps {
  store: BatchStore;
  chats: ChatRegistry;
  router: NotificationRouter;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  /** Override for tests — avoids a real pending timer outliving the test. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class BatchNotifier {
  private readonly deps: BatchNotifierDeps;
  private readonly now: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private timer: unknown = null;
  private armedForBatchId: string | null = null;

  constructor(deps: BatchNotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.setTimeoutFn = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Call once at boot: arms the check-in timer for a batch restored from disk,
   *  and fires immediately if its deadline already passed while the server was
   *  down (NO FALLBACK — a missed check-in is never silently skipped). Also
   *  catches a restored batch that is already all-done. */
  start(): void {
    this.arm();
    this.recomputeTriggers();
  }

  private arm(): void {
    const batch = this.deps.store.current();
    if (!batch || batch.checkedIn) {
      this.clearTimer();
      return;
    }
    if (this.armedForBatchId === batch.id) return;
    this.clearTimer();
    const delay = Math.max(0, batch.checkInAt - this.now());
    this.armedForBatchId = batch.id;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.fireCheckIn();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.armedForBatchId = null;
  }

  private isReady(chatId: string): boolean {
    const chat = this.deps.chats.get(chatId);
    // A member whose chat has gone (deleted) is not something still to wait
    // on — it cannot block a check-in or an ending.
    if (!chat) return true;
    return chat.activity !== 'running';
  }

  /** Observe the host's wire stream: auto-join, and recompute both triggers. */
  observe(event: WireEvent): void {
    if (event.type === 'chat.state') {
      this.observeAutoJoin(event);
      this.recomputeTriggers();
    }
  }

  /**
   * spec/14 § Batch mode — "every chat the user starts or sends a message to
   * ... joins it automatically". The edge INTO `running` on a `user` turn is
   * exactly that moment, the same edge `chat-complete.ts` reads the opposite
   * side of. `previous === undefined` (a brand-new chat this process has not
   * seen before) counts too — that is "starts a chat".
   */
  private observeAutoJoin(event: Extract<WireEvent, { type: 'chat.state' }>): void {
    const batch = this.deps.store.current();
    if (!batch) return;
    if (event.activity !== 'running') return;
    if (event.turnOrigin === 'machine') return;
    if (isReservedSpecialThread(event.chatId)) return;
    this.deps.store.ensureMember(event.chatId);
  }

  /** Re-evaluate both the check-in trigger and the ending condition. Called on
   *  every relevant chat.state AND after a REST mutation (remove/opened) that
   *  could complete either. */
  recomputeTriggers(): void {
    const batch = this.deps.store.current();
    if (!batch) {
      this.clearTimer();
      return;
    }
    this.arm();
    if (!batch.checkedIn) {
      if (
        batch.checkIn.type === 'all-done' &&
        batch.members.length > 0 &&
        batch.members.every((id) => this.isReady(id))
      ) {
        this.fireCheckIn();
      }
      return;
    }
    this.maybeEnd();
  }

  /** The automatic triggers (time elapsed, or all-done) — NOT `Check in now`,
   *  which calls `BatchStore.checkIn()` directly and skips the notification
   *  (spec/09 § Batch check-in — the user is already looking at the view). */
  private fireCheckIn(): void {
    this.clearTimer();
    const batch = this.deps.store.current();
    if (!batch || batch.checkedIn) return;
    this.deps.store.checkIn();
    const total = batch.members.length;
    const done = batch.members.filter((id) => this.isReady(id)).length;
    const message = `Batch ready: ${done} done, ${total - done} still running`;
    // Same desktop/push split as spec/09 § Chat completion: desktop fires on
    // every desktop surface, push only when no computer surface is active.
    this.send('desktop', message);
    this.send('push', message);
    this.maybeEnd();
  }

  private send(channel: 'desktop' | 'push', message: string): void {
    void this.deps.router
      .route(
        { type: 'notify', chatId: BATCH_NOTIFY_CHAT_ID, channel, message, kind: 'batch' },
        channel === 'push' ? { suppressOn: 'computer' } : {},
      )
      .catch((err: unknown) => {
        this.deps.logger.warn(
          { channel, err: (err as Error).message },
          'batch: check-in notify failed',
        );
      });
  }

  /** spec/14 § Batch mode — "ends when the user has opened every finished
   *  member". Only ready members count; a still-running one never blocks. */
  private maybeEnd(): void {
    const batch = this.deps.store.current();
    if (!batch || !batch.checkedIn) return;
    const readyIds = batch.members.filter((id) => this.isReady(id));
    if (readyIds.length === 0) return;
    if (readyIds.every((id) => batch.openedMemberIds.includes(id))) {
      this.deps.store.end((id) => this.isReady(id));
      this.clearTimer();
    }
  }
}
