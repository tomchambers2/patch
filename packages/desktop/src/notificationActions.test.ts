import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotificationExtras,
  decideDesktopIntent,
  type NotifyActionsPayload,
} from './notificationActions';

test('buildNotificationExtras is a no-op on a non-macOS platform', () => {
  assert.deepEqual(buildNotificationExtras(undefined, 'win32'), {});
  assert.deepEqual(buildNotificationExtras({ kind: 'permission', requestId: 'r1' }, 'linux'), {});
});

test('a plain message (no actions) gets hasReply with no quickReply buttons', () => {
  assert.deepEqual(buildNotificationExtras(undefined, 'darwin'), {
    hasReply: true,
    replyPlaceholder: 'Reply…',
  });
});

test('a message with quickReplies adds them as buttons alongside Reply', () => {
  assert.deepEqual(
    buildNotificationExtras({ kind: 'message', quickReplies: ['Yes', 'Snooze 10 min'] }, 'darwin'),
    {
      hasReply: true,
      replyPlaceholder: 'Reply…',
      actions: [
        { type: 'button', text: 'Yes' },
        { type: 'button', text: 'Snooze 10 min' },
      ],
    },
  );
});

test('a permission gets Approve/Deny buttons, no reply field', () => {
  assert.deepEqual(buildNotificationExtras({ kind: 'permission', requestId: 'r1' }, 'darwin'), {
    actions: [
      { type: 'button', text: 'Approve' },
      { type: 'button', text: 'Deny' },
    ],
  });
});

test('a question with <=3 options renders them as buttons', () => {
  assert.deepEqual(
    buildNotificationExtras(
      { kind: 'question', requestId: 'r1', questionText: 'q', options: ['OAuth', 'JWT'] },
      'darwin',
    ),
    {
      actions: [
        { type: 'button', text: 'OAuth' },
        { type: 'button', text: 'JWT' },
      ],
    },
  );
});

test('a question with no representable options falls back to a reply field', () => {
  assert.deepEqual(
    buildNotificationExtras({ kind: 'question', requestId: 'r1', questionText: 'q' }, 'darwin'),
    { hasReply: true, replyPlaceholder: 'Type your answer…' },
  );
});

test('decideDesktopIntent: a plain reply on a message notification', () => {
  assert.deepEqual(decideDesktopIntent(undefined, { replyText: '  on my way  ' }), {
    kind: 'reply',
    text: 'on my way',
  });
});

test('decideDesktopIntent: empty/whitespace-only reply text is ignored', () => {
  assert.deepEqual(decideDesktopIntent(undefined, { replyText: '   ' }), { kind: 'ignore' });
});

test('decideDesktopIntent: a reply on a question notification answers the question', () => {
  const actions: NotifyActionsPayload = {
    kind: 'question',
    requestId: 'r1',
    questionText: 'Which bed?',
  };
  assert.deepEqual(decideDesktopIntent(actions, { replyText: 'The raised one' }), {
    kind: 'question_answer',
    requestId: 'r1',
    questionText: 'Which bed?',
    answer: 'The raised one',
  });
});

test('decideDesktopIntent: with no index and no reply, or no actions at all, is ignored', () => {
  assert.deepEqual(decideDesktopIntent({ kind: 'message' }, {}), { kind: 'ignore' });
  assert.deepEqual(decideDesktopIntent(undefined, { index: 0 }), { kind: 'ignore' });
});

test('decideDesktopIntent: a quickReply button index sends that text', () => {
  const actions: NotifyActionsPayload = { kind: 'message', quickReplies: ['Yes', 'Snooze 10 min'] };
  assert.deepEqual(decideDesktopIntent(actions, { index: 1 }), {
    kind: 'reply',
    text: 'Snooze 10 min',
  });
  assert.deepEqual(decideDesktopIntent(actions, { index: 5 }), { kind: 'ignore' });
});

test('decideDesktopIntent: permission button index 0/1 map to approve/deny', () => {
  const actions: NotifyActionsPayload = { kind: 'permission', requestId: 'r1' };
  assert.deepEqual(decideDesktopIntent(actions, { index: 0 }), {
    kind: 'permission',
    requestId: 'r1',
    decision: 'approve',
  });
  assert.deepEqual(decideDesktopIntent(actions, { index: 1 }), {
    kind: 'permission',
    requestId: 'r1',
    decision: 'deny',
  });
  assert.deepEqual(decideDesktopIntent(actions, { index: 2 }), { kind: 'ignore' });
});

test('decideDesktopIntent: permission with no requestId is ignored', () => {
  assert.deepEqual(decideDesktopIntent({ kind: 'permission' }, { index: 0 }), { kind: 'ignore' });
});

test('decideDesktopIntent: a question option button index answers with that label', () => {
  const actions: NotifyActionsPayload = {
    kind: 'question',
    requestId: 'r1',
    questionText: 'Auth method?',
    options: ['OAuth', 'JWT'],
  };
  assert.deepEqual(decideDesktopIntent(actions, { index: 1 }), {
    kind: 'question_answer',
    requestId: 'r1',
    questionText: 'Auth method?',
    answer: 'JWT',
  });
  assert.deepEqual(decideDesktopIntent(actions, { index: 5 }), { kind: 'ignore' });
});

test('decideDesktopIntent: a question missing requestId/questionText is ignored', () => {
  assert.deepEqual(decideDesktopIntent({ kind: 'question', options: ['A'] }, { index: 0 }), {
    kind: 'ignore',
  });
});
