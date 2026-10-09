// Blocked-on-the-user notifications (spec/09 § Waiting on you).
//
// The second notification Patch raises without an agent asking it to. Its
// sibling `chat-complete.ts` rings when a turn FINISHES; this one rings when a
// turn STOPS — the agent hit a permission decision or asked an
// `AskUserQuestion`, and the chat is parked in `awaiting-permission` until a
// human answers. That state never reaches `idle`, so chat-completion never
// fires for it: before this existed, an agent could sit waiting on Tom
// indefinitely while he was away from the machine and nothing told him.
//
// Both cases — a tool approval and a question — arrive as the same thing. The
// host's `requestPermission` routes `AskUserQuestion` through the very same
// `canUseTool` gate as any other tool (chatRunner.ts § `requestPermission`),
// so one activity edge covers both; dd6f113 treats them as one for the same
// reason when it unarchives a hidden job's chat.
//
// Delivery mirrors chat-completion exactly: desktop always, push only when no
// computer surface is active, both at normal priority. Being blocked is not a
// different urgency rung — it is the same doorbell for a different reason.

import type { Logger } from 'pino';
import type { NotifyActions, WireEvent } from '@patch/wire';
import { isReservedSpecialThread } from '@patch/wire';
import type { ChatRegistry } from '../chat-registry.js';
import type { NotificationRouter } from './router.js';

/** The agent's built-in question tool, which arrives as a permission request. */
const ASK_USER_QUESTION = 'AskUserQuestion';

export interface AwaitingPermissionNotifierDeps {
  chats: ChatRegistry;
  router: NotificationRouter;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
}

/** What the outstanding `chat.permission_request` was asking for. */
interface PendingAsk {
  tool: string;
  description?: string | undefined;
  args: unknown;
  requestId: string;
}

/**
 * The question text an `AskUserQuestion` is asking, or `null` when the args are
 * not the tool's documented shape.
 *
 * Deliberately NOT `packages/web`'s `parseAskUserQuestion`: that one is a
 * strict all-or-nothing validator because the question CARD must never render a
 * half-parsed question, and it lives in a package the server does not import.
 * A doorbell only needs the headline string, and reads exactly that.
 */
