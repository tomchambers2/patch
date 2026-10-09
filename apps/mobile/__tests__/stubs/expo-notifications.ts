// expo-notifications stub for unit tests. Only the surface push.ts /
// app/_layout.tsx touch is provided, with test hooks to drive each callback
// path (received notification, token rotation, notification-tap response).
export const AndroidImportance = { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 } as const;

export async function requestPermissionsAsync(): Promise<{ granted: boolean }> {
  return _permission;
}
let _permission = { granted: true };
export function __setPermission(p: { granted: boolean }): void {
  _permission = p;
}

let _handler: unknown = null;
export function setNotificationHandler(handler: unknown): void {
  _handler = handler;
}
export function __getNotificationHandler(): unknown {
  return _handler;
}

const _channels = new Map<string, unknown>();
export async function setNotificationChannelAsync(id: string, config: unknown): Promise<void> {
  _channels.set(id, config);
}
export async function deleteNotificationChannelAsync(id: string): Promise<void> {
  _channels.delete(id);
}
export function __getChannel(id: string): unknown {
  return _channels.get(id);
}

let _expoPushToken: { data: string } = { data: 'ExponentPushToken[test-token]' };
export function __setExpoPushToken(t: { data: string }): void {
  _expoPushToken = t;
}
export async function getExpoPushTokenAsync(_opts?: {
  projectId?: string;
}): Promise<{ data: string }> {
  return _expoPushToken;
}

const _receivedListeners = new Set<(n: unknown) => void>();
export function addNotificationReceivedListener(cb: (n: unknown) => void): { remove(): void } {
  _receivedListeners.add(cb);
  return {
    remove(): void {
      _receivedListeners.delete(cb);
    },
  };
}
export function __emitNotificationReceived(n: unknown): void {
  for (const cb of _receivedListeners) cb(n);
}

const _tokenListeners = new Set<(t: { data: string }) => void>();
export function addPushTokenListener(cb: (t: { data: string }) => void): { remove(): void } {
  _tokenListeners.add(cb);
  return {
    remove(): void {
      _tokenListeners.delete(cb);
    },
  };
}
export function __emitPushToken(t: { data: string }): void {
  for (const cb of _tokenListeners) cb(t);
}

let _lastResponse: unknown = null;
export function __setLastNotificationResponse(r: unknown): void {
  _lastResponse = r;
}
export function useLastNotificationResponse(): unknown {
  return _lastResponse;
}

export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

// Notification categories (spec/09 § Notification actions) — Reply /
// Approve-Deny / question-option / quickReply buttons.
const _categories = new Map<string, unknown>();
export async function setNotificationCategoryAsync(
  identifier: string,
  actions: unknown,
  options?: unknown,
): Promise<unknown> {
  const category = { identifier, actions, options };
  _categories.set(identifier, category);
  return category;
}
export async function deleteNotificationCategoryAsync(identifier: string): Promise<boolean> {
  return _categories.delete(identifier);
}
export function __getCategory(identifier: string): unknown {
  return _categories.get(identifier);
}
export function __clearCategories(): void {
  _categories.clear();
}

const _responseListeners = new Set<(r: unknown) => void>();
export function addNotificationResponseReceivedListener(cb: (r: unknown) => void): {
  remove(): void;
} {
  _responseListeners.add(cb);
  return {
    remove(): void {
      _responseListeners.delete(cb);
    },
  };
}
export function __emitNotificationResponse(r: unknown): void {
  for (const cb of _responseListeners) cb(r);
}
export function __clearResponseListeners(): void {
  _responseListeners.clear();
}

const _dismissed: string[] = [];
export async function dismissNotificationAsync(identifier: string): Promise<void> {
  _dismissed.push(identifier);
}
export function __getDismissed(): string[] {
  return _dismissed;
}
export function __clearDismissed(): void {
  _dismissed.length = 0;
}

// Local notifications (batchNotifier.ts — spec/15 § Batch view; and
// notificationActions.ts, which reschedules with the SAME `identifier` to
// replace a notification in place — e.g. "Sent" / "Not sent — tap to
// retry"). Only what those modules touch: scheduling one (immediately,
// `trigger: null`), a test hook to inspect what was scheduled, and
// identifier-keyed replacement matching Expo's real behaviour.
interface ScheduledNotification {
  identifier: string;
  content: { title?: string; body?: string; data?: unknown; categoryIdentifier?: string };
}
const _scheduled: ScheduledNotification[] = [];
let _scheduledCounter = 0;
export async function scheduleNotificationAsync(request: {
  identifier?: string;
  content: { title?: string; body?: string; data?: unknown; categoryIdentifier?: string };
  trigger: unknown;
}): Promise<string> {
  const identifier = request.identifier ?? `local-notif-${++_scheduledCounter}`;
  const existingIdx = _scheduled.findIndex((n) => n.identifier === identifier);
  const entry: ScheduledNotification = { identifier, content: request.content };
  if (existingIdx >= 0) _scheduled[existingIdx] = entry;
  else _scheduled.push(entry);
  return identifier;
}
export function __getScheduledNotifications(): ScheduledNotification[] {
  return _scheduled;
}
export function __getScheduledNotification(identifier: string): ScheduledNotification | undefined {
  return _scheduled.find((n) => n.identifier === identifier);
}
export function __clearScheduledNotifications(): void {
  _scheduled.length = 0;
  _scheduledCounter = 0;
}

// Notifications currently in the shade (getPresentedNotificationsAsync).
interface PresentedNotification {
  request: { identifier: string; content: { data?: Record<string, unknown> } };
}
let _presented: PresentedNotification[] = [];
export async function getPresentedNotificationsAsync(): Promise<PresentedNotification[]> {
  return _presented.filter((n) => !_dismissed.includes(n.request.identifier));
}
export function __setPresented(list: PresentedNotification[]): void {
  _presented = list;
}
