// spec/14 § Main chat panel — Question prompts: the countdown ring, ported to
// mobile (parity with `packages/web/src/__tests__/QuestionCard.countdown.test.tsx`).
//
// The ring counts down to the HOST's deadline, carried on the request, not to
// a clock started when the card mounted.

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderRN, findHost, queryHost, byTestId } from './testUtils/render';
import { QuestionCard } from '../src/components/QuestionCard';
import type { ChatEventEntry } from '../src/stores/chatStore';

const QUESTION = 'Which date library should we use?';
const NOW = 1_700_000_000_000;
const WINDOW_MS = 60_000;

const questions = [
  {
    header: 'Library',
    question: QUESTION,
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'Tree-shakeable, function per format.' },
      { label: 'Luxon', description: 'Rich zone handling, bigger bundle.' },
    ],
  },
];

function entry(over: Partial<ChatEventEntry> = {}): ChatEventEntry {
  return {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-countdown',
    toolArgs: { questions },
    at: 0,
    permissionExpiry: { at: NOW + WINDOW_MS, windowMs: WINDOW_MS },
    ...over,
  };
}

function renderCard(over: Partial<ChatEventEntry> = {}) {
  return renderRN(<QuestionCard entry={entry(over)} onAnswer={vi.fn()} onCancel={vi.fn()} />);
}

/** The ring's remaining fraction, read back off the dash offset it was drawn with. */
function remainingFraction(root: ReturnType<typeof renderCard>['root']): number {
  const fill = findHost(root, byTestId('question-countdown-fill'));
  const total = Number(fill.props['strokeDasharray']);
  const offset = Number(fill.props['strokeDashoffset']);
  expect(total).toBeGreaterThan(0);
  return 1 - offset / total;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the mobile question card counts down to the host deadline', () => {
  it('opens full, naming the seconds left', () => {
    const r = renderCard();
    const ring = findHost(r.root, byTestId('question-countdown'));
    expect(ring.props['accessibilityLabel']).toBe('60 seconds left to answer');
    expect(remainingFraction(r.root)).toBeCloseTo(1, 5);
  });

  it('depletes as the window runs down', () => {
    const r = renderCard();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(findHost(r.root, byTestId('question-countdown')).props['accessibilityLabel']).toBe(
      '45 seconds left to answer',
    );
    expect(remainingFraction(r.root)).toBeCloseTo(0.75, 2);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(findHost(r.root, byTestId('question-countdown')).props['accessibilityLabel']).toBe(
      '15 seconds left to answer',
    );
    expect(remainingFraction(r.root)).toBeCloseTo(0.25, 2);
  });

  it('says a single second in the singular', () => {
    const r = renderCard();
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(findHost(r.root, byTestId('question-countdown')).props['accessibilityLabel']).toBe(
      '1 second left to answer',
    );
  });

  it('opens PART-DEPLETED on a card drawn halfway through the window', () => {
    const r = renderCard({ permissionExpiry: { at: NOW + 15_000, windowMs: WINDOW_MS } });
    expect(findHost(r.root, byTestId('question-countdown')).props['accessibilityLabel']).toBe(
      '15 seconds left to answer',
    );
    expect(remainingFraction(r.root)).toBeCloseTo(0.25, 2);
  });

  it('stops at empty and says so, without resolving the card itself', () => {
    const r = renderCard();
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS + 5_000);
    });
    const ring = findHost(r.root, byTestId('question-countdown'));
    expect(ring.props['accessibilityLabel']).toBe('question expired');
    expect(remainingFraction(r.root)).toBeCloseTo(0, 5);
    expect(queryHost(r.root, byTestId('permission-outcome'))).toBeNull();
  });

  it('draws no ring at all for a question that will never expire', () => {
    const r = renderCard({ permissionExpiry: undefined });
    expect(queryHost(r.root, byTestId('question-countdown'))).toBeNull();
  });

  it('drops the ring once the card is answered', () => {
    const r = renderCard({ permissionResolved: 'approve' });
    expect(queryHost(r.root, byTestId('question-countdown'))).toBeNull();
    expect(findHost(r.root, byTestId('permission-outcome'))).toBeTruthy();
  });

  it('still shows the ring on a question this app could not read', () => {
    const r = renderCard({ toolArgs: { prompt: 'not the documented shape' } });
    expect(findHost(r.root, byTestId('question-parse-error'))).toBeTruthy();
    expect(findHost(r.root, byTestId('question-countdown')).props['accessibilityLabel']).toBe(
      '60 seconds left to answer',
    );
  });
});
