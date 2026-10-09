import { describe, it, expect } from 'vitest';
import {
  planActions,
  categoryIdentifierFor,
  needsDynamicCategory,
  parseActionsPayload,
  questionAnswerMap,
  decideResponseIntent,
  REPLY_CATEGORY,
  PERMISSION_CATEGORY,
  DYNAMIC_CATEGORY,
  DEFAULT_ACTION_IDENTIFIER,
  type NotifyActionsPayload,
} from '../src/lib/notificationActions';

describe('planActions', () => {
  it('a plain message (no actions) is Reply only', () => {
    expect(planActions(undefined)).toEqual([
      {
        identifier: 'reply',
        buttonTitle: 'Reply',
        opensAppToForeground: false,
        textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
      },
    ]);
  });

  it('a message with quickReplies puts them ahead of Reply', () => {
    const plan = planActions({ kind: 'message', quickReplies: ['Yes', 'Snooze 10 min'] });
    expect(plan.map((a) => a.identifier)).toEqual(['quickreply-0', 'quickreply-1', 'reply']);
    expect(plan[0]).toMatchObject({ buttonTitle: 'Yes', opensAppToForeground: false });
    expect(plan[1]).toMatchObject({ buttonTitle: 'Snooze 10 min', opensAppToForeground: false });
  });

  it('a permission carries Approve (opens app) and Deny (does not)', () => {
    expect(planActions({ kind: 'permission', requestId: 'r1' })).toEqual([
      { identifier: 'approve', buttonTitle: 'Approve', opensAppToForeground: true },
      { identifier: 'deny', buttonTitle: 'Deny', opensAppToForeground: false },
    ]);
  });

  it('a question with <=3 options renders them as buttons', () => {
    const plan = planActions({
      kind: 'question',
      requestId: 'r1',
      questionText: 'q',
      options: ['OAuth', 'JWT'],
    });
    expect(plan).toEqual([
      { identifier: 'option-0', buttonTitle: 'OAuth', opensAppToForeground: false },
      { identifier: 'option-1', buttonTitle: 'JWT', opensAppToForeground: false },
    ]);
  });

  it('a question with no representable options falls back to Reply', () => {
    const plan = planActions({ kind: 'question', requestId: 'r1', questionText: 'q' });
    expect(plan.map((a) => a.identifier)).toEqual(['reply']);
  });
});

describe('categoryIdentifierFor / needsDynamicCategory', () => {
  it('a plain message uses the static reply category', () => {
    expect(categoryIdentifierFor(undefined)).toBe(REPLY_CATEGORY);
    expect(needsDynamicCategory(undefined)).toBe(false);
  });

  it('quickReplies need the dynamic category', () => {
    expect(categoryIdentifierFor({ kind: 'message', quickReplies: ['Yes'] })).toBe(
      DYNAMIC_CATEGORY,
    );
    expect(needsDynamicCategory({ kind: 'message', quickReplies: ['Yes'] })).toBe(true);
  });

  it('a permission uses the static permission category', () => {
    expect(categoryIdentifierFor({ kind: 'permission', requestId: 'r1' })).toBe(
      PERMISSION_CATEGORY,
    );
  });

  it('a question with options needs the dynamic category; without, the static reply one', () => {
    expect(
      categoryIdentifierFor({
        kind: 'question',
        requestId: 'r1',
        questionText: 'q',
        options: ['A'],
      }),
    ).toBe(DYNAMIC_CATEGORY);
    expect(categoryIdentifierFor({ kind: 'question', requestId: 'r1', questionText: 'q' })).toBe(
      REPLY_CATEGORY,
    );
  });
});

describe('parseActionsPayload', () => {
  it('parses a valid JSON-encoded actions object', () => {
    const raw = JSON.stringify({ kind: 'permission', requestId: 'r1' });
    expect(parseActionsPayload(raw)).toEqual({ kind: 'permission', requestId: 'r1' });
  });

  it('returns undefined for missing/empty/non-string/malformed/unknown-kind input', () => {
    expect(parseActionsPayload(undefined)).toBeUndefined();
    expect(parseActionsPayload('')).toBeUndefined();
    expect(parseActionsPayload(42)).toBeUndefined();
    expect(parseActionsPayload('not json')).toBeUndefined();
    expect(parseActionsPayload('null')).toBeUndefined();
    expect(parseActionsPayload(JSON.stringify({ kind: 'bogus' }))).toBeUndefined();
  });
});

describe('questionAnswerMap', () => {
  it('keys the answer under the question text', () => {
    expect(questionAnswerMap('Which bed?', 'North')).toEqual({ 'Which bed?': 'North' });
  });
});

