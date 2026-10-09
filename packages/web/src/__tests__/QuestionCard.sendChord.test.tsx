// spec/14 § Main chat panel — Question prompts.
//
// Tom, App Updates: "patch show CMD + enter (or windows version) on the answer
// question button, since enter is newline". The `Other` box is the one field in
// the app where `↵` does NOT send, and the button said only "Send answer" — so
// the send key was unguessable from the card. These pin that the button names
// the chord, that the chord follows the BROWSER'S keyboard (not any host), and
// that the glyphs stay out of the accessible name.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const QUESTION = 'Which date library should we use?';

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

function renderCard() {
  const entry: ChatEventEntry = {
    seq: 1,
    kind: 'permission',
    tool: 'AskUserQuestion',
    requestId: 'req-chord',
    toolArgs: { questions },
    at: 0,
  };
  return render(<QuestionCard entry={entry} onAnswer={vi.fn()} onCancel={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QuestionCard — the Send answer button names its chord', () => {
  it('shows ⌘↵ on a Mac keyboard', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } } as never);
    renderCard();
    const submit = screen.getByTestId('question-submit');
    expect(submit.textContent).toContain('Send answer');
    expect(submit.textContent).toContain('⌘↵');
    expect(submit.textContent).not.toContain('Ctrl');
  });

  it('shows Ctrl+Enter on a Windows keyboard', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' } } as never);
    renderCard();
    const submit = screen.getByTestId('question-submit');
    expect(submit.textContent).toContain('Ctrl+Enter');
    expect(submit.textContent).not.toContain('⌘');
  });

  it('draws the chord as decoration and says it in words in the accessible name', () => {
    // Glyphs read aloud are noise, and the button still has to be findable as
    // "Send answer" — same aria-hidden split the option indicators use.
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } } as never);
    renderCard();
    const submit = screen.getByTestId('question-submit');
    const chord = submit.querySelector('[data-testid="question-submit-chord"]');
    expect(chord).not.toBeNull();
    expect(chord?.getAttribute('aria-hidden')).toBe('true');
    expect(submit.getAttribute('aria-label')).toBe('Send answer, Command-Enter');
    expect(screen.getByRole('button', { name: 'Send answer, Command-Enter' })).toBe(submit);
  });

  it('never leaves the chord blank when the browser says nothing', () => {
    vi.stubGlobal('navigator', {} as never);
    renderCard();
    expect(screen.getByTestId('question-submit-chord').textContent).toBe('Ctrl+Enter');
  });
});
