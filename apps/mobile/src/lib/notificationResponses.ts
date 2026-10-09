// Wires expo-notifications to the pure decision logic in
// `notificationActions.ts` / the background sends in `notificationDelivery.ts`
// (spec/09 § Notification actions). Three jobs:
//
//   1. Register the two STATIC categories once, at boot (`initCategories`):
//      Reply, and Approve/Deny. Pre-registering them means they are ready
//      even for a notification the OS shows while this app's JS is only just
//      waking up to a backgrounded push — nothing here has to win a race for
//      the common cases.
//   2. Rebuild the DYNAMIC category just-in-time, whenever a push arrives
//      carrying option/quickReply button text (`onNotificationReceived`) —
//      this one DOES race the OS's own display of that same push; see the
//      module doc in `notificationActions.ts`.
//   3. Handle a response (`registerResponseListener`): run the tapped
//      action through `decideResponseIntent`, send it in the background, and
//      update the notification to "Sent" or "Not sent — tap to retry" —
//      keeping the typed text either way, so nothing is silently lost.
//
// A body tap that ISN'T retrying a failed send is deliberately left alone —
// `notificationLink.ts` (driven by `useLastNotificationResponse()` at the UI
// layer) already owns that deep-link/open-chat behaviour, and this listener
// must not duplicate or race it.

import * as Notifications from 'expo-notifications';
import { store } from './credential';
import {
  planActions,
  needsDynamicCategory,
  parseActionsPayload,
  decideResponseIntent,
  REPLY_CATEGORY,
  PERMISSION_CATEGORY,
  DYNAMIC_CATEGORY,
  type NotifyActionsPayload,
  type PlannedAction,
} from './notificationActions';
import {
  sendBackgroundChatInput,
  sendBackgroundPermissionDecision,
  sendBackgroundQuestionAnswer,
  type NotificationDeliveryResult,
} from './notificationDelivery';

const RETRY_STORE_KEY = 'patch.notificationRetry.v1';

/** What a failed send needs to retry later, keyed by notification identifier. */
interface PendingRetry {
  retryAs: 'reply' | 'permission' | 'question_answer';
  chatId: string;
  /** The text shown back to the user: the reply/quickReply text, the chosen
   *  option label, or the approve/deny decision word. */
  text: string;
  requestId?: string;
  questionText?: string;
  decision?: 'approve' | 'deny';
  /** The notification's own title, carried through so a retried update keeps it. */
  title?: string;
}

function loadRetryMap(): Record<string, PendingRetry> {
  const raw = store().getString(RETRY_STORE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, PendingRetry>;
  } catch {
    return {};
  }
}
function saveRetryMap(map: Record<string, PendingRetry>): void {
  store().set(RETRY_STORE_KEY, JSON.stringify(map));
}
/** Exported for notification-list / badge code that wants to show "not sent" state. */
export function getPendingRetry(identifier: string): PendingRetry | null {
  return loadRetryMap()[identifier] ?? null;
}
function setPendingRetry(identifier: string, retry: PendingRetry): void {
  const map = loadRetryMap();
  map[identifier] = retry;
  saveRetryMap(map);
}
function clearPendingRetry(identifier: string): void {
  const map = loadRetryMap();
  delete map[identifier];
  saveRetryMap(map);
}

function toNativeActions(plan: PlannedAction[]): Notifications.NotificationAction[] {
  return plan.map((a) => ({
    identifier: a.identifier,
    buttonTitle: a.buttonTitle,
    ...(a.textInput ? { textInput: a.textInput } : {}),
    options: { opensAppToForeground: a.opensAppToForeground },
  }));
}

/** Registers the two fixed categories. Call once from `initPush()`. */
export async function initNotificationCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(
    REPLY_CATEGORY,
    toNativeActions(planActions(undefined)),
  );
  await Notifications.setNotificationCategoryAsync(
    PERMISSION_CATEGORY,
    toNativeActions(planActions({ kind: 'permission' })),
  );
}

/**
 * Rebuilds the dynamic category for THIS notification's own option/quickReply
 * text, if it needs one. A no-op for the common message/permission case,
 * which always resolves to one of the two static categories above.
 */
