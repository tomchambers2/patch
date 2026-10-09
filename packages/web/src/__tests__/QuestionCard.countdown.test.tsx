// spec/14 § Main chat panel — Question prompts: the countdown ring.
//
// Tom, App Updates: "patch should show a 1 minute timer on a question, slowly
// going down, a circle pie chart thing. so the user knows when it expires."
//
// The ring counts down to the HOST's deadline, carried on the request, not to
// a clock started when the card mounted — otherwise a chat opened halfway
// through the window, or one whose request was replayed after a reconnect,
// would show a full minute that is in fact half gone. These pin the arithmetic
// and the accessible name; the drawn geometry is measured in
// `e2e/question-countdown.spec.ts` and the CSS is locked in
// `questionExpirySettingStyles.test.ts`.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

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
  return render(<QuestionCard entry={entry(over)} onAnswer={vi.fn()} onCancel={vi.fn()} />);
}

/** The arc's remaining fraction, read back off the dash offset it was drawn with. */
function remainingFraction(): number {
  const fill = document.querySelector('.question-countdown-fill') as SVGCircleElement | null;
  expect(fill, 'the ring drew no depleting arc').not.toBeNull();
  const total = Number(fill?.getAttribute('stroke-dasharray'));
  const offset = Number(fill?.getAttribute('stroke-dashoffset'));
  expect(total).toBeGreaterThan(0);
  return 1 - offset / total;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the question card counts down to the host deadline', () => {
  it('opens full, naming the seconds left', () => {
    renderCard();
    const ring = screen.getByTestId('question-countdown');
    expect(ring).toHaveAttribute('data-seconds-left', '60');
    expect(ring).toHaveAttribute('data-expired', 'false');
    expect(ring).toHaveAccessibleName('60 seconds left to answer');
    expect(remainingFraction()).toBeCloseTo(1, 5);
  });

  it('depletes as the window runs down', () => {
    renderCard();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByTestId('question-countdown')).toHaveAttribute('data-seconds-left', '45');
    expect(remainingFraction()).toBeCloseTo(0.75, 2);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByTestId('question-countdown')).toHaveAttribute('data-seconds-left', '15');
    expect(remainingFraction()).toBeCloseTo(0.25, 2);
  });

  it('says a single second in the singular', () => {
    renderCard();
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(screen.getByTestId('question-countdown')).toHaveAccessibleName(
      '1 second left to answer',
    );
  });

  it('opens PART-DEPLETED on a card drawn halfway through the window', () => {
    // The chat was opened 45s after the question was asked, or the request was
    // replayed to a surface that reconnected. A ring that started full here
    // would promise time that has already gone.
    renderCard({ permissionExpiry: { at: NOW + 15_000, windowMs: WINDOW_MS } });
    expect(screen.getByTestId('question-countdown')).toHaveAttribute('data-seconds-left', '15');
    expect(remainingFraction()).toBeCloseTo(0.25, 2);
  });

  it('stops at empty and says so, without resolving the card itself', () => {
    // NO FALLBACK: only the host resolves a request. A card that flipped
    // itself to "Cancelled" on its own clock would be showing a decision
    // nobody made, for a question that may be answered a moment later.
    const { container } = renderCard();
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS + 5_000);
    });
    const ring = screen.getByTestId('question-countdown');
    expect(ring).toHaveAttribute('data-expired', 'true');
    expect(ring).toHaveAttribute('data-seconds-left', '0');
    expect(ring).toHaveAccessibleName('question expired');
    expect(remainingFraction()).toBeCloseTo(0, 5);
    expect(screen.queryByTestId('permission-outcome')).toBeNull();
    expect(container.querySelector('[data-testid="question-card"]')).not.toHaveAttribute(
      'data-resolved',
    );
    // …and the options are still answerable, because the resolution has not
    // landed yet.
    for (const opt of screen.getAllByTestId('question-option')) {
      expect(opt).not.toBeDisabled();
    }
  });

  it('draws no ring at all for a question that will never expire', () => {
    // Expiry turned off on the host: the request carries no deadline, and an
    // invented one would be a countdown to nothing.
    renderCard({ permissionExpiry: undefined });
    expect(screen.queryByTestId('question-countdown')).toBeNull();
  });

  it('drops the ring once the card is answered', () => {
    renderCard({ permissionResolved: 'approve' });
    expect(screen.queryByTestId('question-countdown')).toBeNull();
    expect(screen.getByTestId('permission-outcome')).toHaveTextContent('Answered');
  });

  it('still shows the ring on a question this app could not read', () => {
    // Unreadable, but still on the clock — how long is left to cancel it is
    // the one honest thing that card can say.
    renderCard({ toolArgs: { prompt: 'not the documented shape' } });
    expect(screen.getByTestId('question-parse-error')).toBeInTheDocument();
    expect(screen.getByTestId('question-countdown')).toHaveAttribute('data-seconds-left', '60');
  });

  it('leaves the roving tabindex alone — the ring is not a stop on it', () => {
    // The keyboard journey is `QuestionCard.keyboard.test.tsx`'s subject; what
    // matters here is that adding the ring did not put a new element into it.
    renderCard();
    const ring = screen.getByTestId('question-countdown');
    expect(ring).not.toHaveAttribute('tabindex');
    expect(ring.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // The cursor still lands on the first option, not on the ring.
    expect(document.activeElement).toBe(screen.getAllByTestId('question-option')[0]);
  });
});