function questionText(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const raw = (args as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return null;
  const first = raw[0];
  if (typeof first !== 'object' || first === null) return null;
  const question = (first as { question?: unknown }).question;
  if (typeof question !== 'string' || question.length === 0) return null;
  return question;
}

/**
 * The option LABELS a question's args can offer as notification buttons
 * (spec/09 § Notification actions), or `null` when they can't be — a batch of
 * more than one question, a multi-select question, or more than 3 options
 * (Android's/iOS's practical action-button limit). `null` is not an error:
 * the surface falls back to its Reply text box, whose typed text becomes the
 * answer under the same `questionText` key.
 */
function questionOptions(args: unknown): string[] | null {
  if (typeof args !== 'object' || args === null) return null;
  const raw = (args as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length !== 1) return null;
  const only = raw[0];
  if (typeof only !== 'object' || only === null) return null;
  const { options, multiSelect } = only as Record<string, unknown>;
  if (multiSelect === true) return null;
  if (!Array.isArray(options) || options.length === 0 || options.length > 3) return null;
  const labels: string[] = [];
  for (const o of options) {
    if (typeof o !== 'object' || o === null) return null;
    const label = (o as { label?: unknown }).label;
    if (typeof label !== 'string' || label.length === 0) return null;
    labels.push(label);
  }
  return labels;
}

export class AwaitingPermissionNotifier {
  private readonly deps: AwaitingPermissionNotifierDeps;
  private readonly now: () => number;
  /** Last observed activity per chat, so a transition can be told from a repeat. */
  private readonly lastActivity = new Map<string, string>();
  /**
   * The `chat.permission_request` seen since this chat was last running, so the
   * notification can say WHAT is being asked.
   *
   * Correlating the two events is safe rather than fragile because the host
   * emits them adjacently and synchronously: `handlePermissionEnvelope` does
   * `emit(request)` → `setActivity('awaiting-permission')` → `emitState()` with
   * nothing in between, and `injectPermissionRequest` (the dev seam) does the
   * same. So the request is always already here when the edge arrives.
   */
  private readonly pendingAsk = new Map<string, PendingAsk>();

  constructor(deps: AwaitingPermissionNotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Observe the chat stream and notify each time a chat blocks on the user. */
  observe(event: WireEvent): void {
    if (event.type === 'chat.permission_request') {
      this.pendingAsk.set(event.chatId, {
        tool: event.request.tool,
        description: event.request.description,
        args: event.request.args,
        requestId: event.requestId,
      });
      return;
    }
    if (event.type !== 'chat.state') return;
    const chatId = event.chatId;
    const previous = this.lastActivity.get(chatId);
    this.lastActivity.set(chatId, event.activity);

    if (event.activity !== 'awaiting-permission') {
      // The turn is over (or moving again): anything still recorded describes a
      // request that has been answered or abandoned, and must not be used to
      // describe some later block.
      if (event.activity !== 'running') this.pendingAsk.delete(chatId);
      return;
    }

    // Only the running → awaiting-permission edge.
    //
    // Repeats are common and none of them is a new question: the run loop
    // re-asserts `awaiting-permission` when a mock turn's iterator returns with
    // a request still outstanding (chatRunner.ts, the `hasPendingPermission`
    // hold), and a reconnecting host replays held state. Requiring the
    // previous activity to be `running` also means a server restart that finds
    // a chat already parked does not re-ring a doorbell that already rang.
    //
    // A chat that bounces awaiting → running → awaiting notifies twice, which
    // is right: that is a second question inside one turn.
    if (previous !== 'running') return;

    // The special threads each reach the user through their own channel.
    if (isReservedSpecialThread(chatId)) return;

    const chat = this.deps.chats.get(chatId);
    // NOTE the ordering this depends on. dd6f113 makes a chat that reaches
    // `awaiting-permission` unarchive itself, and it does so BEFORE emitting
    // the state frame (`unarchiveForPermission` then `emitState`, and
    // `setArchived` does no awaiting) — so the frame that carries this edge
    // already says `active`, and this filter cannot swallow the very
    // notification that commit exists to make visible. If those two calls are
    // ever reordered, this filter starts eating hidden jobs' questions
    // silently.
    const status = event.status ?? chat?.status ?? 'active';
    if (status !== 'active') return;
    const snoozedUntil = event.snoozedUntil ?? chat?.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > this.now()) return;

    // `turnOrigin` is deliberately NOT consulted here, and that is not an
    // oversight to be tidied into consistency with chat-complete.ts.
    //
    // Chat-completion stays silent for a `machine` turn because nobody is
    // waiting on a self-wake tick finishing. That reasoning inverts for a
    // block: a machine-started run that stops to ask is precisely the run
    // nobody is watching, and it stays stopped until a human answers. Same
    // judgement dd6f113 makes when it drags a hidden job's chat out of
    // Archived the moment it needs the user.

    this.notify(chatId, chat?.name ?? chat?.preview ?? 'unnamed chat');
  }

  private notify(chatId: string, name: string): void {
    const ask = this.pendingAsk.get(chatId);
    this.pendingAsk.delete(chatId);
    const message = this.describe(chatId, name, ask);
    const actions = this.actionsFor(ask);

    // Each channel is dispatched and failed independently: push throws by
    // design when no push backend is configured, and that must not take the
    // desktop toast down with it or reject out of an event handler.
    this.send('desktop', chatId, message, actions);
    this.send('push', chatId, message, actions);
  }

  /**
   * spec/09 § Notification actions. `undefined` when there was no correlated
   * request at all (§ "a block with no correlated request still rings") —
   * nothing to approve/deny/answer, so the surface shows the baseline Reply
   * only.
   */
  private actionsFor(ask: PendingAsk | undefined): NotifyActions | undefined {
    if (!ask) return undefined;
    if (ask.tool === ASK_USER_QUESTION) {
      const text = questionText(ask.args);
      // Args too malformed to even name the question — nothing to key an
      // answer under, so no actions rather than a broken one.
      if (text === null) return undefined;
      const options = questionOptions(ask.args);
      return {
        kind: 'question',
        requestId: ask.requestId,
        questionText: text,
        ...(options ? { options } : {}),
      };
    }
    return { kind: 'permission', requestId: ask.requestId };
  }

  private describe(chatId: string, name: string, ask: PendingAsk | undefined): string {
    if (!ask) {
      // No correlated request. Nothing is inferred or invented — the user is
      // told the chat is blocked, which is true and actionable, and the miss is
      // logged because it means the host's emit order changed.
      this.deps.logger.warn(
        { chatId },
        'awaiting-permission with no preceding chat.permission_request',
      );
      return `${name} is waiting on you`;
    }
    if (ask.tool === ASK_USER_QUESTION) {
      const question = questionText(ask.args);
      if (question === null) {
        this.deps.logger.warn({ chatId }, 'AskUserQuestion args are not the documented shape');
        return `${name} has a question for you`;
      }
      return `${name} asks: ${question}`;
    }
    // An ordinary tool approval. `description` is the SDK's own one-line
    // account of the call ("Run: echo hi"); the tool name alone is the truth
    // when it is absent, not a degraded guess.
    return `${name} needs permission: ${ask.description ?? ask.tool}`;
  }

  private send(
    channel: 'desktop' | 'push',
    chatId: string,
    message: string,
    actions: NotifyActions | undefined,
  ): void {
    void this.deps.router
      .route(
        { type: 'notify', chatId, channel, message, ...(actions ? { actions } : {}) },
        channel === 'push' ? { suppressOn: 'computer' } : { skipDesktopIfFocused: true },
      )
      .catch((err: unknown) => {
        this.deps.logger.warn(
          { chatId, channel, err: (err as Error).message },
          'awaiting-permission: notify failed',
        );
      });
  }
}
