// app/chats/[chatId].tsx — AskUserQuestion renders as a question card, not a
// generic Approve/Deny permission prompt (spec/15 § Chat detail; parity with
// `packages/web/src/__tests__/ChatRoute.askUserQuestion.test.tsx`). This is
// the bug reported via screenshot: mobile was asking for permission to ask a
// question instead of showing the question.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, findAllHost, queryHost, byTestId, hasText } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

const sendMock = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: sendMock, safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const questionArgs = {
  questions: [
    {
      header: 'Auth method',
      question: 'Which library should we use for date formatting?',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Tree-shakeable, immutable' },
        { label: 'Luxon', description: 'Timezone-aware' },
      ],
    },
  ],
};

const askQuestion = (requestId = 'r1'): void =>
  useChatStore.getState().applyEvent({
    type: 'chat.permission_request',
    chatId: 'c1',
    seq: 1,
    requestId,
    request: { tool: 'AskUserQuestion', description: 'AskUserQuestion', args: questionArgs },
  });

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('AskUserQuestion — question card, not a permission prompt', () => {
  it('renders the question and its options, not "Permission needed: AskUserQuestion"', () => {
    askQuestion();
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Permission needed')).toBe(false);
    expect(hasText(r.root, 'Which library should we use for date formatting?')).toBe(true);
    expect(hasText(r.root, 'date-fns')).toBe(true);
    expect(hasText(r.root, 'Luxon')).toBe(true);
    // Not the generic Yes/allow-all/No options.
    expect(hasText(r.root, '1. Yes')).toBe(false);
  });

  it('answering sends approve_with_edits with the selection as the answer', () => {
    askQuestion();
    const r = renderRN(<ChatDetailScreen />);
    const options = findAllHost(r.root, byTestId('question-option'));
    const dateFns = options.find((o) => hasText(o, 'date-fns'))!;
    dateFns.props.onPress();
    const submit = findHost(r.root, byTestId('question-submit'));
    submit.props.onPress();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.permission_response',
      // The chat the answer belongs to. Without it the server cannot relay the
      // response to the chat's OWNING host, so an answer to a question asked by
      // a Mac-owned chat was accepted here and then lost (Todoist, "question
      // answers for chats on the Mac go to Hetzner and are lost").
      chatId: 'c1',
      requestId: 'r1',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({
        'Which library should we use for date formatting?': 'date-fns',
      }),
    });
  });

  it('the submit button is disabled until every question has an answer', () => {
    askQuestion();
    const r = renderRN(<ChatDetailScreen />);
    const submit = findHost(r.root, byTestId('question-submit'));
    expect(submit.props.disabled).toBe(true);
    // A disabled Pressable has no live press handler; if one is wired, it
    // must still send nothing.
    (submit.props['onPress'] as (() => void) | undefined)?.();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('cancel sends a plain deny, not an answer', () => {
    askQuestion();
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byTestId('question-cancel')).props.onPress();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r1',
      approve: false,
    });
  });

  it('an unreadable question shows an error and offers only Cancel', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 1,
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', description: 'AskUserQuestion', args: { nope: true } },
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'could not read')).toBe(true);
    expect(queryHost(r.root, byTestId('question-submit'))).toBeNull();
    expect(findHost(r.root, byTestId('question-cancel'))).toBeTruthy();
  });

  it('an answered card drops its options and shows the outcome', () => {
    askQuestion();
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('question-submit'))).toBeNull();
    expect(hasText(r.root, 'Answered')).toBe(true);
  });

  // spec/15 § Chat detail — mirrors web's "a resolved card still shows what
  // was picked" (Todoist: "patch previous question answers are not being
  // stored"). `resolvePermission`'s picked options used to live only in the
  // component's own state, gone the instant the screen remounted.
  it('a resolved card still shows the option that was picked', () => {
    askQuestion();
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve', {
      'Which library should we use for date formatting?': 'Luxon',
    });
    const r = renderRN(<ChatDetailScreen />);
    const options = findAllHost(r.root, byTestId('question-option'));
    const luxon = options.find((o) => hasText(o, 'Luxon'))!;
    const dateFns = options.find((o) => hasText(o, 'date-fns'))!;
    expect(luxon.props.accessibilityState.checked).toBe(true);
    expect(dateFns.props.accessibilityState.checked).toBe(false);
  });

  it('the tool call and (approved) tool result rows are not drawn twice — the card is the row', () => {
    askQuestion();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 2,
      tool: 'AskUserQuestion',
      args: questionArgs,
      callId: 'call1',
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    useChatStore.getState().applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 3,
      tool: 'AskUserQuestion',
      result: 'date-fns',
      callId: 'call1',
    });
    const r = renderRN(<ChatDetailScreen />);
    // Only the question card itself — no separate collapsed tool-call/
    // tool-result row underneath it (that row's summary would read the bare
    // tool name, since AskUserQuestion has no toolCallTarget case).
    expect(findAllHost(r.root, byTestId('question-card')).length).toBe(1);
    expect(hasText(r.root, 'AskUserQuestion')).toBe(false);
  });
});
