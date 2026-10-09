// Notification actions (spec/09 § Notification actions) — pure planning and
// response-decoding logic, kept native-free so it is unit-testable without a
// device. push.ts/notificationResponses.ts drive expo-notifications itself;
// this module only decides WHAT to show and WHAT a tap means.
//
// Two notification categories are pre-registered once, at `initPush()` time,
// so they are ready even if the app only just woke up to handle a backgrounded
// push (no race against this module registering them just-in-time):
//
//   - 'patch_reply'      — a single Reply (text input) action. Covers a plain
//     chat notification AND an AskUserQuestion that can't be answered by
//     button (a multi-question batch, >3 options, or multi-select) — same
//     action either way, so one static category serves both.
//   - 'patch_permission' — Approve (opens the app, which is what makes
//     Android require the device to be unlocked for it) + Deny (does not).
//
// A category whose button LABELS are themselves dynamic — a question's own
// option text, or patch_notify's quickReplies — cannot be pre-registered,
// since the text isn't known until the notification arrives. Those use the
// single 'patch_dynamic' identifier, rebuilt fresh each time right before the
// notification is (re)presented. This is honest about its one limitation,
// documented in spec/09: if the OS renders the remote push before this app's
// JS gets to rebuild the category (most likely with the app fully killed
// rather than merely backgrounded), that one notification shows with no
// action buttons — tapping it still opens the chat, same as today.

/** Mirrors the wire's `NotifyActions` (packages/wire/src/events.ts). */
export interface NotifyActionsPayload {
  kind: 'message' | 'permission' | 'question';
  requestId?: string;
  questionText?: string;
  options?: string[];
  quickReplies?: string[];
}

export const REPLY_ACTION = 'reply';
export const APPROVE_ACTION = 'approve';
export const DENY_ACTION = 'deny';
export const optionAction = (i: number): string => `option-${i}`;
export const quickReplyAction = (i: number): string => `quickreply-${i}`;

export const REPLY_CATEGORY = 'patch_reply';
export const PERMISSION_CATEGORY = 'patch_permission';
export const DYNAMIC_CATEGORY = 'patch_dynamic';

export interface PlannedAction {
  identifier: string;
  buttonTitle: string;
  /** Android: whether tapping this action unlocks/opens the app first. */
  opensAppToForeground: boolean;
  textInput?: { submitButtonTitle: string; placeholder: string };
}

const REPLY: PlannedAction = {
  identifier: REPLY_ACTION,
  buttonTitle: 'Reply',
  opensAppToForeground: false,
  textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
};

/**
 * The buttons a notification carrying `actions` should show. Absent
 * `actions` (an older host, or a plain chat-completion/failed doorbell with
 * nothing to approve) is the baseline: Reply alone.
 */
export function planActions(actions: NotifyActionsPayload | undefined): PlannedAction[] {
  if (!actions || actions.kind === 'message') {
    const quick = actions?.quickReplies ?? [];
    return [
      ...quick.map(
        (text, i): PlannedAction => ({
          identifier: quickReplyAction(i),
          buttonTitle: text,
          opensAppToForeground: false,
        }),
      ),
      REPLY,
    ];
  }
  if (actions.kind === 'permission') {
    return [
      { identifier: APPROVE_ACTION, buttonTitle: 'Approve', opensAppToForeground: true },
      { identifier: DENY_ACTION, buttonTitle: 'Deny', opensAppToForeground: false },
    ];
  }
  // 'question'
  const options = actions.options;
  if (options && options.length > 0 && options.length <= 3) {
    return options.map(
      (label, i): PlannedAction => ({
        identifier: optionAction(i),
        buttonTitle: label,
        opensAppToForeground: false,
      }),
    );
  }
  return [REPLY];
}

/** Which pre-registered category a notification's actions should render under. */
export function categoryIdentifierFor(actions: NotifyActionsPayload | undefined): string {
  if (!actions || actions.kind === 'message') {
    return (actions?.quickReplies?.length ?? 0) > 0 ? DYNAMIC_CATEGORY : REPLY_CATEGORY;
  }
  if (actions.kind === 'permission') return PERMISSION_CATEGORY;
  const options = actions.options;
  return options && options.length > 0 && options.length <= 3 ? DYNAMIC_CATEGORY : REPLY_CATEGORY;
}