describe('decideResponseIntent', () => {
  it('a body tap on an ordinary notification opens the chat', () => {
    expect(
      decideResponseIntent({ actionIdentifier: DEFAULT_ACTION_IDENTIFIER, chatId: 'c1' }),
    ).toEqual({ kind: 'open' });
  });

  it('a body tap on a failed/undelivered notification retries instead', () => {
    expect(
      decideResponseIntent({
        actionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        chatId: 'c1',
        failedRetry: true,
      }),
    ).toEqual({ kind: 'retry' });
  });

  it('Reply with text on a plain message sends a chat reply', () => {
    expect(
      decideResponseIntent({ actionIdentifier: 'reply', userText: ' hello ', chatId: 'c1' }),
    ).toEqual({ kind: 'reply', chatId: 'c1', text: 'hello' });
  });

  it('Reply with empty/whitespace-only text is ignored', () => {
    expect(
      decideResponseIntent({ actionIdentifier: 'reply', userText: '   ', chatId: 'c1' }),
    ).toEqual({
      kind: 'ignore',
    });
    expect(decideResponseIntent({ actionIdentifier: 'reply', chatId: 'c1' })).toEqual({
      kind: 'ignore',
    });
  });

  it('Reply on a question notification answers the question instead of sending a chat message', () => {
    const actions: NotifyActionsPayload = {
      kind: 'question',
      requestId: 'r1',
      questionText: 'Which bed?',
    };
    expect(
      decideResponseIntent({
        actionIdentifier: 'reply',
        userText: 'The raised one',
        chatId: 'c1',
        actions,
      }),
    ).toEqual({
      kind: 'question_answer',
      chatId: 'c1',
      requestId: 'r1',
      questionText: 'Which bed?',
      answer: 'The raised one',
    });
  });

  it('Approve/Deny need a requestId; missing one is ignored', () => {
    expect(
      decideResponseIntent({
        actionIdentifier: 'approve',
        chatId: 'c1',
        actions: { kind: 'permission', requestId: 'r1' },
      }),
    ).toEqual({ kind: 'permission', chatId: 'c1', requestId: 'r1', decision: 'approve' });
    expect(
      decideResponseIntent({
        actionIdentifier: 'deny',
        chatId: 'c1',
        actions: { kind: 'permission', requestId: 'r1' },
      }),
    ).toEqual({ kind: 'permission', chatId: 'c1', requestId: 'r1', decision: 'deny' });
    expect(decideResponseIntent({ actionIdentifier: 'approve', chatId: 'c1' })).toEqual({
      kind: 'ignore',
    });
  });

  it('an option button answers the question with that option label', () => {
    const actions: NotifyActionsPayload = {
      kind: 'question',
      requestId: 'r1',
      questionText: 'Auth method?',
      options: ['OAuth', 'JWT'],
    };
    expect(decideResponseIntent({ actionIdentifier: 'option-1', chatId: 'c1', actions })).toEqual({
      kind: 'question_answer',
      chatId: 'c1',
      requestId: 'r1',
      questionText: 'Auth method?',
      answer: 'JWT',
    });
  });

  it('an option button with no matching index, or non-question actions, is ignored', () => {
    const actions: NotifyActionsPayload = {
      kind: 'question',
      requestId: 'r1',
      questionText: 'q',
      options: ['OAuth'],
    };
    expect(decideResponseIntent({ actionIdentifier: 'option-5', chatId: 'c1', actions })).toEqual({
      kind: 'ignore',
    });
    expect(
      decideResponseIntent({
        actionIdentifier: 'option-0',
        chatId: 'c1',
        actions: { kind: 'permission', requestId: 'r1' },
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it('a quickreply button sends its text as a chat reply', () => {
    const actions: NotifyActionsPayload = {
      kind: 'message',
      quickReplies: ['Yes', 'Snooze 10 min'],
    };
    expect(
      decideResponseIntent({ actionIdentifier: 'quickreply-1', chatId: 'c1', actions }),
    ).toEqual({
      kind: 'reply',
      chatId: 'c1',
      text: 'Snooze 10 min',
    });
  });

  it('a quickreply button with no matching index is ignored', () => {
    expect(
      decideResponseIntent({
        actionIdentifier: 'quickreply-3',
        chatId: 'c1',
        actions: { kind: 'message', quickReplies: ['Yes'] },
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it('an unrecognised action identifier is ignored', () => {
    expect(decideResponseIntent({ actionIdentifier: 'something-else', chatId: 'c1' })).toEqual({
      kind: 'ignore',
    });
  });
});
