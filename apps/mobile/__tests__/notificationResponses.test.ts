import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import * as Notifications from './stubs/expo-notifications';
import * as delivery from '../src/lib/notificationDelivery';
import {
  initNotificationCategories,
  registerDynamicCategoryIfNeeded,
  registerNotificationResponseListener,
  getPendingRetry,
} from '../src/lib/notificationResponses';

vi.mock('../src/lib/notificationDelivery', () => ({
  sendBackgroundChatInput: vi.fn(),
  sendBackgroundPermissionDecision: vi.fn(),
  sendBackgroundQuestionAnswer: vi.fn(),
}));

beforeEach(() => {
  __clearAllMmkv();
  Notifications.__clearScheduledNotifications();
  Notifications.__clearCategories();
  Notifications.__clearResponseListeners();
  Notifications.__clearDismissed();
  vi.clearAllMocks();
});

describe('initNotificationCategories', () => {
  it('registers the Reply and Approve/Deny categories', async () => {
    await initNotificationCategories();
    const reply = Notifications.__getCategory('patch_reply') as { actions: unknown[] };
    expect(reply.actions).toHaveLength(1);
    expect(reply.actions[0]).toMatchObject({ identifier: 'reply', buttonTitle: 'Reply' });

    const permission = Notifications.__getCategory('patch_permission') as { actions: unknown[] };
    expect(permission.actions).toEqual([
      { identifier: 'approve', buttonTitle: 'Approve', options: { opensAppToForeground: true } },
      { identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: false } },
    ]);
  });
});

describe('registerDynamicCategoryIfNeeded', () => {
  it('rebuilds patch_dynamic for quickReplies', async () => {
    await registerDynamicCategoryIfNeeded({ kind: 'message', quickReplies: ['Yes', 'No'] });
    const dyn = Notifications.__getCategory('patch_dynamic') as {
      actions: { buttonTitle: string }[];
    };
    expect(dyn.actions.map((a) => a.buttonTitle)).toEqual(['Yes', 'No', 'Reply']);
  });

  it('is a no-op for a plain message or permission (static categories cover them)', async () => {
    await registerDynamicCategoryIfNeeded(undefined);
    await registerDynamicCategoryIfNeeded({ kind: 'permission', requestId: 'r1' });
    expect(Notifications.__getCategory('patch_dynamic')).toBeUndefined();
  });
});

