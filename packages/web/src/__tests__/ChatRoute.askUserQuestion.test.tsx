// spec/14 § Main chat panel — Question prompts. An `AskUserQuestion` permission
// request is the agent asking the user to choose, not asking for approval. It
// used to render as a generic Approve/Deny card, which showed the tool's name
// instead of the question and returned no answer at all — the agent then
// carried on having "asked" and heard nothing.
//
// These cover the card rendering the real question, the answers going out on
// the existing `approve_with_edits` channel (spec/03 § Answering with content),
// multi-select, the free-text `Other` escape hatch, and cancel still denying.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useQuestionDraftStore } from '../stores/questionDraftStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    checkHooks: vi.fn(async () => ({ decision: 'pass', results: [] })),
  },
}));

const LIB_Q = 'Which date library should we use?';
const FEATURES_Q = 'Which features do you want enabled?';

const libraryArgs = {
  questions: [
    {
      header: 'Library',
      question: LIB_Q,
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
        { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
      ],
    },
  ],
};

const CONSENT_Q = 'Did you consent to receiving marketing from them?';
const IMPACT_Q = 'How did the message affect you?';

/** Two questions on one card — the shape where losing state is worst, since
 *  Send answer needs BOTH answered before it does anything at all. */
const twoQuestionArgs = {
  questions: [
    {
      header: 'Consent',
      question: CONSENT_Q,
      multiSelect: false,
      options: [
        { label: "Don't know", description: 'The honest default.' },
        { label: 'No', description: 'Never opted in.' },
      ],
    },
    {
      header: 'Impact',
      question: IMPACT_Q,
      multiSelect: false,
      options: [
        { label: 'Leave blank', description: 'Optional field.' },
        { label: 'It was a disruption', description: 'Middle option.' },
      ],
    },
  ],
};

const multiArgs = {
  questions: [
    {
      header: 'Features',
      question: FEATURES_Q,
      multiSelect: true,
      options: [
        { label: 'Search', description: 'Full-text search over chats.' },
        { label: 'Export', description: 'Download a transcript.' },
        { label: 'Sync', description: 'Cross-device sync.' },
      ],
    },
  ],
};

function seedChat(chatId: string, timeline: ChatEventEntry[]): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'auto' as const,
      name: chatId,
      folder: 'foo',
      activity: 'awaiting-permission',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: timeline } }));
}

function questionEntry(requestId: string, args: unknown): ChatEventEntry {
  return {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId,
    toolArgs: args,
    at: 0,
  };
}

