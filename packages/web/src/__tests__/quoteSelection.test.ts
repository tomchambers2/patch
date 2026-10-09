// Document editor (spec/14 § Document editor — Working with the agent):
// selection-to-ask attaches the selection to the chat by quoting it into the
// chat's own composer draft.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { withQuotedSelection, quoteSelectionIntoComposer } from '../lib/quoteSelection.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { setActiveWs } from '../api/ws.js';

describe('withQuotedSelection', () => {
  it('quotes each line of the selection with "> "', () => {
    expect(withQuotedSelection('', 'line one\nline two')).toBe('> line one\n> line two\n\n');
  });

  it('appends after existing draft text, trimming its trailing whitespace', () => {
    expect(withQuotedSelection('already typed  \n', 'quoted')).toBe(
      'already typed\n\n> quoted\n\n',
    );
  });
});

describe('quoteSelectionIntoComposer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setActiveWs(null);
    vi.useFakeTimers();
    useComposerDraftStore.getState()._reset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setActiveWs(null);
  });

  it('sets the composer draft for the given chat from nothing', () => {
    quoteSelectionIntoComposer('chat-1', 'a passage');
    expect(useComposerDraftStore.getState().get('chat-1')).toBe('> a passage\n\n');
  });

  it('appends to an existing draft for that chat', () => {
    useComposerDraftStore.getState().setDraft('chat-1', 'what about this');
    quoteSelectionIntoComposer('chat-1', 'a passage');
    expect(useComposerDraftStore.getState().get('chat-1')).toBe(
      'what about this\n\n> a passage\n\n',
    );
  });
});
