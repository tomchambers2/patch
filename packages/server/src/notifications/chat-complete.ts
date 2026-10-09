// Chat-completion notifications (spec/09 § Chat completion).
//
// The notifications Patch raises without an agent asking it to: a chat's turn
// settles, or fails for good, and the user is told. Everything else in this
// directory (bar awaiting-permission.ts) starts with a `patch_notify` tool call.
//
// It lives on the server for the same reason the Manager watch loop does — the
// server sees every host's chats and runs whether or not a surface is open —
// and it reads the same `chat.state` stream, but the two are independent:
// watching feeds the Manager agent, which then decides whether to interrupt,
// while this is the unconditional doorbell.
//
// Desktop always fires; push fires only when no computer surface is active. The
// asymmetry is the whole feature: the toast is free when you are at the machine
// (and delivered nowhere when you aren't), the push is what reaches you when
// you have walked away.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import { isReservedSpecialThread, isTransientChatError } from '@patch/wire';
import type { Job } from '../jobs/types.js';
import type { ChatRegistry, ChatSummary } from '../chat-registry.js';
import type { NotificationRouter } from './router.js';

/**
 * The job half of the doorbell (spec/08 § Action — `notifyOnComplete`). A job's
 * fire is a `user` turn, so a job's chat reaches this notifier like any other
 * chat's; a job that does not want a push per fire says so on its action, and
 * this is how that is read back when the chat settles.
 *
 * Injected as ONE optional object rather than two optional functions: with the
 * halves separate, wiring the link resolver and forgetting the store would
 * silently gate nothing. Absent entirely — a caller with no jobs subsystem at
 * all — means no chat is job-linked and every chat behaves as it did before
 * this existed.
 */
export interface ChatCompletionJobGate {
  /** The job that created `chatId` (`jobs/chat-links.ts`), or null if none did. */
  jobIdForChat: (chatId: string) => string | null;
  /** The stored job, or null when there is no job by that id any more. */
  job: (jobId: string) => Job | null;
}

/**
 * spec/09 § Chat completion — a chat that is a member of the currently-running
 * batch (spec/14 § Batch mode) is skipped, for both completion and failure,
 * for as long as the batch runs. Optional only so the many existing tests
 * that construct a bare notifier don't all need one; app.ts always supplies
 * the real `BatchStore`.
 */
export interface ChatCompletionBatchGate {
  isSuppressedMember: (chatId: string) => boolean;
}

export interface ChatCompletionNotifierDeps {
  chats: ChatRegistry;
  router: NotificationRouter;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  jobs?: ChatCompletionJobGate;
  batch?: ChatCompletionBatchGate;
}

export class ChatCompletionNotifier {
  private readonly deps: ChatCompletionNotifierDeps;
  private readonly now: () => number;
  /** Last observed activity per chat, so a transition can be told from a repeat. */
  private readonly lastActivity = new Map<string, ChatSummary['activity']>();

