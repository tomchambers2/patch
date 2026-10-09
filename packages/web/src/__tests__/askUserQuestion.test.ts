// `AskUserQuestion` argument parsing (spec/14 § Main chat panel — Question
// prompts). NO FALLBACK: a shape that is not the tool's own is rejected
// outright rather than half-rendered, because a question the user answers
// against the wrong options is worse than one the card refuses to draw.

import { describe, it, expect } from 'vitest';
import {
  isQuestionRowCoveredByCard,
  joinAnswer,
  parseAskUserQuestion,
  parseStoredAnswer,
} from '../lib/askUserQuestion.js';

const good = {
  questions: [
    {
      header: 'Library',
      question: 'Which one?',
      multiSelect: false,
      options: [
        { label: 'a', description: 'the a' },
        { label: 'b', description: 'the b' },
      ],
    },
  ],
};

describe('parseAskUserQuestion', () => {
  it("parses the tool's documented shape", () => {
    expect(parseAskUserQuestion(good)).toEqual([
      {
        header: 'Library',
        question: 'Which one?',
        multiSelect: false,
        options: [
          { label: 'a', description: 'the a' },
          { label: 'b', description: 'the b' },
        ],
      },
    ]);
  });

  it('treats a missing multiSelect as single-select', () => {
    const q = { questions: [{ ...good.questions[0], multiSelect: undefined }] };
    expect(parseAskUserQuestion(q)?.[0]?.multiSelect).toBe(false);
  });

  it('tolerates an option with no description (the label still stands alone)', () => {
    const q = { questions: [{ ...good.questions[0], options: [{ label: 'a' }, { label: 'b' }] }] };
    expect(parseAskUserQuestion(q)?.[0]?.options).toEqual([
      { label: 'a', description: '' },
      { label: 'b', description: '' },
    ]);
  });

  const rejected: Array<[string, unknown]> = [
    ['non-object args', 'nope'],
    ['null args', null],
    ['no questions key', {}],
    ['questions that is not an array', { questions: {} }],
    ['an empty questions array', { questions: [] }],
    ['a non-object question', { questions: ['what?'] }],
    ['a question with no text', { questions: [{ header: 'h', options: [{ label: 'a' }] }] }],
    ['an empty question text', { questions: [{ header: 'h', question: '', options: [] }] }],
    [
      'a non-string header',
      { questions: [{ header: 1, question: 'q', options: [{ label: 'a' }] }] },
    ],
    ['a question with no options', { questions: [{ header: 'h', question: 'q' }] }],
    [
      'a question with an empty options array',
      { questions: [{ header: 'h', question: 'q', options: [] }] },
    ],
    ['a non-object option', { questions: [{ header: 'h', question: 'q', options: ['a'] }] }],
    [
      'an option with no label',
      { questions: [{ header: 'h', question: 'q', options: [{ description: 'd' }] }] },
    ],
  ];

  for (const [label, args] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseAskUserQuestion(args)).toBeNull();
    });
  }
});

describe('joinAnswer', () => {
  it('renders a single-select answer as the bare label', () => {
    expect(joinAnswer(['date-fns'])).toBe('date-fns');
  });

  it('joins a multi-select answer with the comma separator the tool schema implies', () => {
    expect(joinAnswer(['Search', 'Sync'])).toBe('Search, Sync');
  });
});

describe('parseStoredAnswer', () => {
  const dateFnsOrLuxon = [
    { label: 'date-fns', description: '' },
    { label: 'Luxon', description: '' },
  ];
  const searchOrSync = [
    { label: 'Search', description: '' },
    { label: 'Sync', description: '' },
  ];

  it('is the inverse of joinAnswer for a single-select option', () => {
    expect(parseStoredAnswer('Luxon', dateFnsOrLuxon, false)).toEqual({
      picked: ['Luxon'],
      other: null,
    });
  });

  it('splits a single-select answer into its option plus the text added to it', () => {
    const opts = [
      { label: 'date-fns', description: '' },
      { label: 'Luxon', description: '' },
    ];
    expect(parseStoredAnswer('Luxon, also Temporal', opts, false)).toEqual({
      picked: ['Luxon'],
      other: 'also Temporal',
    });
  });

  it('treats a single-select answer matching no option as free-text Other', () => {
    expect(parseStoredAnswer('Temporal', dateFnsOrLuxon, false)).toEqual({
      picked: [],
      other: 'Temporal',
    });
  });

  it('reads a bare single-select Other answer as Other with no comment', () => {
    expect(parseStoredAnswer('Other', dateFnsOrLuxon, false)).toEqual({ picked: [], other: '' });
  });

  it('is the inverse of joinAnswer for a multiSelect answer with no Other', () => {
    expect(parseStoredAnswer('Search, Sync', searchOrSync, true)).toEqual({
      picked: ['Search', 'Sync'],
      other: null,
    });
  });

  it('splits a multiSelect answer into its known options plus a trailing Other', () => {
    expect(parseStoredAnswer('Search, once it ships', searchOrSync, true)).toEqual({
      picked: ['Search'],
      other: 'once it ships',
    });
  });

  it('treats a multiSelect answer of Other alone as free-text with no options picked', () => {
    expect(parseStoredAnswer('Temporal', searchOrSync, true)).toEqual({
      picked: [],
      other: 'Temporal',
    });
  });
});

describe('isQuestionRowCoveredByCard', () => {
  const card = {
    kind: 'permission',
    tool: 'AskUserQuestion',
    seq: 1,
    permissionResolved: 'approve',
  };
  const call = { kind: 'tool_call', tool: 'AskUserQuestion', seq: 2 };
  const result = { kind: 'tool_result', tool: 'AskUserQuestion', seq: 3 };

  it('covers the call and the result the card already renders', () => {
    const timeline = [card, call, result];
    expect(isQuestionRowCoveredByCard(call, timeline)).toBe(true);
    expect(isQuestionRowCoveredByCard(result, timeline)).toBe(true);
  });

  it('leaves the card itself alone', () => {
    expect(isQuestionRowCoveredByCard(card, [card, call, result])).toBe(false);
  });

  it('leaves every other tool alone', () => {
    const read = { kind: 'tool_call', tool: 'Read', seq: 2 };
    expect(isQuestionRowCoveredByCard(read, [card, read])).toBe(false);
  });

  it('shows the tool rows when no card was ever rendered', () => {
    // NO FALLBACK: with no permission request in the timeline the tool rows are
    // the only trace of the run, so hiding them would lose it entirely.
    expect(isQuestionRowCoveredByCard(call, [call, result])).toBe(false);
  });

  it('does not let a LATER question card hide an earlier run', () => {
    const later = { kind: 'permission', tool: 'AskUserQuestion', seq: 9 };
    expect(isQuestionRowCoveredByCard(call, [call, result, later])).toBe(false);
  });

  it('keeps the result of a question that was never answered — it says why', () => {
    // A user cancel and a question that expired unanswered are both a plain
    // `deny` on the wire, so the card can only say "Cancelled"; the tool
    // result is the only place the reason appears.
    const denied = {
      kind: 'permission',
      tool: 'AskUserQuestion',
      seq: 1,
      permissionResolved: 'deny',
    };
    expect(isQuestionRowCoveredByCard(call, [denied, call, result])).toBe(true);
    expect(isQuestionRowCoveredByCard(result, [denied, call, result])).toBe(false);
  });
});
