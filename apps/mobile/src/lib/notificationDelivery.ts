// Background delivery for a notification action (spec/09 § Notification
// actions) — Reply / Approve / Deny / a question's option buttons, all
// answered from a tap that must not assume the app is foregrounded or that
// its normal WS singleton is connected.
//
// Mirrors `widgets/widgetActions.ts`'s own short-lived socket (same reason:
// a background tap has no guarantee of a live connection to reuse) rather
// than importing it — that module discovers its `requestId` via replay
// because a widget redraw never carried one; every notification here already
// has its `requestId` on the push's own `data`, so there is nothing to
// discover and the two call shapes diverge enough that sharing would mean a
// parameter neither caller needs. Same convention as `askUserQuestion.ts`'s
// comment: deliberately duplicated rather than shared.

import { loadCredential } from './credential';
import { mobileBuildInfo } from './buildInfo';
import { wsUrl } from '../config';

/** How long to wait for the host's ack before giving up. */
export const NOTIFICATION_DELIVERY_TIMEOUT_MS = 8_000;

export interface NotificationDeliveryOptions {
  createWebSocket?: (url: string) => WebSocket;
  timeoutMs?: number;
}

export type NotificationDeliveryResult = 'sent' | 'failed';

function buildHelloFrame(auth: string): Record<string, unknown> {
  const build = mobileBuildInfo();
  return {
    type: 'hello',
    clientType: 'surface-mobile',
    clientVersion: build.version,
    ...(build.gitSha ? { clientGitSha: build.gitSha } : {}),
    ...(build.builtAt ? { clientBuiltAt: build.builtAt } : {}),
    auth,
  };
}

/**
 * Opens one short-lived socket, sends `hello` then `frame`, waits for
 * `isAck` to recognise a reply, and closes. Shared plumbing for every
 * background-delivery function below; not exported — each caller's `frame`/
 * `isAck` shapes are different enough that a shared send-and-wait is all
 * that's worth factoring out of them.
 */
function sendAndAwaitAck(
  frame: Record<string, unknown>,
  isAck: (msg: Record<string, unknown>) => boolean,
  options: NotificationDeliveryOptions,
): Promise<NotificationDeliveryResult> {
  const cred = loadCredential();
  if (!cred) {
    throw new Error('notificationDelivery: this device is not linked yet');
  }
  const createWebSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
  const timeoutMs = options.timeoutMs ?? NOTIFICATION_DELIVERY_TIMEOUT_MS;
  const ws = createWebSocket(wsUrl());

  return new Promise<NotificationDeliveryResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle('failed'), timeoutMs);

    function close(): void {
      try {
        ws.close();
      } catch {
        // Already closed/closing — nothing left to do.
      }
    }

    function settle(result: NotificationDeliveryResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      resolve(result);
    }

    ws.onopen = (): void => {
      ws.send(JSON.stringify(buildHelloFrame(cred)));
      ws.send(JSON.stringify(frame));
    };
    ws.onmessage = (evt: { data: unknown }): void => {
      if (typeof evt.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      if (isAck(parsed as Record<string, unknown>)) settle('sent');
    };
    ws.onerror = (): void => settle('failed');
    ws.onclose = (): void => settle('failed');
  });
}

/** Reply text, sent as an ordinary `chat.input` (spec/12 § Guaranteed input delivery). */
export async function sendBackgroundChatInput(
  chatId: string,
  text: string,
  options: NotificationDeliveryOptions = {},
): Promise<NotificationDeliveryResult> {
  const localId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return sendAndAwaitAck(
    { type: 'chat.input', chatId, message: text, localId },
    (msg) =>
      (msg['type'] === 'chat.input_ack' || msg['type'] === 'chat.queued') &&
      msg['chatId'] === chatId &&
      msg['localId'] === localId,
    options,
  );
}

/**
 * Approve/Deny a pending tool-approval permission request. Carries `chatId`
 * so the server relays the response to the chat's OWNING host — without it a
 * response for a Mac-owned chat lands on Hetzner and is lost.
 */
export async function sendBackgroundPermissionDecision(
  chatId: string,
  requestId: string,
  decision: 'approve' | 'deny',
  options: NotificationDeliveryOptions = {},
): Promise<NotificationDeliveryResult> {
  return sendAndAwaitAck(
    {
      type: 'chat.permission_response',
      chatId,
      requestId,
      approve: decision === 'approve',
      decision,
    },
    (msg) => msg['type'] === 'chat.permission_response' && msg['requestId'] === requestId,
    options,
  );
}

/**
 * Answer an `AskUserQuestion` — an option button's label, or the Reply
 * fallback's typed text — via `approve_with_edits` (spec/03 § Answering with
 * content), same wire shape the in-app QuestionCard uses
 * (`app/widget-reply.tsx`).
 */
export async function sendBackgroundQuestionAnswer(
  chatId: string,
  requestId: string,
  questionText: string,
  answer: string,
  options: NotificationDeliveryOptions = {},
): Promise<NotificationDeliveryResult> {
  return sendAndAwaitAck(
    {
      type: 'chat.permission_response',
      chatId,
      requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [questionText]: answer }),
    },
    (msg) => msg['type'] === 'chat.permission_response' && msg['requestId'] === requestId,
    options,
  );
}