/** Whether this notification needs the dynamic category rebuilt before it shows. */
export function needsDynamicCategory(actions: NotifyActionsPayload | undefined): boolean {
  return categoryIdentifierFor(actions) === DYNAMIC_CATEGORY;
}

/**
 * `data.actions` arrives over the wire as a JSON string (Expo/FCM data values
 * are strings only — `packages/server/src/notifications/router.ts`). `null`
 * for anything absent or malformed: NO FALLBACK, a notification just shows
 * the baseline Reply rather than guessing at broken data.
 */
export function parseActionsPayload(raw: unknown): NotifyActionsPayload | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind !== 'message' && kind !== 'permission' && kind !== 'question') return undefined;
    return parsed as NotifyActionsPayload;
  } catch {
    return undefined;
  }
}

/** What answering a question with `answer` sends back (spec/03 § Answering with content). */
export function questionAnswerMap(questionText: string, answer: string): Record<string, string> {
  return { [questionText]: answer };
}

export type ResponseIntent =
  | { kind: 'reply'; chatId: string; text: string }
  | { kind: 'permission'; chatId: string; requestId: string; decision: 'approve' | 'deny' }
  | {
      kind: 'question_answer';
      chatId: string;
      requestId: string;
      questionText: string;
      answer: string;
    }
  | { kind: 'retry' }
  | { kind: 'open' }
  | { kind: 'ignore' };

export interface NotificationResponseInput {
  /** `Notifications.DEFAULT_ACTION_IDENTIFIER` when the user tapped the body. */
  actionIdentifier: string;
  /** Present only for the Reply / question-fallback-Reply text-input action. */
  userText?: string;
  chatId: string;
  actions?: NotifyActionsPayload;
  /** True when this notification is showing "Not sent — tap to retry". */
  failedRetry?: boolean;
}

/** `Notifications.DEFAULT_ACTION_IDENTIFIER`, duplicated so this module stays native-free. */
export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

/**
 * What a tap on a notification (body or action button) means to do, decoded
 * from the response + the `actions` context carried on that notification's
 * `data`. Pure so the whole decision tree is unit-testable without a device.
 */
export function decideResponseIntent(input: NotificationResponseInput): ResponseIntent {
  const { actionIdentifier, userText, chatId, actions } = input;

  if (actionIdentifier === DEFAULT_ACTION_IDENTIFIER) {
    // A tap on the body of a notification that failed to deliver retries
    // instead of deep-linking (spec/09 § Notification actions) — the typed
    // text is kept by the caller (notificationResponses.ts), not here.
    return input.failedRetry ? { kind: 'retry' } : { kind: 'open' };
  }

  if (actionIdentifier === REPLY_ACTION) {
    if (!userText || userText.trim().length === 0) return { kind: 'ignore' };
    if (actions?.kind === 'question' && actions.requestId && actions.questionText) {
      return {
        kind: 'question_answer',
        chatId,
        requestId: actions.requestId,
        questionText: actions.questionText,
        answer: userText.trim(),
      };
    }
    return { kind: 'reply', chatId, text: userText.trim() };
  }

  if (actionIdentifier === APPROVE_ACTION || actionIdentifier === DENY_ACTION) {
    if (!actions?.requestId) return { kind: 'ignore' };
    return {
      kind: 'permission',
      chatId,
      requestId: actions.requestId,
      decision: actionIdentifier === APPROVE_ACTION ? 'approve' : 'deny',
    };
  }

  if (actionIdentifier.startsWith('option-')) {
    if (actions?.kind !== 'question' || !actions.requestId || !actions.questionText) {
      return { kind: 'ignore' };
    }
    const index = Number(actionIdentifier.slice('option-'.length));
    const label = actions.options?.[index];
    if (label === undefined) return { kind: 'ignore' };
    return {
      kind: 'question_answer',
      chatId,
      requestId: actions.requestId,
      questionText: actions.questionText,
      answer: label,
    };
  }

  if (actionIdentifier.startsWith('quickreply-')) {
    const index = Number(actionIdentifier.slice('quickreply-'.length));
    const text = actions?.quickReplies?.[index];
    if (text === undefined) return { kind: 'ignore' };
    return { kind: 'reply', chatId, text };
  }

  return { kind: 'ignore' };
}
