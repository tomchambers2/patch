// spec/12 § A turn is owed until it settles.
//
// Tom photographed one question rendered as THREE identical bubbles with a red
// "Connection to the host was lost" card wedged between the first two, while
// the chat underneath carried on thinking. Every artefact of a recovery was in
// the transcript and none of it ever went away: "this is a mess. the error
// should be temporary, not there forever… the human message shouldnt be
// repeated."
//
// The host re-sends an owed turn ITSELF — on restart (`resumeInterruptedTurns`)
// and on each rung of the SDK-error ladder — and every re-send is a real,
// separately-persisted user message. These cover the surface half: a re-send
// folds onto the bubble the turn already has, the marks that said it failed come
// off as it goes round again, and what the failed attempt said stays reachable
// behind the `< >` pager instead of sitting in the transcript for ever.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

function spawn(): void {
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
}

/** The user's turn, as the host persists it: seq 2, localId echoed back. */
function originalTurn(): void {
  const s = useChatStore.getState();
  s.addLocalMessage('c1', 'check rons latest messages', 'lid-1');
  s.applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'user',
    content: 'check rons latest messages',
    seq: 2,
    localId: 'lid-1',
  });
}

/** One rung of a recovery: the host re-sending the SAME turn under a new seq. */
function resend(seq: number, retryOfSeq: number): void {
  useChatStore.getState().applyEvent({
    type: 'chat.message',
    chatId: 'c1',
    role: 'user',
    content: 'check rons latest messages',
    seq,
    retryOfSeq,
  });
}

function state(activity: 'running' | 'errored' | 'idle'): void {
  useChatStore.getState().applyEvent({
    type: 'chat.state',
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'auto',
    activity,
    lastUpdated: 1,
  });
}

function timeline() {
  return useChatStore.getState().timelines['c1'] ?? [];
}
function userBubbles() {
  return timeline().filter((e) => e.kind === 'message' && e.role === 'user');
}

describe('chatStore — a re-sent turn folds onto the bubble it already has', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it('draws ONE bubble for a turn the host re-sent, not two', () => {
    spawn();
    originalTurn();
    resend(7, 2);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.seq).toBe(2);
    expect(userBubbles()[0]?.attempts).toEqual([{ seq: 2 }, { seq: 7 }]);
  });

  it('draws ONE bubble across three attempts — the screenshot, fixed', () => {
    spawn();
    originalTurn();
    // Every rung names the ORIGINAL, never the rung before it.
    resend(7, 2);
    resend(12, 2);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.attempts).toHaveLength(3);
  });

  it('folds a rung that names a LATER attempt, not the original', () => {
    // The host anchors every rung on the original, but a frame that named an
    // intermediate attempt must still find its bubble rather than start one.
    spawn();
    originalTurn();
    resend(7, 2);
    resend(12, 7);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.attempts?.map((a) => a.seq)).toEqual([2, 7, 12]);
  });

  it('does not count the same attempt twice when a replay hands it back', () => {
    spawn();
    originalTurn();
    resend(7, 2);
    resend(7, 2);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.attempts).toHaveLength(2);
  });

  it('leaves an ordinary re-typed message alone — that is a new turn', () => {
    // NO field on the frame means the user sent it, and two identical messages
    // the user really did send are two messages. Never dedupe on text.
    spawn();
    originalTurn();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'check rons latest messages',
      seq: 7,
    });
    expect(userBubbles()).toHaveLength(2);
  });

  it('renders a re-send whose original is not here rather than dropping it', () => {
    // A trimmed timeline has no bubble to fold onto. Showing the turn twice is
    // bad; swallowing a user message the host really persisted is worse.
    spawn();
    resend(7, 2);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.seq).toBe(7);
  });
});

describe('chatStore — the failure is temporary once the turn goes round again', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it('clears the turn-failed mark when the re-send lands', () => {
    spawn();
    originalTurn();
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'stream disconnected' },
      seq: 5,
      causeSeq: 2,
    });
    expect(userBubbles()[0]?.turnFailed).toBe(true);
    resend(7, 2);
    expect(userBubbles()[0]?.turnFailed).toBe(false);
    // …and the failure is not lost: it belongs to the attempt it ended.
    expect(userBubbles()[0]?.attempts?.[0]).toEqual({
      error: 'stream disconnected',
      errorCode: 'sdk_error',
      seq: 2,
    });
  });

  it('keeps the mark when the ladder is exhausted and nothing re-sends', () => {
    spawn();
    originalTurn();
    resend(7, 2);
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      // The LAST rung's failure names that rung's own seq, and has to find the
      // bubble that owns it through the attempt list.
      error: { code: 'sdk_error', message: 'stream disconnected' },
      seq: 9,
      causeSeq: 7,
    });
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.turnFailed).toBe(true);
  });

  it('files the daemon-link card on the attempt it ended, and takes it off the transcript', () => {
    spawn();
    originalTurn();
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
      seq: -1,
    });
    state('errored');
    expect(timeline().filter((e) => e.kind === 'error')).toHaveLength(1);
    // The host is back and running the turn again.
    state('running');
    expect(timeline().filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(userBubbles()[0]?.attempts).toEqual([
      { seq: 2, error: 'Connection to the host was lost.', errorCode: 'daemon_unavailable' },
    ]);
    // …and the re-send that follows becomes attempt two of the same bubble.
    resend(7, 2);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.attempts).toHaveLength(2);
    expect(userBubbles()[0]?.attempts?.[0]?.error).toBe('Connection to the host was lost.');
  });

  it('records ONE outcome per attempt, however many recovery frames arrive', () => {
    spawn();
    originalTurn();
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'daemon_unavailable', message: 'first' },
      seq: -1,
    });
    state('running');
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'daemon_unavailable', message: 'second' },
      seq: -1,
    });
    state('running');
    expect(userBubbles()[0]?.attempts).toEqual([
      { seq: 2, error: 'first', errorCode: 'daemon_unavailable' },
    ]);
  });
});

// spec/02 § System-reminder disclosure — a restart resume re-sends the turn it
// cut off with a leading `<system-reminder>` saying so, captured as
// `systemContext` on the re-send's `chat.message`. That re-send FOLDS onto the
// original bubble, and the fold used to keep only the attempt's seq — so the
// one reminder this disclosure most exists to show (the restart notice) never
// reached the screen, live or on replay.
describe('chatStore — a folded re-send keeps the system context it carried', () => {
  const restart = {
    source: 'patch' as const,
    label: 'Turn interrupted by restart',
    text: 'This turn was already running when the host restarted.',
  };
  const resendWith = (seq: number, retryOfSeq: number): void =>
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'Carry on',
      seq,
      retryOfSeq,
      systemContext: [restart],
    });

  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it("lands the re-send's systemContext on the bubble it folded into", () => {
    spawn();
    originalTurn();
    resendWith(7, 2);
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]!.systemContext).toEqual([restart]);
  });

  it('appends after context the bubble already had, once per attempt, and a replay adds nothing', () => {
    spawn();
    const todo = { source: 'patch' as const, label: 'Todo list updated', text: 'adopt the list' };
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'go',
      seq: 2,
      systemContext: [todo],
    });
    resendWith(7, 2);
    resendWith(9, 7);
    // A replay hands the same re-send back — it must not stack another copy.
    resendWith(9, 7);
    expect(userBubbles()[0]!.systemContext).toEqual([todo, restart, restart]);
  });

  it('a re-send carrying no context leaves the bubble without any', () => {
    spawn();
    originalTurn();
    resend(7, 2);
    expect(userBubbles()[0]!.systemContext).toBeUndefined();
  });
});