  constructor(deps: ChatCompletionNotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Observe the chat stream and notify on each completed or failed turn. */
  observe(event: WireEvent): void {
    if (event.type !== 'chat.state') return;
    const chatId = event.chatId;
    const previous = this.lastActivity.get(chatId);
    this.lastActivity.set(chatId, event.activity);

    // spec/09 § A turn that failed — the edge INTO `errored`. `idle` counts as
    // a source because a pre-flight failure (folder gone, session missing)
    // errors a turn before it ever went `running`. `undefined` does not: that
    // is the first frame this process has seen for the chat, not a transition.
    if (event.activity === 'errored' && previous !== undefined && previous !== 'errored') {
      this.notifyFailed(event);
      return;
    }

    // Only the running → idle edge. A chat spawns idle, and a later `chat.state`
    // carrying the async-generated status summary is idle → idle; neither is a
    // completed turn.
    if (event.activity !== 'idle' || previous !== 'running') return;

    // spec/09 § Whose turn it was. A chat finishing is only news if the user is
    // waiting on it. A turn the host started for itself — a self-wake tick, a
    // todo auto-advance, another agent's `send_to` — is the machine talking to
    // itself, and a watcher on a five-minute loop would otherwise ring the
    // doorbell all day. Absent means `user`: a host predating the field never
    // sends one, and reading that as `user` keeps the behaviour it already had
    // instead of silencing it.
    if (event.turnOrigin === 'machine') return;

    // spec/09 § A turn the user stopped. A chat the user interrupted did not
    // finish, and saying it did is simply false — they pressed stop, so they
    // know where the chat got to and are not waiting on it.
    //
    // Read off THIS frame rather than from `chat.stopped`, which the host
    // emits from a different awaiter of the same aborted run: on a bare stop
    // that event lands AFTER this idle frame, so there is nothing to have
    // remembered yet, while on a stop with turns queued behind it the event
    // lands FIRST and the idle it precedes belongs to the promoted turn's real
    // completion, which must still notify. No order holds in both cases, so the
    // settling frame has to carry the fact itself.
    //
    // Absent means NOT stopped: a host predating the field never sends it, so
    // its chats keep announcing a stopped turn as finished rather than falling
    // silent on turns that really did complete.
    if (event.turnStopped === true) return;

    // The special threads each reach the user through their own channel already,
    // and the Manager's turn ending is caused by other chats finishing rather
    // than being news of its own.
    if (isReservedSpecialThread(chatId)) return;

    const chat = this.deps.chats.get(chatId);
    const status = event.status ?? chat?.status ?? 'active';
    if (status !== 'active') return;
    const snoozedUntil = event.snoozedUntil ?? chat?.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > this.now()) return;
    // A hidden chat is a background run (spec/04 § Hidden) — its turns ending
    // is the ordinary case, not news. It rings once it has come into the list.
    if (event.hidden ?? chat?.hidden ?? false) return;

    // spec/08 § Action — a job that has turned its doorbell off. Checked here,
    // and not on the wire: the turn a job fires is a `user` turn (spec/09 §
    // Whose turn it was — the job dispatched it on the user's behalf), so it
    // arrives at this notifier exactly like a composer turn and nothing the
    // host sends distinguishes it. The server is the only side that holds
    // both the chatId → jobId link and the job definition, so the server gates
    // it.
    if (this.suppressedByJob(chatId)) return;
    if (this.deps.batch?.isSuppressedMember(chatId)) return;

    const name = chat?.name ?? chat?.preview ?? 'unnamed chat';
    // spec/09 § What the message says. The trailing text is taken from the best
    // account of what this turn DID, in that order:
    //
    //   1. `event.turnSummary` — the agent's own closing words, cut to length by
    //      the host. Nothing else here was written by the thing that did the
    //      work, so nothing else outranks it.
    //   2. `chat.statusSummary` — a model's after-the-fact reading of the
    //      settled thread. Genuinely useful, but second-hand, and it is
    //      generated asynchronously AFTER the turn settles, so on this frame it
    //      is usually the PREVIOUS turn's line or nothing at all.
    //   3. nothing — `"<name> finished"` on its own.
    //
    // The chat's `preview` is deliberately not in that list at any level: it is
    // a snippet of the chat's FIRST message, so it describes what was asked for
    // once, long ago, and never what just happened. It still resolves the NAME
    // above, where being a durable label for the chat is exactly the job.
    //
    // `turnSummary` is read off THIS frame rather than the registry row for the
    // same reason `turnStopped` and `turnOrigin` are: the row is the fold of
    // every frame so far and carries the last turn's words until this one's
    // land, while the frame is the one thing that speaks for the turn that just
    // ended.
    //
    // Absent and `null` are read identically, and neither is a fallback: absent
    // is a host that does not send the field, `null` is a turn that ended on a
    // tool call with nothing said, and both mean "this frame offers no closing
    // text" — so the message reads exactly as it read before the field existed,
    // rather than having one invented for it.
    const summary = event.turnSummary ?? chat?.statusSummary;
    const message = `${name} finished${summary ? `: ${summary}` : ''}`;

    // Each channel is dispatched and failed independently: push throws by design
    // when no push backend is configured, and that must not take the desktop
    // toast down with it or reject out of an event handler.
    this.send('desktop', chatId, message);
    this.send('push', chatId, message);
  }