export async function registerDynamicCategoryIfNeeded(
  actions: NotifyActionsPayload | undefined,
): Promise<void> {
  if (!needsDynamicCategory(actions)) return;
  await Notifications.setNotificationCategoryAsync(
    DYNAMIC_CATEGORY,
    toNativeActions(planActions(actions)),
  );
}

/** The shape `addNotificationResponseReceivedListener` hands the callback. */
export interface NotificationResponseLike {
  actionIdentifier: string;
  userText?: string;
  notification: {
    request: {
      identifier: string;
      content: { title?: string | null; data?: Record<string, unknown> | null };
    };
  };
}

async function performSend(
  retryAs: PendingRetry['retryAs'],
  chatId: string,
  text: string,
  requestId: string | undefined,
  questionText: string | undefined,
  decision: 'approve' | 'deny' | undefined,
): Promise<NotificationDeliveryResult> {
  if (retryAs === 'reply') return sendBackgroundChatInput(chatId, text);
  if (retryAs === 'permission')
    return sendBackgroundPermissionDecision(chatId, requestId!, decision!);
  return sendBackgroundQuestionAnswer(chatId, requestId!, questionText!, text);
}

async function settle(
  identifier: string,
  result: NotificationDeliveryResult,
  retry: PendingRetry,
): Promise<void> {
  if (result === 'sent') {
    clearPendingRetry(identifier);
    if (retry.retryAs === 'permission') {
      await Notifications.dismissNotificationAsync(identifier);
      return;
    }
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: { title: retry.title, body: 'Sent' },
      trigger: null,
    });
    return;
  }
  // Not delivered — keep the notification up, keep the text, and remember how
  // to retry it (spec/09 § Notification actions: "never silently lost").
  setPendingRetry(identifier, retry);
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: { title: retry.title, body: 'Not sent — tap to retry' },
    trigger: null,
  });
}

async function handleResponse(response: NotificationResponseLike): Promise<void> {
  const identifier = response.notification.request.identifier;
  const title = response.notification.request.content.title ?? undefined;
  const data = response.notification.request.content.data ?? {};
  const chatId = typeof data['chatId'] === 'string' ? (data['chatId'] as string) : undefined;
  const actions = parseActionsPayload(data['actions']);
  const pendingRetry = getPendingRetry(identifier);

  const intent = decideResponseIntent({
    actionIdentifier: response.actionIdentifier,
    userText: response.userText,
    chatId: chatId ?? '',
    actions,
    failedRetry: pendingRetry !== null,
  });

  if (intent.kind === 'open' || intent.kind === 'ignore') return;

  if (intent.kind === 'retry') {
    // decideResponseIntent only ever returns 'retry' when `failedRetry` was
    // true above, i.e. exactly when `pendingRetry` is non-null — so this is
    // not a second, independently-reachable empty case.
    const retry = pendingRetry as PendingRetry;
    const result = await performSend(
      retry.retryAs,
      retry.chatId,
      retry.text,
      retry.requestId,
      retry.questionText,
      retry.decision,
    );
    await settle(identifier, result, retry);
    return;
  }

  if (intent.kind === 'reply') {
    const result = await sendBackgroundChatInput(intent.chatId, intent.text);
    await settle(identifier, result, {
      retryAs: 'reply',
      chatId: intent.chatId,
      text: intent.text,
      title,
    });
    return;
  }

  if (intent.kind === 'permission') {
    const result = await sendBackgroundPermissionDecision(
      intent.chatId,
      intent.requestId,
      intent.decision,
    );
    await settle(identifier, result, {
      retryAs: 'permission',
      chatId: intent.chatId,
      text: intent.decision,
      requestId: intent.requestId,
      decision: intent.decision,
      title,
    });
    return;
  }

  // 'question_answer'
  const result = await sendBackgroundQuestionAnswer(
    intent.chatId,
    intent.requestId,
    intent.questionText,
    intent.answer,
  );
  await settle(identifier, result, {
    retryAs: 'question_answer',
    chatId: intent.chatId,
    text: intent.answer,
    requestId: intent.requestId,
    questionText: intent.questionText,
    title,
  });
}

/** Subscribes to every notification action/tap. Call once from `initPush()`. */
export function registerNotificationResponseListener(): { remove(): void } {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    void handleResponse(response as unknown as NotificationResponseLike);
  });
}
