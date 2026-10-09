// spec/02 § System-reminder disclosure and § Provider-level context — what the
// phone's store keeps of the context a turn received beyond what was typed.
//
// Per turn: every captured `<system-reminder>` block rides the user turn's
// `chat.message` as `systemContext`. It must survive every path that turn can
// take into the timeline — appended, reconciled onto the optimistic echo, or
// folded onto the bubble of the turn a restart re-sent (the restart notice
// itself rides exactly that fold).
//
// Per chat: Claude Code's own `chat.provider_context` is one entry per
// category, upserted with a running count, and a replay re-delivering an event
// already applied must not count it twice.

import { describe, it, expect, beforeEach } from 'vitest';
import type { SystemContextItem } from '@patch/wire';
import { useChatStore } from '../src/stores/chatStore';

const restart: SystemContextItem = {
  source: 'patch',
  label: 'Turn interrupted by restart',
  text: 'This turn was already running when the host restarted.',
};
const todo: SystemContextItem = {
  source: 'patch',
  label: 'Todo list updated',
  text: 'The user edited the task list.',
};

beforeEach(() => {
  useChatStore.getState()._reset();
});

function userBubbles() {
  return (useChatStore.getState().timelines['c1'] ?? []).filter(
    (e) => e.kind === 'message' && e.role === 'user',
  );
}

describe('systemContext on a user turn', () => {
  it('keeps it on a turn appended from the stream or a replay', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'go',
      seq: 2,
      systemContext: [todo],
    });
    expect(userBubbles()[0]?.systemContext).toEqual([todo]);
  });

  it('lands it on the optimistic echo the persisted copy reconciles with', () => {
    const s = useChatStore.getState();
    s.appendLocalUserMessage('c1', 'go', 'L1');
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'go',
      seq: 2,
      localId: 'L1',
      systemContext: [todo],
    });
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.systemContext).toEqual([todo]);
  });

  it("appends a restart re-send's context to the bubble it folds into, once per attempt", () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'go',
      seq: 2,
      systemContext: [todo],
    });
    const resend = (): void =>
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'Carry on',
        seq: 7,
        retryOfSeq: 2,
        systemContext: [restart],
      });
    resend();
    // A replay hands the same re-send back — it must not stack another copy.
    resend();
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.systemContext).toEqual([todo, restart]);
  });

  it('leaves an ordinary turn without any', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 1 });
    expect(userBubbles()[0]?.systemContext).toBeUndefined();
  });
});

describe('chat.provider_context', () => {
  const provider = (seq: number, providerType: string, label: string, text: string): void =>
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.provider_context', chatId: 'c1', seq, providerType, label, text });

  it('keeps one entry per category, the latest text, and how many times it came', () => {
    provider(1, 'model', 'Model', 'Sonnet 5');
    provider(2, 'total_tokens_reminder', 'Tokens remaining', '900 left');
    provider(3, 'total_tokens_reminder', 'Tokens remaining', '800 left');
    expect(useChatStore.getState().providerContext['c1']).toEqual({
      model: { label: 'Model', text: 'Sonnet 5', count: 1, firstSeq: 1, lastSeq: 1 },
      total_tokens_reminder: {
        label: 'Tokens remaining',
        text: '800 left',
        count: 2,
        firstSeq: 2,
        lastSeq: 3,
      },
    });
  });

  it('does not count an event a replay re-delivers', () => {
    provider(2, 'total_tokens_reminder', 'Tokens remaining', '900 left');
    provider(3, 'total_tokens_reminder', 'Tokens remaining', '800 left');
    provider(2, 'total_tokens_reminder', 'Tokens remaining', '900 left');
    provider(3, 'total_tokens_reminder', 'Tokens remaining', '800 left');
    const entry = useChatStore.getState().providerContext['c1']?.['total_tokens_reminder'];
    expect(entry?.count).toBe(2);
    expect(entry?.text).toBe('800 left');
  });

  it('survives the roster being re-hydrated wholesale', () => {
    provider(1, 'model', 'Model', 'Sonnet 5');
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: null,
        daemonId: 'd1',
        folder: '~/p',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    expect(useChatStore.getState().providerContext['c1']?.['model']?.text).toBe('Sonnet 5');
  });
});