  /**
   * spec/09 § A turn that failed. Same audience as a completion — the user's
   * own turns, on chats they can see — because it is the same news: the thing
   * they were waiting on is not coming. What differs is that `errored` is not
   * always the end: a rung of the SDK retry ladder is armed on the same frame
   * (`turnRetrying`), and `daemon_unavailable` is the server's own stand-in for
   * a link that dropped, which the host resolves on reconnect. Neither is a
   * failure yet, so neither rings; the frame that ends the ladder does.
   */
  private notifyFailed(event: Extract<WireEvent, { type: 'chat.state' }>): void {
    const chatId = event.chatId;
    if (event.turnRetrying === true) return;
    if (isTransientChatError(event.lastError?.code)) return;
    if (event.turnOrigin === 'machine') return;
    if (event.turnStopped === true) return;
    if (isReservedSpecialThread(chatId)) return;

    const chat = this.deps.chats.get(chatId);
    // `errored` is itself a status some failures persist (session gone, mode
    // downgraded), so only the statuses that mean "not in the list" skip here.
    const status = event.status ?? chat?.status ?? 'active';
    if (status === 'archived' || status === 'deleted') return;
    const snoozedUntil = event.snoozedUntil ?? chat?.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > this.now()) return;
    if (event.hidden ?? chat?.hidden ?? false) return;
    if (this.suppressedByJob(chatId)) return;
    if (this.deps.batch?.isSuppressedMember(chatId)) return;

    const name = chat?.name ?? chat?.preview ?? 'unnamed chat';
    const reason = event.lastError?.message;
    const message = `${name} failed${reason ? `: ${oneLine(reason)}` : ''}`;
    this.send('desktop', chatId, message);
    this.send('push', chatId, message);
  }

  /**
   * True when this chat was created by a job whose action sets
   * `notifyOnComplete: false` (spec/08 § Action).
   *
   * Absent means NOTIFY — the field is default-on, so only an explicit `false`
   * suppresses. That is also what makes every job written before the field
   * existed keep the behaviour it already had.
   *
   * The gate follows the CHAT, not the turn: a turn the user types into a
   * suppressed job's chat is silent too. Deliberate — the flag names this job's
   * chats as not worth a doorbell, and nothing on the wire tells a fire's turn
   * apart from a person's in the same chat, so inferring one would be a guess.
   *
   * NO FALLBACK for a link whose job has gone: it NOTIFIES, and says so in the
   * log. The quiet state is the one a user has to have asked for, so an
   * unreadable job cannot be read as a request for silence — and a link
   * pointing at a deleted job is a bug worth seeing rather than swallowing.
   */
  private suppressedByJob(chatId: string): boolean {
    const gate = this.deps.jobs;
    if (!gate) return false;
    const jobId = gate.jobIdForChat(chatId);
    if (jobId === null) return false;
    const job = gate.job(jobId);
    if (job === null) {
      this.deps.logger.warn(
        { chatId, jobId },
        'chat-complete: chat is linked to a job that no longer exists — notifying',
      );
      return false;
    }
    // `message` and `script` actions carry no such field, so this reads as
    // `undefined` for them and notifies — which is right: a `message` action
    // delivers into a chat the user already owns, and a `script` action has no
    // chat to settle at all.
    return 'notifyOnComplete' in job.action && job.action.notifyOnComplete === false;
  }

  private send(channel: 'desktop' | 'push', chatId: string, message: string): void {
    void this.deps.router
      .route(
        { type: 'notify', chatId, channel, message },
        channel === 'push' ? { suppressOn: 'computer' } : { skipDesktopIfFocused: true },
      )
      .catch((err: unknown) => {
        this.deps.logger.warn(
          { chatId, channel, err: (err as Error).message },
          'chat-complete: notify failed',
        );
      });
  }
}

/** An error message cut to notification length on one line. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > FAILURE_REASON_MAX ? `${flat.slice(0, FAILURE_REASON_MAX - 1)}…` : flat;
}

const FAILURE_REASON_MAX = 200;
