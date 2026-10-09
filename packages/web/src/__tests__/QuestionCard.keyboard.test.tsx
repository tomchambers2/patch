// spec/14 § Main chat panel — Question prompts. Tom, App Updates: "patch ask a
// question tab should go between questions with arrow keys within the answers".
//
// The card is a roving-tabindex group: exactly ONE option per question is in
// the Tab sequence, so Tab steps question-to-question, and the arrow keys move
// between the focused question's own options. These pin the mechanism — which
// option carries `tabIndex=0`, where the cursor lands, and that moving never
// chooses. The real browser's own Tab/Enter/Space behaviour (which jsdom does
// not implement) is proved in e2e/question-card-keyboard.spec.ts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const LIB_Q = 'Which date library should we use?';
const SCOPE_Q = 'Where should it be applied?';
const FEATURES_Q = 'Which features do you want enabled?';

const libraryQuestion = {
  header: 'Library',
  question: LIB_Q,
  multiSelect: false,
  options: [
    { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
    { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
  ],
};

const scopeQuestion = {
  header: 'Scope',
  question: SCOPE_Q,
  multiSelect: false,
  options: [
    { label: 'Everywhere', description: 'All surfaces at once.' },
    { label: 'Web only', description: 'Leave mobile alone for now.' },
  ],
};

const featuresQuestion = {
  header: 'Features',
  question: FEATURES_Q,
  multiSelect: true,
  options: [
    { label: 'Search', description: 'Full-text search over chats.' },
    { label: 'Export', description: 'Download a transcript.' },
    { label: 'Sync', description: 'Cross-device sync.' },
  ],
};

function entry(questions: unknown[], resolved?: 'approve' | 'deny'): ChatEventEntry {
  return {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-kbd',
    toolArgs: { questions },
    at: 0,
    ...(resolved ? { permissionResolved: resolved } : {}),
  };
}

function renderCard(questions: unknown[], resolved?: 'approve' | 'deny') {
  return render(
    <QuestionCard entry={entry(questions, resolved)} onAnswer={vi.fn()} onCancel={vi.fn()} />,
  );
}

/** Every focusable answer of one question, in render order: its options then `Other`. */
function answersOf(questionText: string): HTMLElement[] {
  const group = document.querySelector<HTMLElement>(
    `.question-options[aria-label="${questionText}"]`,
  );
  expect(group).not.toBeNull();
  return Array.from((group as HTMLElement).querySelectorAll<HTMLElement>('button.question-option'));
}

/** The index of the option carrying this question's single Tab stop. */
function tabStop(questionText: string): number {
  return answersOf(questionText).findIndex((b) => b.getAttribute('tabindex') === '0');
}

function press(key: string, init: Record<string, unknown> = {}): void {
  fireEvent.keyDown(document.activeElement as HTMLElement, { key, ...init });
}

describe('answering a question card from the keyboard', () => {
  afterEach(() => cleanup());

  it('gives each question exactly one Tab stop, so Tab steps question-to-question', () => {
    renderCard([libraryQuestion, scopeQuestion]);

    // Three answers per question (two options + Other) but ONE tabbable each —
    // that is what makes the next Tab land on the next QUESTION rather than on
    // this question's second option.
    for (const q of [LIB_Q, SCOPE_Q]) {
      const answers = answersOf(q);
      expect(answers).toHaveLength(3);
      expect(answers.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
      expect(answers.filter((b) => b.getAttribute('tabindex') === '-1')).toHaveLength(2);
      expect(tabStop(q)).toBe(0);
    }
  });

  it('puts the cursor on the first option when the card appears', () => {
    renderCard([libraryQuestion, scopeQuestion]);

    expect(document.activeElement).toBe(answersOf(LIB_Q)[0]);
    // Not the card: landing on the group would need a Tab before the arrows do
    // anything at all.
    expect(document.activeElement).not.toBe(screen.getByTestId('question-card'));
  });

  it("↓ moves to the next answer and hands it the question's Tab stop", () => {
    renderCard([libraryQuestion, scopeQuestion]);
    const answers = answersOf(LIB_Q);

    press('ArrowDown');

    expect(document.activeElement).toBe(answers[1]);
    expect(tabStop(LIB_Q)).toBe(1);
    expect(answers[0]?.getAttribute('tabindex')).toBe('-1');
  });

  it('↑/↓ wrap at both ends, and Other is one of the answers they reach', () => {
    renderCard([libraryQuestion]);
    const answers = answersOf(LIB_Q);
    expect(answers[2]).toBe(screen.getByTestId('question-other'));

    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(answers[2]);

    // Past the last answer, back to the first.
    press('ArrowDown');
    expect(document.activeElement).toBe(answers[0]);

    // ...and backwards off the first, round to the last.
    press('ArrowUp');
    expect(document.activeElement).toBe(answers[2]);
  });

  it('→/← move too, so the card does not depend on knowing which axis it drew', () => {
    renderCard([libraryQuestion]);
    const answers = answersOf(LIB_Q);

    press('ArrowRight');
    expect(document.activeElement).toBe(answers[1]);
    press('ArrowLeft');
    expect(document.activeElement).toBe(answers[0]);
  });

  it('Home and End jump to the first and last answer', () => {
    renderCard([libraryQuestion]);
    const answers = answersOf(LIB_Q);

    press('End');
    expect(document.activeElement).toBe(answers[2]);
    press('Home');
    expect(document.activeElement).toBe(answers[0]);
  });

  it('keeps the arrows inside the focused question', () => {
    renderCard([libraryQuestion, scopeQuestion]);

    // Walk the first question all the way round.
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(answersOf(LIB_Q)[0]);
    // The second question is untouched — its Tab stop is still its first
    // option, waiting for the Tab that reaches it.
    expect(tabStop(SCOPE_Q)).toBe(0);
  });

  it('moving the cursor does not choose the answer it passes over', () => {
    renderCard([libraryQuestion]);
    const answers = answersOf(LIB_Q);

    press('ArrowDown');
    press('ArrowDown');

    // Nothing selected — including `Other`, whose free-text box would otherwise
    // have opened and taken the cursor as the arrows passed over it.
    for (const b of answers) expect(b.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('question-other-input')).toBeNull();
    expect(screen.getByTestId('question-submit')).toBeDisabled();
  });

  it('activating the focused answer still selects it, and single-select still clears', () => {
    renderCard([libraryQuestion]);
    const answers = answersOf(LIB_Q);

    press('ArrowDown');
    // ↵/Space on a focused button is a click; jsdom does not synthesise that,
    // so the activation is fired directly (e2e proves the real key).
    fireEvent.click(document.activeElement as HTMLElement);
    expect(answers[1]?.getAttribute('data-selected')).toBe('true');
    expect(screen.getByTestId('question-submit')).toBeEnabled();

    press('ArrowUp');
    fireEvent.click(document.activeElement as HTMLElement);
    expect(answers[0]?.getAttribute('data-selected')).toBe('true');
    expect(answers[1]?.getAttribute('data-selected')).toBe('false');
  });

  it('multi-select keeps every answer the cursor stopped on and chose', () => {
    renderCard([featuresQuestion]);
    const answers = answersOf(FEATURES_Q);

    fireEvent.click(document.activeElement as HTMLElement); // Search
    press('ArrowDown');
    press('ArrowDown');
    fireEvent.click(document.activeElement as HTMLElement); // Sync

    expect(answers[0]?.getAttribute('data-selected')).toBe('true');
    expect(answers[1]?.getAttribute('data-selected')).toBe('false');
    expect(answers[2]?.getAttribute('data-selected')).toBe('true');
    expect(tabStop(FEATURES_Q)).toBe(2);
  });

  it("a click makes the clicked answer the question's Tab stop", () => {
    renderCard([libraryQuestion, scopeQuestion]);

    const luxon = answersOf(LIB_Q)[1] as HTMLElement;
    fireEvent.focus(luxon);
    fireEvent.click(luxon);

    expect(tabStop(LIB_Q)).toBe(1);
    expect(tabStop(SCOPE_Q)).toBe(0);
  });

  it('leaves a modified arrow alone — ⌘↑/⌘↓ step chat rows', () => {
    renderCard([libraryQuestion]);
    const answers = answersOf(LIB_Q);

    const handled = fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
      metaKey: true,
    });

    // Not consumed (nothing called preventDefault) and the cursor has not moved.
    expect(handled).toBe(true);
    expect(document.activeElement).toBe(answers[0]);
  });

  it('a resolved card is inert: nothing focusable, and no cursor grab', () => {
    renderCard([libraryQuestion], 'approve');

    for (const b of answersOf(LIB_Q)) expect(b).toBeDisabled();
    expect(document.activeElement).toBe(document.body);
  });
});
