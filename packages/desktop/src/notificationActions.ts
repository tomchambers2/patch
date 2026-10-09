// Notification actions on the desktop toast (spec/09 § Notification
// actions). Pure decision logic, kept Electron-free so it's unit-testable
// without booting a real Electron process (same reason `toastSound.ts` and
// `tray-toggle.ts` are separate modules — see main.test.ts's header comment).
//
// Mirrors apps/mobile/src/lib/notificationActions.ts's shape — deliberately
// duplicated rather than imported, both because `packages/desktop` doesn't
// depend on `@patch/wire` (preload.ts runs in a sandboxed renderer where only
// `electron` and a few Node builtins resolve — see preload.ts's own header
// comment) and because Electron's own action model is index-based
// (`Notification.on('action', (e, index) => ...)`), not the identifier
// strings `expo-notifications` gives Android — so the two platforms' plans
// aren't the same shape even though the underlying choice (Reply vs
// Approve/Deny vs option buttons vs quickReplies) is.
//
// macOS only, per spec/09: Electron's `actions`/`hasReply` notification
// fields are a macOS-only API (NSUserNotification-backed) with no Windows/
// Linux equivalent, and this app ships on macOS.

export interface NotifyActionsPayload {
  kind: 'message' | 'permission' | 'question';
  requestId?: string;
  questionText?: string;
  options?: string[];
  quickReplies?: string[];
}

/** What `new Notification(...)` should be constructed with for `actions`. */
export interface NotificationExtras {
  hasReply?: boolean;
  replyPlaceholder?: string;
  actions?: { type: 'button'; text: string }[];
}

/**
 * macOS-only (see module header). Every other platform gets the plain toast
 * it already had — Electron's `actions`/`hasReply` have no effect there, but
 * building them anyway would be presenting false affordances.
 */
export function buildNotificationExtras(
  actions: NotifyActionsPayload | undefined,
  platform: string,
): NotificationExtras {
  if (platform !== 'darwin') return {};
  if (!actions || actions.kind === 'message') {
    const quick = actions?.quickReplies ?? [];
    return {
      hasReply: true,
      replyPlaceholder: 'Reply…',
      ...(quick.length > 0
        ? { actions: quick.map((text) => ({ type: 'button' as const, text })) }
        : {}),
    };
  }
  if (actions.kind === 'permission') {
    return {
      actions: [
        { type: 'button', text: 'Approve' },
        { type: 'button', text: 'Deny' },
      ],
    };
  }
  // 'question'
  const options = actions.options;
  if (options && options.length > 0 && options.length <= 3) {
    return { actions: options.map((text) => ({ type: 'button' as const, text })) };
  }
  return { hasReply: true, replyPlaceholder: 'Type your answer…' };
}

export type DesktopNotificationIntent =
  | { kind: 'reply'; text: string }
  | { kind: 'permission'; requestId: string; decision: 'approve' | 'deny' }
  | { kind: 'question_answer'; requestId: string; questionText: string; answer: string }
  | { kind: 'ignore' };

/**
 * What a reply/action-button event on a shown notification means. `index` is
 * Electron's own action index (`Notification.on('action', (e, index) => …)`);
 * `replyText`, when present, means the user used the reply field instead.
 */
export function decideDesktopIntent(
  actions: NotifyActionsPayload | undefined,
  input: { index?: number; replyText?: string },
): DesktopNotificationIntent {
  if (input.replyText !== undefined) {
    const text = input.replyText.trim();
    if (text.length === 0) return { kind: 'ignore' };
    if (actions?.kind === 'question' && actions.requestId && actions.questionText) {
      return {
        kind: 'question_answer',
        requestId: actions.requestId,
        questionText: actions.questionText,
        answer: text,
      };
    }
    return { kind: 'reply', text };
  }

  const index = input.index;
  if (index === undefined || !actions) return { kind: 'ignore' };

  if (actions.kind === 'message') {
    const text = actions.quickReplies?.[index];
    return text === undefined ? { kind: 'ignore' } : { kind: 'reply', text };
  }

  if (actions.kind === 'permission') {
    if (!actions.requestId) return { kind: 'ignore' };
    if (index === 0)
      return { kind: 'permission', requestId: actions.requestId, decision: 'approve' };
    if (index === 1) return { kind: 'permission', requestId: actions.requestId, decision: 'deny' };
    return { kind: 'ignore' };
  }

  // 'question'
  if (!actions.requestId || !actions.questionText) return { kind: 'ignore' };
  const label = actions.options?.[index];
  if (label === undefined) return { kind: 'ignore' };
  return {
    kind: 'question_answer',
    requestId: actions.requestId,
    questionText: actions.questionText,
    answer: label,
  };
}