function renderChat(chatId: string, send: ReturnType<typeof vi.fn>) {
  const ws = { send, requestReplay() {} } as unknown as Parameters<typeof ChatRoute>[0]['ws'];
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function optionButton(label: string): HTMLElement {
  const found = screen
    .getAllByTestId('question-option')
    .find((b) => b.getAttribute('data-label') === label);
  expect(found).toBeDefined();
  return found as HTMLElement;
}

function sentFrames(send: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return send.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

describe('AskUserQuestion card', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useQuestionDraftStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.setState({ pendingDiffByChat: {} });
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => cleanup());

  it('renders the question and its options instead of an Approve/Deny card', () => {
    seedChat('c-q', [questionEntry('req-q', libraryArgs)]);
    renderChat('c-q', vi.fn());

    // The generic approval card is NOT what this is.
    expect(screen.queryByTestId('permission')).toBeNull();
    expect(screen.queryByTestId('permission-approve-all')).toBeNull();

    const card = screen.getByTestId('question-card');
    // The question itself, its header chip, and each option with its own
    // description — the trade-off the agent wrote is on screen.
    expect(card.textContent).toContain(LIB_Q);
    expect(card.textContent).toContain('Library');
    expect(card.textContent).toContain('date-fns');
    expect(card.textContent).toContain('Tree-shakeable, function per format.');
    expect(card.textContent).toContain('Luxon');
    expect(card.textContent).toContain('Rich zone handling, bigger bundle.');
    // The tool name never stands in for the question.
    expect(card.textContent).not.toContain('AskUserQuestion');
    // Plus the automatic free-text escape hatch.
    expect(screen.getByTestId('question-other')).toBeDefined();
  });

  it('sends the chosen option as approve_with_edits keyed by the question text', () => {
    const send = vi.fn();
    seedChat('c-q-send', [questionEntry('req-send', libraryArgs)]);
    renderChat('c-q-send', send);

    fireEvent.click(optionButton('date-fns'));
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)).toEqual([
      {
        type: 'chat.permission_response',
        chatId: 'c-q-send',
        requestId: 'req-send',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: JSON.stringify({ [LIB_Q]: 'date-fns' }),
      },
    ]);
    // The card settles locally rather than sitting there still actionable.
    expect(screen.getByTestId('question-card').getAttribute('data-resolved')).toBe('approve');
    expect(screen.getByTestId('permission-outcome').textContent).toBe('Answered');
  });

  it('cannot be submitted until the question actually has an answer', () => {
    const send = vi.fn();
    seedChat('c-q-empty', [questionEntry('req-empty', libraryArgs)]);
    renderChat('c-q-empty', send);

    const submit = screen.getByTestId('question-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(optionButton('Luxon'));
    expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('single-select replaces the previous choice rather than accumulating', () => {
    const send = vi.fn();
    seedChat('c-q-single', [questionEntry('req-single', libraryArgs)]);
    renderChat('c-q-single', send);

    fireEvent.click(optionButton('date-fns'));
    fireEvent.click(optionButton('Luxon'));
    expect(optionButton('date-fns').getAttribute('data-selected')).toBe('false');
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(JSON.stringify({ [LIB_Q]: 'Luxon' }));
  });

  it('multiSelect keeps every choice and joins them into the one answer string', () => {
    const send = vi.fn();
    seedChat('c-q-multi', [questionEntry('req-multi', multiArgs)]);
    renderChat('c-q-multi', send);

    fireEvent.click(optionButton('Search'));
    fireEvent.click(optionButton('Sync'));
    expect(optionButton('Search').getAttribute('data-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [FEATURES_Q]: 'Search, Sync' }),
    );
  });

  it('multiSelect can deselect an option it already picked', () => {
    const send = vi.fn();
    seedChat('c-q-multi-off', [questionEntry('req-multi-off', multiArgs)]);
    renderChat('c-q-multi-off', send);

    fireEvent.click(optionButton('Search'));
    fireEvent.click(optionButton('Export'));
    fireEvent.click(optionButton('Search'));
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [FEATURES_Q]: 'Export' }),
    );
  });

  it('offers the free-text Other escape hatch; its comment is optional', () => {
    const send = vi.fn();
    seedChat('c-q-other', [questionEntry('req-other', libraryArgs)]);
    renderChat('c-q-other', send);

    fireEvent.click(screen.getByTestId('question-other'));
    // Single-select Other is a radio: with no comment it sends the label.
    expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByTestId('question-other-input'), {
      target: { value: 'Temporal, once it ships' },
    });
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [LIB_Q]: 'Temporal, once it ships' }),
    );
  });

  it('Other with no comment sends "Other", and deselects a picked option', () => {
    const send = vi.fn();
    seedChat('c-q-other-bare', [questionEntry('req-other-bare', libraryArgs)]);
    renderChat('c-q-other-bare', send);

    const first = screen.getAllByTestId('question-option')[0] as HTMLElement;
    fireEvent.click(first);
    fireEvent.click(screen.getByTestId('question-other'));
    expect(first.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(JSON.stringify({ [LIB_Q]: 'Other' }));
  });

  // Tom, App Updates: "patch other input box, does nothing on enter. should add
  // a new line. shift/cmd enter should send it". The Other box is the one place
  // in the app a LONGER free-text answer gets typed, so its Enter mapping is the
  // deliberate INVERSE of the composer's (spec/14 § Main chat panel — Question
  // prompts). It is a textarea, not an input, because a single-line input cannot
  // hold a newline at all.
  it('the Other box is a textarea, so a newline is representable at all', () => {
    seedChat('c-q-other-textarea', [questionEntry('req-other-textarea', libraryArgs)]);
    renderChat('c-q-other-textarea', vi.fn());

    fireEvent.click(screen.getByTestId('question-other'));
    expect(screen.getByTestId('question-other-input').tagName).toBe('TEXTAREA');
  });

  it('bare Enter in the Other box does not send — it is left to insert a newline', () => {
    const send = vi.fn();
    seedChat('c-q-other-enter', [questionEntry('req-other-enter', libraryArgs)]);
    renderChat('c-q-other-enter', send);

    fireEvent.click(screen.getByTestId('question-other'));
    const box = screen.getByTestId('question-other-input');
    fireEvent.change(box, { target: { value: 'Temporal' } });
    // A complete answer — so nothing but the key mapping can be what holds it back.
    expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(false);

    const sent = fireEvent.keyDown(box, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    // Not prevented: the browser's own default is what puts the newline in.
    expect(sent).toBe(true);
  });

  it('Shift+Enter in the Other box does not send either', () => {
    const send = vi.fn();
    seedChat('c-q-other-shift', [questionEntry('req-other-shift', libraryArgs)]);
    renderChat('c-q-other-shift', send);

    fireEvent.click(screen.getByTestId('question-other'));
    const box = screen.getByTestId('question-other-input');
    fireEvent.change(box, { target: { value: 'Temporal' } });

    const sent = fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(sent).toBe(true);
  });

  it('Cmd+Enter in the Other box sends the answer', () => {
    const send = vi.fn();
    seedChat('c-q-other-cmd', [questionEntry('req-other-cmd', libraryArgs)]);
    renderChat('c-q-other-cmd', send);

    fireEvent.click(screen.getByTestId('question-other'));
    fireEvent.change(screen.getByTestId('question-other-input'), {
      target: { value: 'Temporal\nonce it ships' },
    });
    const sent = fireEvent.keyDown(screen.getByTestId('question-other-input'), {
      key: 'Enter',
      metaKey: true,
    });

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [LIB_Q]: 'Temporal\nonce it ships' }),
    );
    // Prevented, so the send does not ALSO leave a newline behind.
    expect(sent).toBe(false);
  });

  it('Ctrl+Enter in the Other box sends the answer too', () => {
    const send = vi.fn();
    seedChat('c-q-other-ctrl', [questionEntry('req-other-ctrl', libraryArgs)]);
    renderChat('c-q-other-ctrl', send);

    fireEvent.click(screen.getByTestId('question-other'));
    fireEvent.change(screen.getByTestId('question-other-input'), { target: { value: 'Day.js' } });
    fireEvent.keyDown(screen.getByTestId('question-other-input'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(JSON.stringify({ [LIB_Q]: 'Day.js' }));
  });

  it('Cmd+Enter cannot send an incomplete card', () => {
    const send = vi.fn();
    seedChat('c-q-other-incomplete', [
      questionEntry('req-other-incomplete', {
        questions: [...libraryArgs.questions, ...multiArgs.questions],
      }),
    ]);
    renderChat('c-q-other-incomplete', send);

    // Other chosen on question one, nothing typed, question two untouched.
    fireEvent.click(screen.getAllByTestId('question-other')[0] as HTMLElement);
    const box = screen.getByTestId('question-other-input');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(send).not.toHaveBeenCalled();

    // Typed, but the SECOND question is still unanswered — still not sendable.
    fireEvent.change(box, { target: { value: 'Temporal' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(send).not.toHaveBeenCalled();
    expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(true);

    // Answer it and the same keystroke goes through.
    fireEvent.click(optionButton('Export'));
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [LIB_Q]: 'Temporal', [FEATURES_Q]: 'Export' }),
    );
  });

  it('leaves an IME composition alone — Cmd+Enter mid-candidate does not send', () => {
    const send = vi.fn();
    seedChat('c-q-other-ime', [questionEntry('req-other-ime', libraryArgs)]);
    renderChat('c-q-other-ime', send);

    fireEvent.click(screen.getByTestId('question-other'));
    const box = screen.getByTestId('question-other-input');
    fireEvent.change(box, { target: { value: 'Temporal' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('Other on a single-select replaces the selected option; its comment is the answer', () => {
    const send = vi.fn();
    seedChat('c-q-other-clears', [questionEntry('req-other-clears', libraryArgs)]);
    renderChat('c-q-other-clears', send);

    fireEvent.click(optionButton('date-fns'));
    fireEvent.click(screen.getByTestId('question-other'));
    expect(optionButton('date-fns').getAttribute('data-selected')).toBe('false');
    fireEvent.change(screen.getByTestId('question-other-input'), {
      target: { value: 'Also Day.js' },
    });
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [LIB_Q]: 'Also Day.js' }),
    );
  });

  // Tom, App Updates: "when answering a qusetion, clicking other must focus
  // input". Choosing `Other` used to reveal the box and leave the cursor on the
  // button, so typing an answer cost a second click. The box is mounted BY the
  // click that reveals it, so mount-time focus is the whole fix — and it is
  // also what keeps focus still on every other transition.
  it('one click on Other puts the cursor straight in the box', () => {
    seedChat('c-q-other-focus', [questionEntry('req-other-focus', libraryArgs)]);
    renderChat('c-q-other-focus', vi.fn());

    fireEvent.click(screen.getByTestId('question-other'));

    expect(document.activeElement).toBe(screen.getByTestId('question-other-input'));
  });

  it('focuses the box belonging to the question whose Other was clicked', () => {
    seedChat('c-q-other-focus-which', [
      questionEntry('req-other-focus-which', {
        questions: [...libraryArgs.questions, ...multiArgs.questions],
      }),
    ]);
    renderChat('c-q-other-focus-which', vi.fn());

    // The SECOND question's Other — not the first, which is what a "focus the
    // one box on screen" implementation would land on.
    fireEvent.click(screen.getAllByTestId('question-other')[1] as HTMLElement);

    const boxes = screen.getAllByTestId('question-other-input');
    expect(boxes).toHaveLength(1);
    expect(document.activeElement).toBe(boxes[0]);
    expect((boxes[0] as HTMLElement).getAttribute('aria-label')).toBe(
      `Other answer for ${FEATURES_Q}`,
    );
  });

  it('turning Other back off takes the box away, and turning it on again re-takes the cursor', () => {
    seedChat('c-q-other-focus-toggle', [questionEntry('req-other-focus-toggle', libraryArgs)]);
    renderChat('c-q-other-focus-toggle', vi.fn());

    fireEvent.click(screen.getByTestId('question-other'));
    expect(document.activeElement).toBe(screen.getByTestId('question-other-input'));

    // Off: the box goes, and nothing in the card grabs the cursor in its place.
    fireEvent.click(screen.getByTestId('question-other'));
    expect(screen.queryByTestId('question-other-input')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId('question-card'));

    // On again: one click, cursor back in the box.
    fireEvent.click(screen.getByTestId('question-other'));
    expect(document.activeElement).toBe(screen.getByTestId('question-other-input'));
  });

  it('a card that resolves while Other is open does not pull focus back to the card', () => {
    seedChat('c-q-other-focus-resolved', [questionEntry('req-other-focus-resolved', libraryArgs)]);
    renderChat('c-q-other-focus-resolved', vi.fn());

    fireEvent.click(screen.getByTestId('question-other'));
    expect(document.activeElement).toBe(screen.getByTestId('question-other-input'));

    // The question is answered elsewhere / expires: the box goes with it, and
    // the settled card is inert rather than something that takes the cursor.
    act(() => {
      useChatStore.setState((s) => ({
        timelines: {
          ...s.timelines,
          'c-q-other-focus-resolved': [
            {
              ...questionEntry('req-other-focus-resolved', libraryArgs),
              permissionResolved: 'approve' as const,
            },
          ],
        },
      }));
    });

    expect(screen.queryByTestId('question-other-input')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId('question-card'));
  });

  it('answers every question when the agent asked more than one', () => {
    const send = vi.fn();
    seedChat('c-q-two', [
      questionEntry('req-two', { questions: [...libraryArgs.questions, ...multiArgs.questions] }),
    ]);
    renderChat('c-q-two', send);

    expect(screen.getAllByTestId('question-block')).toHaveLength(2);
    fireEvent.click(optionButton('Luxon'));
    // One of two answered is not enough to send.
    expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(optionButton('Export'));
    fireEvent.click(screen.getByTestId('question-submit'));

    expect(sentFrames(send)[0]?.['editedNewString']).toBe(
      JSON.stringify({ [LIB_Q]: 'Luxon', [FEATURES_Q]: 'Export' }),
    );
  });

  it('cancel returns a real denial, not an empty approval', () => {
    const send = vi.fn();
    seedChat('c-q-cancel', [questionEntry('req-cancel', libraryArgs)]);
    renderChat('c-q-cancel', send);

    fireEvent.click(screen.getByTestId('question-cancel'));

    expect(sentFrames(send)).toEqual([
      {
        type: 'chat.permission_response',
        chatId: 'c-q-cancel',
        requestId: 'req-cancel',
        approve: false,
      },
    ]);
    expect(screen.getByTestId('question-card').getAttribute('data-resolved')).toBe('deny');
    expect(screen.getByTestId('permission-outcome').textContent).toBe('Cancelled');
  });

  // spec/02 § Questions are not approvals — answering in the composer instead of
  // on the card. The composer is deliberately NOT disabled while a question is
  // open (a typed answer is often better than any option the agent guessed), so
  // the send must go through AND the card must not be left hanging behind it.
  // The cancellation is the host's, not the surface's: it is the host that
  // holds the turn blocked on the question, so it decides, and the card learns
  // the outcome from the `chat.permission_response` it echoes back. A surface
  // that resolved the card locally on send would be asserting an outcome it does
  // not own, and would show Cancelled for a question the host had already
  // answered some other way.
  it('accepts a message typed while a question card is open, and the host cancel echo settles the card', async () => {
    const send = vi.fn();
    seedChat('c-q-typed', [questionEntry('req-typed', libraryArgs)]);
    renderChat('c-q-typed', send);

    // The card is live and unanswered; the composer is still usable.
    expect(screen.getByTestId('question-card').getAttribute('data-resolved')).toBeNull();
    const composer = screen.getByTestId('composer-input');
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);

    fireEvent.change(composer, { target: { value: 'neither — use Temporal' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // The message went out as an ordinary turn, once the hook check (pass,
    // nothing configured) has resolved. The surface sends NO permission
    // response of its own — cancelling is the host's to do.
    await waitFor(() =>
      expect(sentFrames(send)).toEqual([
        expect.objectContaining({
          type: 'chat.input',
          chatId: 'c-q-typed',
          message: 'neither — use Temporal',
        }),
      ]),
    );
    expect(sentFrames(send).some((f) => f['type'] === 'chat.permission_response')).toBe(false);

    // The host cancels the question and echoes the resolution back.
    act(() => {
      useChatStore.getState().resolvePermission('c-q-typed', 'req-typed', 'deny');
    });

    expect(screen.getByTestId('question-card').getAttribute('data-resolved')).toBe('deny');
    expect(screen.getByTestId('permission-outcome').textContent).toBe('Cancelled');
    // ...and the typed message is still in the transcript, not swallowed by it.
    expect(
      (useChatStore.getState().timelines['c-q-typed'] ?? []).some(
        (e) => e.kind === 'message' && e.content === 'neither — use Temporal',
      ),
    ).toBe(true);
  });

  it('says so loudly when the question args cannot be read, instead of approving blind', () => {
    const send = vi.fn();
    seedChat('c-q-broken', [questionEntry('req-broken', { questions: [{ header: 'x' }] })]);
    renderChat('c-q-broken', send);

    expect(screen.getByTestId('question-parse-error')).toBeDefined();
    // No way to submit an answer that does not exist; cancel is the way out.
    expect(screen.queryByTestId('question-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('question-cancel'));
    expect(sentFrames(send)).toEqual([
      {
        type: 'chat.permission_response',
        chatId: 'c-q-broken',
        requestId: 'req-broken',
        approve: false,
      },
    ]);
  });

  it('a resolved card is inert — no option or cancel can re-answer it', () => {
    const send = vi.fn();
    seedChat('c-q-resolved', [
      { ...questionEntry('req-resolved', libraryArgs), permissionResolved: 'approve' },
    ]);
    renderChat('c-q-resolved', send);

    expect((optionButton('date-fns') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('question-submit')).toBeNull();
    expect(screen.queryByTestId('question-cancel')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  // spec/14 § Main chat panel — Question prompts: "the card already shows the
  // questions, the options, the selections and the outcome". These pin the
  // resolved card actually drawing the SELECTION, not just the outcome — the
  // bug (Todoist: "patch previous question answers are not being stored") was
  // that `picked` only ever lived in this component's own state, so a card
  // resolved from `permissionAnswers` alone (a remount, a reload, the
  // host's echo) drew every option blank.
  describe('a resolved card still shows what was picked', () => {
    it('single-select: the chosen option stays visibly selected', () => {
      seedChat('c-q-resolved-single', [
        {
          ...questionEntry('req-resolved-single', libraryArgs),
          permissionResolved: 'approve',
          permissionAnswers: { [LIB_Q]: 'Luxon' },
        },
      ]);
      renderChat('c-q-resolved-single', vi.fn());

      expect(optionButton('Luxon').getAttribute('data-selected')).toBe('true');
      expect(optionButton('date-fns').getAttribute('data-selected')).toBe('false');
      expect(screen.getByTestId('permission-outcome').textContent).toBe('Answered');
    });

    it('multiSelect: every picked option stays visibly selected', () => {
      seedChat('c-q-resolved-multi', [
        {
          ...questionEntry('req-resolved-multi', multiArgs),
          permissionResolved: 'approve',
          permissionAnswers: { [FEATURES_Q]: 'Search, Sync' },
        },
      ]);
      renderChat('c-q-resolved-multi', vi.fn());

      expect(optionButton('Search').getAttribute('data-selected')).toBe('true');
      expect(optionButton('Sync').getAttribute('data-selected')).toBe('true');
      expect(optionButton('Export').getAttribute('data-selected')).toBe('false');
    });

    it('a free-text Other answer is shown read-only, since the live box only mounts while answerable', () => {
      seedChat('c-q-resolved-other', [
        {
          ...questionEntry('req-resolved-other', libraryArgs),
          permissionResolved: 'approve',
          permissionAnswers: { [LIB_Q]: 'Temporal, once it ships' },
        },
      ]);
      renderChat('c-q-resolved-other', vi.fn());

      expect(screen.getByTestId('question-other').getAttribute('data-selected')).toBe('true');
      expect(screen.queryByTestId('question-other-input')).toBeNull();
      expect(screen.getByTestId('question-other-answer').textContent).toBe(
        'Temporal, once it ships',
      );
    });

    it('a card the surface itself resolved keeps showing the answer after the store round-trips it (e.g. the host echo)', () => {
      const send = vi.fn();
      seedChat('c-q-resolved-roundtrip', [questionEntry('req-roundtrip', libraryArgs)]);
      renderChat('c-q-resolved-roundtrip', send);

      fireEvent.click(optionButton('date-fns'));
      fireEvent.click(screen.getByTestId('question-submit'));
      expect(optionButton('date-fns').getAttribute('data-selected')).toBe('true');

      // Simulate what a remount (leaving the chat and coming back, a reload)
      // does: a fresh component instance with none of the local `picked`
      // state, seeded from nothing but what the store persisted.
      cleanup();
      seedChat('c-q-resolved-roundtrip', [
        {
          ...questionEntry('req-roundtrip', libraryArgs),
          permissionResolved: 'approve',
          permissionAnswers: { [LIB_Q]: 'date-fns' },
        },
      ]);
      renderChat('c-q-resolved-roundtrip', vi.fn());

      expect(optionButton('date-fns').getAttribute('data-selected')).toBe('true');
    });
  });

  // The card is remounted far more often than it looks — `ChatRoute`'s
  // `key={chatId}` forces one on every chat switch, and a reload or a shifting
  // timeline key does the same. Selections lived only in the component, so an
  // open card came back blank; and because Send answer is disabled until every
  // question has an answer (spec/14), a card that emptied itself could not be
  // submitted AT ALL (Tom: "i answer and it never gets to the chat. on
  // returning, the form is reset").
  describe('an unanswered card keeps what was picked across a remount', () => {
    /** What leaving the chat and coming back does: a fresh component instance
     *  over the same, still-unresolved, store entry. */
    function remount(chatId: string, requestId: string, args: unknown, send = vi.fn()): void {
      cleanup();
      seedChat(chatId, [questionEntry(requestId, args)]);
      renderChat(chatId, send);
    }

    it('restores the selection, so Send answer is still live', () => {
      seedChat('c-q-draft', [questionEntry('req-draft', libraryArgs)]);
      renderChat('c-q-draft', vi.fn());

      fireEvent.click(optionButton('Luxon'));
      remount('c-q-draft', 'req-draft', libraryArgs);

      expect(optionButton('Luxon').getAttribute('data-selected')).toBe('true');
      expect(optionButton('date-fns').getAttribute('data-selected')).toBe('false');
      expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    it('the restored selection is what actually gets sent', () => {
      const send = vi.fn();
      seedChat('c-q-draft-send', [questionEntry('req-draft-send', libraryArgs)]);
      renderChat('c-q-draft-send', vi.fn());

      fireEvent.click(optionButton('Luxon'));
      remount('c-q-draft-send', 'req-draft-send', libraryArgs, send);
      fireEvent.click(screen.getByTestId('question-submit'));

      expect(sentFrames(send)[0]?.['editedNewString']).toBe(JSON.stringify({ [LIB_Q]: 'Luxon' }));
    });

    it('a half-answered two-question card comes back half-answered, not blank', () => {
      const send = vi.fn();
      seedChat('c-q-draft-two', [questionEntry('req-draft-two', twoQuestionArgs)]);
      renderChat('c-q-draft-two', vi.fn());

      // Only the first question — the exact state Send answer refuses to send.
      fireEvent.click(optionButton("Don't know"));
      expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(true);

      remount('c-q-draft-two', 'req-draft-two', twoQuestionArgs, send);

      expect(optionButton("Don't know").getAttribute('data-selected')).toBe('true');
      // Still incomplete, so still unsendable — but the first answer is not
      // lost, and answering the second is now enough to finish it.
      expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(optionButton('Leave blank'));
      fireEvent.click(screen.getByTestId('question-submit'));

      expect(sentFrames(send)[0]?.['editedNewString']).toBe(
        JSON.stringify({ [CONSENT_Q]: "Don't know", [IMPACT_Q]: 'Leave blank' }),
      );
    });

    it('restores a free-text Other answer into the live box', () => {
      seedChat('c-q-draft-other', [questionEntry('req-draft-other', libraryArgs)]);
      renderChat('c-q-draft-other', vi.fn());

      fireEvent.click(screen.getByTestId('question-other'));
      fireEvent.change(screen.getByTestId('question-other-input'), {
        target: { value: 'Temporal, once it ships' },
      });
      remount('c-q-draft-other', 'req-draft-other', libraryArgs);

      expect(screen.getByTestId('question-other').getAttribute('data-selected')).toBe('true');
      expect((screen.getByTestId('question-other-input') as HTMLTextAreaElement).value).toBe(
        'Temporal, once it ships',
      );
    });

    it('restores every pick of a multiSelect question', () => {
      seedChat('c-q-draft-multi', [questionEntry('req-draft-multi', multiArgs)]);
      renderChat('c-q-draft-multi', vi.fn());

      fireEvent.click(optionButton('Search'));
      fireEvent.click(optionButton('Sync'));
      remount('c-q-draft-multi', 'req-draft-multi', multiArgs);

      expect(optionButton('Search').getAttribute('data-selected')).toBe('true');
      expect(optionButton('Sync').getAttribute('data-selected')).toBe('true');
      expect(optionButton('Export').getAttribute('data-selected')).toBe('false');
    });

    it('taking a selection back leaves nothing to restore', () => {
      seedChat('c-q-draft-undo', [questionEntry('req-draft-undo', multiArgs)]);
      renderChat('c-q-draft-undo', vi.fn());

      fireEvent.click(optionButton('Search'));
      fireEvent.click(optionButton('Search')); // deselected again
      remount('c-q-draft-undo', 'req-draft-undo', multiArgs);

      expect(optionButton('Search').getAttribute('data-selected')).toBe('false');
      expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a sent answer drops its draft rather than leaving it behind', () => {
      seedChat('c-q-draft-spent', [questionEntry('req-draft-spent', libraryArgs)]);
      renderChat('c-q-draft-spent', vi.fn());

      fireEvent.click(optionButton('Luxon'));
      fireEvent.click(screen.getByTestId('question-submit'));

      expect(useQuestionDraftStore.getState().get('req-draft-spent')).toBeUndefined();
    });

    it('a cancelled card drops its draft too', () => {
      seedChat('c-q-draft-cancel', [questionEntry('req-draft-cancel', libraryArgs)]);
      renderChat('c-q-draft-cancel', vi.fn());

      fireEvent.click(optionButton('Luxon'));
      fireEvent.click(screen.getByTestId('question-cancel'));

      expect(useQuestionDraftStore.getState().get('req-draft-cancel')).toBeUndefined();
    });

    it('a draft is scoped to its own request, never applied to another question', () => {
      seedChat('c-q-draft-scope', [questionEntry('req-scope-a', libraryArgs)]);
      renderChat('c-q-draft-scope', vi.fn());
      fireEvent.click(optionButton('Luxon'));

      // A DIFFERENT request — a new question, which must start clean.
      remount('c-q-draft-scope', 'req-scope-b', libraryArgs);

      expect(optionButton('Luxon').getAttribute('data-selected')).toBe('false');
      expect((screen.getByTestId('question-submit') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

describe('AskUserQuestion and approve-all', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useQuestionDraftStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => cleanup());

  it('approve-all sweeps past a question rather than answering it blankly', () => {
    const send = vi.fn();
    // Two real approvals either side of the question: the sweep is only
    // offered when more than one request is outstanding (spec/14 § Permission
    // prompts), and a question is never one of them.
    seedChat('c-q-all', [
      questionEntry('req-q-all', libraryArgs),
      {
        seq: 2,
        kind: 'permission',
        tool: 'Bash',
        requestId: 'req-bash',
        permissionDescription: 'run ls',
        at: 0,
      },
      {
        seq: 3,
        kind: 'permission',
        tool: 'Edit',
        requestId: 'req-edit',
        permissionDescription: 'edit src/a.ts',
        at: 0,
      },
    ]);
    renderChat('c-q-all', send);

    fireEvent.click(screen.getAllByTestId('permission-approve-all')[0]!);

    // Only the two real approvals went out. The question is untouched and
    // still waiting for a real answer.
    expect(sentFrames(send)).toEqual([
      { type: 'chat.permission_response', chatId: 'c-q-all', requestId: 'req-bash', approve: true },
      { type: 'chat.permission_response', chatId: 'c-q-all', requestId: 'req-edit', approve: true },
    ]);
    expect(screen.getByTestId('question-card').getAttribute('data-resolved')).toBeNull();
  });

  it('a question alongside a single approval does not make a pair — no sweep is offered', () => {
    // The question is not sweepable, so one real request + one question is
    // still "one outstanding": offering a sweep here is the confusion.
    seedChat('c-q-one', [
      questionEntry('req-q-one', libraryArgs),
      { seq: 2, kind: 'permission', tool: 'Bash', requestId: 'req-lone', at: 0 },
    ]);
    renderChat('c-q-one', vi.fn());

    expect(screen.queryByTestId('permission-approve-all')).toBeNull();
  });
});

describe('AskUserQuestion tool rows', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useQuestionDraftStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => cleanup());

  it('renders the card alone — the call and result would repeat it', () => {
    // Tom: "askuserquestion shows as tool used and also the actual panel".
    seedChat('c-q-rows', [
      { ...questionEntry('req-rows', libraryArgs), permissionResolved: 'approve' },
      { seq: 2, kind: 'tool_call', tool: 'AskUserQuestion', callId: 'x1', at: 0 },
      {
        seq: 3,
        kind: 'tool_result',
        tool: 'AskUserQuestion',
        callId: 'x1',
        toolResult: 'User has answered your questions: date-fns',
        at: 0,
      },
    ]);
    renderChat('c-q-rows', vi.fn());

    expect(screen.getByTestId('question-card')).toBeDefined();
    expect(screen.queryByTestId('tool-call')).toBeNull();
    expect(screen.queryByTestId('tool-result')).toBeNull();
  });

  it('still shows a neighbouring tool run', () => {
    seedChat('c-q-rows-2', [
      { ...questionEntry('req-rows-2', libraryArgs), permissionResolved: 'approve' },
      { seq: 2, kind: 'tool_call', tool: 'AskUserQuestion', callId: 'x1', at: 0 },
      { seq: 3, kind: 'tool_result', tool: 'AskUserQuestion', callId: 'x1', at: 0 },
      {
        seq: 4,
        kind: 'tool_call',
        tool: 'Read',
        toolArgs: { file_path: '/a.ts' },
        callId: 'r1',
        at: 0,
      },
    ]);
    renderChat('c-q-rows-2', vi.fn());

    expect(screen.getByTestId('question-card')).toBeDefined();
    expect(screen.getAllByTestId('tool-call').length).toBe(1);
  });
});