describe('registerNotificationResponseListener', () => {
  async function fireResponse(response: {
    actionIdentifier: string;
    userText?: string;
    notification: {
      request: {
        identifier: string;
        content: { title?: string; data?: Record<string, unknown> };
      };
    };
  }): Promise<void> {
    Notifications.__emitNotificationResponse(response);
    // handleResponse is async (fire-and-forget from the listener) — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('Reply on a plain message sends a chat reply and marks the notification Sent', async () => {
    vi.mocked(delivery.sendBackgroundChatInput).mockResolvedValue('sent');
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: 'reply',
      userText: 'on my way',
      notification: {
        request: {
          identifier: 'notif-1',
          content: { title: 'Patch', data: { chatId: 'c1' } },
        },
      },
    });

    expect(delivery.sendBackgroundChatInput).toHaveBeenCalledWith('c1', 'on my way');
    expect(Notifications.__getScheduledNotification('notif-1')).toMatchObject({
      content: { title: 'Patch', body: 'Sent' },
    });
  });

  it('a failed Reply keeps the notification up with the retry prompt and the text', async () => {
    vi.mocked(delivery.sendBackgroundChatInput).mockResolvedValue('failed');
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: 'reply',
      userText: 'on my way',
      notification: { request: { identifier: 'notif-2', content: { data: { chatId: 'c1' } } } },
    });

    expect(Notifications.__getScheduledNotification('notif-2')).toMatchObject({
      content: { body: 'Not sent — tap to retry' },
    });
    expect(getPendingRetry('notif-2')).toMatchObject({
      retryAs: 'reply',
      chatId: 'c1',
      text: 'on my way',
    });
  });

  it('tapping the body of a failed notification retries with the same text', async () => {
    vi.mocked(delivery.sendBackgroundChatInput)
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('sent');
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: 'reply',
      userText: 'on my way',
      notification: { request: { identifier: 'notif-3', content: { data: { chatId: 'c1' } } } },
    });
    expect(getPendingRetry('notif-3')).not.toBeNull();

    await fireResponse({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: { request: { identifier: 'notif-3', content: { data: { chatId: 'c1' } } } },
    });

    expect(delivery.sendBackgroundChatInput).toHaveBeenCalledTimes(2);
    expect(delivery.sendBackgroundChatInput).toHaveBeenLastCalledWith('c1', 'on my way');
    expect(getPendingRetry('notif-3')).toBeNull();
    expect(Notifications.__getScheduledNotification('notif-3')).toMatchObject({
      content: { body: 'Sent' },
    });
  });

  it('a body tap on an ordinary (non-failed) notification does nothing here', async () => {
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: { request: { identifier: 'notif-4', content: { data: { chatId: 'c1' } } } },
    });

    expect(delivery.sendBackgroundChatInput).not.toHaveBeenCalled();
    expect(delivery.sendBackgroundPermissionDecision).not.toHaveBeenCalled();
    expect(Notifications.__getScheduledNotification('notif-4')).toBeUndefined();
  });

  it('Approve dismisses the notification on success', async () => {
    vi.mocked(delivery.sendBackgroundPermissionDecision).mockResolvedValue('sent');
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: 'approve',
      notification: {
        request: {
          identifier: 'notif-5',
          content: {
            data: {
              chatId: 'c1',
              actions: JSON.stringify({ kind: 'permission', requestId: 'r1' }),
            },
          },
        },
      },
    });

    expect(delivery.sendBackgroundPermissionDecision).toHaveBeenCalledWith('c1', 'r1', 'approve');
    expect(Notifications.__getDismissed()).toContain('notif-5');
  });

  it('Deny that fails to deliver keeps the notification with a retry, and retrying resends deny', async () => {
    vi.mocked(delivery.sendBackgroundPermissionDecision)
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('sent');
    registerNotificationResponseListener();

    const content = {
      data: { chatId: 'c1', actions: JSON.stringify({ kind: 'permission', requestId: 'r1' }) },
    };
    await fireResponse({
      actionIdentifier: 'deny',
      notification: { request: { identifier: 'notif-6', content } },
    });
    expect(getPendingRetry('notif-6')).toMatchObject({ retryAs: 'permission', decision: 'deny' });

    await fireResponse({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: { request: { identifier: 'notif-6', content } },
    });
    expect(delivery.sendBackgroundPermissionDecision).toHaveBeenLastCalledWith('c1', 'r1', 'deny');
    expect(Notifications.__getDismissed()).toContain('notif-6');
    expect(getPendingRetry('notif-6')).toBeNull();
  });

  it('an option button answers the question and marks Sent', async () => {
    vi.mocked(delivery.sendBackgroundQuestionAnswer).mockResolvedValue('sent');
    registerNotificationResponseListener();

    const actions = {
      kind: 'question',
      requestId: 'r1',
      questionText: 'Which bed?',
      options: ['North', 'South'],
    };
    await fireResponse({
      actionIdentifier: 'option-1',
      notification: {
        request: {
          identifier: 'notif-7',
          content: { data: { chatId: 'c1', actions: JSON.stringify(actions) } },
        },
      },
    });

    expect(delivery.sendBackgroundQuestionAnswer).toHaveBeenCalledWith(
      'c1',
      'r1',
      'Which bed?',
      'South',
    );
    expect(Notifications.__getScheduledNotification('notif-7')).toMatchObject({
      content: { body: 'Sent' },
    });
  });

  it('a quickreply button sends its text as a reply', async () => {
    vi.mocked(delivery.sendBackgroundChatInput).mockResolvedValue('sent');
    registerNotificationResponseListener();

    const actions = { kind: 'message', quickReplies: ['Yes', 'Snooze 10 min'] };
    await fireResponse({
      actionIdentifier: 'quickreply-0',
      notification: {
        request: {
          identifier: 'notif-8',
          content: { data: { chatId: 'c1', actions: JSON.stringify(actions) } },
        },
      },
    });

    expect(delivery.sendBackgroundChatInput).toHaveBeenCalledWith('c1', 'Yes');
  });

  it('a failed question_answer retries as a question answer, not a plain reply', async () => {
    vi.mocked(delivery.sendBackgroundQuestionAnswer)
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('sent');
    registerNotificationResponseListener();

    const actions = {
      kind: 'question',
      requestId: 'r1',
      questionText: 'Which bed?',
      options: ['North'],
    };
    const content = { data: { chatId: 'c1', actions: JSON.stringify(actions) } };
    await fireResponse({
      actionIdentifier: 'option-0',
      notification: { request: { identifier: 'notif-9', content } },
    });
    expect(getPendingRetry('notif-9')).toMatchObject({ retryAs: 'question_answer' });

    await fireResponse({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: { request: { identifier: 'notif-9', content } },
    });
    expect(delivery.sendBackgroundQuestionAnswer).toHaveBeenLastCalledWith(
      'c1',
      'r1',
      'Which bed?',
      'North',
    );
    expect(delivery.sendBackgroundChatInput).not.toHaveBeenCalled();
    expect(getPendingRetry('notif-9')).toBeNull();
  });

  it('a corrupted on-disk retry map is read as empty rather than thrown', async () => {
    const { store } = await import('../src/lib/credential');
    store().set('patch.notificationRetry.v1', 'not json');
    expect(getPendingRetry('anything')).toBeNull();
  });

  it('a body tap with no pending retry at all is an ordinary open, not a retry', async () => {
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: { request: { identifier: 'never-seen', content: { data: { chatId: 'c1' } } } },
    });
    expect(delivery.sendBackgroundChatInput).not.toHaveBeenCalled();
  });

  it('an unrecognised action on a notification with no data at all is ignored, not a crash', async () => {
    registerNotificationResponseListener();

    await fireResponse({
      actionIdentifier: 'something-unknown',
      notification: { request: { identifier: 'notif-10', content: {} } },
    });
    expect(delivery.sendBackgroundChatInput).not.toHaveBeenCalled();
    expect(delivery.sendBackgroundPermissionDecision).not.toHaveBeenCalled();
    expect(delivery.sendBackgroundQuestionAnswer).not.toHaveBeenCalled();
    expect(Notifications.__getScheduledNotification('notif-10')).toBeUndefined();
  });
});
