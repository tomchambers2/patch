// Pure helper: resolve what a tapped notification should open.
//
// Spec/09 § `### push`: a push payload may carry a `deepLink` — an installed
// app's own URI (custom scheme or https) — which the tap opens instead of the
// source chat. Spec/15 § Push notifications states the condition on that: the
// link is only followed when the notification's own text NAMES where it goes.
// Both the text and the link come from the same `patch_notify` call, so a link
// the text never mentions is a notification about one thing that lands the user
// somewhere else. When the link is rejected the tap falls back to the honest
// destination — the source chat — and the rejection is returned so the caller
// can log it. It is never dropped quietly.
//
// `kind: 'call'` payloads are handled by the ConnectionService path, not by an
// in-app navigation, so they resolve to no action here.
//
// Kept as a standalone pure function so it is unit-testable without a React
// Native renderer (the root layout calls it from useLastNotificationResponse).

export interface NotificationData {
  [key: string]: unknown;
}

/** The notification as the user actually saw it. */
export interface NotificationText {
  title?: unknown;
  body?: unknown;
}

export type NotificationAction =
  | { type: 'chat'; route: string }
  | { type: 'external'; url: string }
  /** A batch check-in notification (spec/15 § Batch view, `09-notifications.md`
   *  § Batch check-in) — an ordinary push, but `kind: 'batch'` and no
   *  `chatId`. Tapping it lands on the Batch tab, never a chat. */
  | { type: 'batch' };

export type DeepLinkRejectionReason =
  /** The URI yielded no word distinctive enough to look for in the text. */
  | 'link-has-no-identifying-words'
  /** None of the link's words appear in the notification's title or body. */
  | 'link-not-named-in-notification-text';

export interface RejectedDeepLink {
  url: string;
  reason: DeepLinkRejectionReason;
  /** The words looked for, so a log line explains itself. */
  words: string[];
}

export interface NotificationResolution {
  /** What to open, or null when the notification should open nothing. */
  action: NotificationAction | null;
  /** Present only when a deep link was carried and refused. */
  rejectedDeepLink?: RejectedDeepLink;
}

// Words that appear in URIs without identifying anything: transport, common
// TLDs, and generic path furniture. Left out of the comparison so a link is
// never accepted because the text happened to contain "app" or "com".
const URI_NOISE = new Set([
  'http',
  'https',
  'www',
  'com',
  'net',
  'org',
  'gov',
  'edu',
  'int',
  'info',
  'biz',
  'app',
  'dev',
  'api',
  'html',
  'htm',
  'php',
  'aspx',
  'index',
  'utm',
  'ref',
  'url',
  'uri',
  'src',
  'amp',
]);

const MIN_WORD_LENGTH = 3;

/**
 * The words a URI offers as proof of where it goes — its scheme (when it is an
 * app's own), its host labels, and the words of its path and query. Split on
 * every non-letter and on camelCase boundaries, so `showTask` offers both
 * `show` and `task`; short and generic words are dropped.
 */
export function deepLinkWords(url: string): string[] {
  const spaced = url.replace(/([a-z])([A-Z])/g, '$1 $2');
  const words = spaced
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= MIN_WORD_LENGTH && !URI_NOISE.has(w));
  return [...new Set(words)];
}

/**
 * Whether a deep link corresponds to the notification the user read. True when
 * at least one of the link's identifying words occurs, case-insensitively, in
 * the notification's title or body.
 */
export function deepLinkMatchesText(url: string, text: NotificationText): boolean {
  const words = deepLinkWords(url);
  if (words.length === 0) return false;
  const haystack = [
    typeof text.title === 'string' ? text.title : '',
    typeof text.body === 'string' ? text.body : '',
  ]
    .join(' ')
    .toLowerCase();
  return words.some((w) => haystack.includes(w));
}

function chatAction(data: NotificationData): NotificationAction | null {
  const chatId = data['chatId'];
  if (typeof chatId !== 'string' || chatId.length === 0) return null;
  return { type: 'chat', route: `/chats/${chatId}` };
}

/**
 * Returns the action to take for a tapped notification — open an external deep
 * link that the notification's text names, otherwise navigate to the source
 * chat — plus the rejected link, when one was refused.
 */
export function resolveNotificationAction(
  data: NotificationData | undefined,
  text: NotificationText,
): NotificationResolution {
  if (!data) return { action: null };
  if (data['kind'] === 'call') return { action: null };
  // A batch check-in push carries no chatId and always means "open the Batch
  // tab" — there is no source chat to fall back to and no deepLink to consider.
  if (data['kind'] === 'batch') return { action: { type: 'batch' } };
  const deepLink = data['deepLink'];
  if (typeof deepLink === 'string' && deepLink.length > 0) {
    const words = deepLinkWords(deepLink);
    if (deepLinkMatchesText(deepLink, text)) {
      return { action: { type: 'external', url: deepLink } };
    }
    return {
      action: chatAction(data),
      rejectedDeepLink: {
        url: deepLink,
        reason:
          words.length === 0
            ? 'link-has-no-identifying-words'
            : 'link-not-named-in-notification-text',
        words,
      },
    };
  }
  return { action: chatAction(data) };
}
