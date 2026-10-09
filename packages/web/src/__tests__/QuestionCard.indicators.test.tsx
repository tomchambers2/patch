// spec/14 § Main chat panel — Question prompts.
//
// Tom, App Updates: "patch multi select for questions is not clear". A
// `multiSelect: true` question drew exactly like a single-select one — the same
// outlined rows, the difference carried only by `role` and by what clicking a
// second option did. A screen reader was told; a sighted user was not, so the
// first pick was the whole answer to a question that wanted several.
//
// The fix is a real selection indicator per option: a square with a tick for
// multi-select, a circle with a filled dot for single-select. These pin the
// mechanism — which indicator each mode draws, that it is decoration the
// accessible name never sees, and that it tracks the selection. The painted
// shapes are proved in e2e/question-card-multiselect.spec.ts, in both themes.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const LIB_Q = 'Which date library should we use?';
const FEATURES_Q = 'Which features do you want enabled?';

const singleQuestion = {
  header: 'Library',
  question: LIB_Q,
  multiSelect: false,
  options: [
    { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
    { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
  ],
};

const multiQuestion = {
  header: 'Features',
  question: FEATURES_Q,
  multiSelect: true,
  options: [
    { label: 'Search', description: 'Full-text search over chats.' },
    { label: 'Export', description: 'Download a transcript.' },
  ],
};

function renderCard(questions: unknown[]) {
  const entry: ChatEventEntry = {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-ind',
    toolArgs: { questions },
    at: 0,
  };
  return render(<QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} />);
}

/** Every answer row of one question, in render order: its options then `Other`. */
function rowsOf(questionText: string): HTMLElement[] {
  const group = document.querySelector<HTMLElement>(
    `.question-options[aria-label="${questionText}"]`,
  );
  expect(group).not.toBeNull();
  return Array.from((group as HTMLElement).querySelectorAll<HTMLElement>('button.question-option'));
}

/** The decorative indicator a row draws, as its kind and its drawn state. */
function indicatorOf(row: HTMLElement): { kind: string | null; checked: string | null } {
  const mark = row.querySelector<HTMLElement>('.question-indicator');
  expect(mark).not.toBeNull();
  return {
    kind: (mark as HTMLElement).getAttribute('data-indicator'),
    checked: (mark as HTMLElement).getAttribute('data-checked'),
  };
}

afterEach(cleanup);

describe('a question says on screen how many answers it takes', () => {
  it('draws a checkbox on every row of a multiSelect question, Other included', () => {
    renderCard([multiQuestion]);
    const rows = rowsOf(FEATURES_Q);
    // Two options plus the `Other` escape hatch — which is one of the options
    // and must not be the one row that keeps the old undifferentiated look.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => indicatorOf(r).kind)).toEqual(['checkbox', 'checkbox', 'checkbox']);
    expect(rows.at(-1)).toBe(screen.getByTestId('question-other'));
  });

  it('draws a radio on each option of a single-select question and on Other too', () => {
    renderCard([singleQuestion]);
    const rows = rowsOf(LIB_Q);
    expect(rows).toHaveLength(3);
    // Other is one more radio: choosing it deselects the rest.
    expect(rows.map((r) => indicatorOf(r).kind)).toEqual(['radio', 'radio', 'radio']);
    expect(rows.at(-1)?.getAttribute('role')).toBe('radio');
  });

  it('gives the two modes different indicators on the same card', () => {
    renderCard([singleQuestion, multiQuestion]);
    expect(indicatorOf(rowsOf(LIB_Q)[0] as HTMLElement).kind).toBe('radio');
    expect(indicatorOf(rowsOf(FEATURES_Q)[0] as HTMLElement).kind).toBe('checkbox');
  });

  it('is decoration only: the state is on the button, not duplicated into the name', () => {
    renderCard([multiQuestion]);
    const row = rowsOf(FEATURES_Q)[0] as HTMLElement;
    const mark = row.querySelector('.question-indicator') as HTMLElement;
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    // The accessible name is still the label and the trade-off beneath it —
    // the indicator adds no text and no second copy of "checked".
    expect(screen.getByRole('checkbox', { name: /Search/ })).toBe(row);
    expect(mark.textContent).toBe('');
    expect(row.textContent).toBe('SearchFull-text search over chats.');
  });
});

describe('the indicator tracks the selection', () => {
  it('fills and empties again as a multiSelect option is toggled', () => {
    renderCard([multiQuestion]);
    const [search, exportRow] = rowsOf(FEATURES_Q) as [HTMLElement, HTMLElement];
    expect(indicatorOf(search).checked).toBe('false');

    fireEvent.click(search);
    expect(indicatorOf(search).checked).toBe('true');

    // Multi-select accumulates: the second pick does not put the first away.
    fireEvent.click(exportRow);
    expect(indicatorOf(search).checked).toBe('true');
    expect(indicatorOf(exportRow).checked).toBe('true');

    fireEvent.click(search);
    expect(indicatorOf(search).checked).toBe('false');
    expect(indicatorOf(exportRow).checked).toBe('true');
  });

  it('moves the mark rather than adding one in a single-select question', () => {
    renderCard([singleQuestion]);
    const [dateFns, luxon, other] = rowsOf(LIB_Q) as [HTMLElement, HTMLElement, HTMLElement];

    fireEvent.click(dateFns);
    expect(indicatorOf(dateFns).checked).toBe('true');

    fireEvent.click(luxon);
    expect(indicatorOf(dateFns).checked).toBe('false');
    expect(indicatorOf(luxon).checked).toBe('true');

    // `Other` is a radio too: choosing it deselects the pick, and back again.
    fireEvent.click(other);
    expect(indicatorOf(luxon).checked).toBe('false');
    expect(indicatorOf(other).checked).toBe('true');

    fireEvent.click(dateFns);
    expect(indicatorOf(other).checked).toBe('false');
    expect(indicatorOf(dateFns).checked).toBe('true');
  });
});
