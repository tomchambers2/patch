// spec/04 ## Message queueing § Edit — "click to edit a queued message". A
// message queued behind a running turn can be clicked and edited before it is
// delivered: the same in-place editor a settled turn's edit uses, saving fires
// `chat.edit_queued_request`, the host's `chat.queued` re-announce updates the
// entry IN PLACE (never reorders the queue), the auto-interrupt countdown is
// held while the editor is open, and a message that starts running mid-edit
// closes the editor, says so, and puts the edited text in the composer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

type Ws = Parameters<typeof ChatRoute>[0]['ws'];

function seed(chatId: string, timeline: ChatEventEntry[], running = true): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: running ? 'running' : 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: timeline } }));
}

const queued = (localId: string, content: string, seq: number): ChatEventEntry => ({
  seq,
  kind: 'message',
  role: 'user',
  content,
  queued: true,
  localId,
  at: 0,
});

function renderChat(chatId: string, ws: Ws) {
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fakeWs(): { ws: Ws; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { ws: { send, requestReplay() {} } as unknown as Ws, send };
}

const queuedMsgs = () =>
  screen.getAllByTestId('msg').filter((m) => m.getAttribute('data-queued') === 'true');

describe('ChatRoute — editing a queued message', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    vi.useRealTimers();
  });

  it('clicking the queued text opens the editor pre-filled; Save fires chat.edit_queued_request', () => {
    const { ws, send } = fakeWs();
    seed('c-qe', [queued('Q1', 'frist draft', 1), queued('Q2', 'second', 2)]);
    renderChat('c-qe', ws);

    fireEvent.click(queuedMsgs()[0]!.querySelector('[data-testid="msg-content"]')!);
    const input = screen.getByTestId('msg-edit-input') as HTMLTextAreaElement;
    expect(input.value).toBe('frist draft');
    fireEvent.change(input, { target: { value: 'first draft' } });
    fireEvent.click(screen.getByTestId('msg-edit-save'));

    expect(send).toHaveBeenCalledWith({
      type: 'chat.edit_queued_request',
      chatId: 'c-qe',
      localId: 'Q1',
      message: 'first draft',
    });
    // Never a fork: the queued turn has no place in the transcript yet.
    expect(
      send.mock.calls.some(([e]) => (e as { type: string }).type === 'chat.fork_request'),
    ).toBe(false);
    expect(screen.queryByTestId('msg-edit-input')).toBeNull();
  });

  it("the host's chat.queued re-announce updates the entry in place without reordering the queue", () => {
    const { ws } = fakeWs();
    seed('c-qe-echo', [queued('Q1', 'one', 1), queued('Q2', 'two', 2)]);
    renderChat('c-qe-echo', ws);
    act(() => {
      useChatStore.getState().applyEvents([
        {
          type: 'chat.queued',
          chatId: 'c-qe-echo',
          localId: 'Q1',
          message: 'one, edited',
          queueSeq: 1,
        },
      ]);
    });
    const shown = queuedMsgs();
    expect(shown[0]).toHaveTextContent('one, edited');
    expect(shown[1]).toHaveTextContent('two');
  });

  it('Cancel puts the queued message back untouched and sends nothing', () => {
    const { ws, send } = fakeWs();
    seed('c-qe-cancel', [queued('Q1', 'keep me', 1)]);
    renderChat('c-qe-cancel', ws);
    fireEvent.click(screen.getByTestId('msg-content'));
    fireEvent.change(screen.getByTestId('msg-edit-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('msg-edit-cancel'));
    expect(send).not.toHaveBeenCalled();
    expect(queuedMsgs()[0]).toHaveTextContent('keep me');
  });

  it('a message that starts running mid-edit closes the editor, says so, and puts the edit in the composer', () => {
    const { ws, send } = fakeWs();
    seed('c-qe-race', [queued('Q1', 'original', 1)]);
    renderChat('c-qe-race', ws);
    fireEvent.click(screen.getByTestId('msg-content'));
    fireEvent.change(screen.getByTestId('msg-edit-input'), {
      target: { value: 'what I meant' },
    });
    act(() => {
      useChatStore
        .getState()
        .applyEvents([
          { type: 'chat.dequeued', chatId: 'c-qe-race', localId: 'Q1', reason: 'running' },
        ]);
    });
    expect(screen.queryByTestId('msg-edit-input')).toBeNull();
    expect(useUiStore.getState().errors.some((e) => /already been sent/i.test(e.message))).toBe(
      true,
    );
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(
      'what I meant',
    );
    expect(
      send.mock.calls.some(([e]) => (e as { type: string }).type === 'chat.edit_queued_request'),
    ).toBe(false);
  });

  it('an edit emptied of text on a message with no attachments removes it (chat.unqueue_request)', () => {
    const { ws, send } = fakeWs();
    seed('c-qe-empty', [queued('Q1', 'drop me', 1)]);
    renderChat('c-qe-empty', ws);
    fireEvent.click(screen.getByTestId('msg-content'));
    fireEvent.change(screen.getByTestId('msg-edit-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('msg-edit-save'));
    expect(send).toHaveBeenCalledWith({
      type: 'chat.unqueue_request',
      chatId: 'c-qe-empty',
      localId: 'Q1',
    });
    expect(queuedMsgs.length).toBeDefined();
    expect(
      screen.queryAllByTestId('msg').filter((m) => m.getAttribute('data-queued')),
    ).toHaveLength(0);
  });
});
