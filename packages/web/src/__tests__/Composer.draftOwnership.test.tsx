// spec/14 § Composer — the Composer half of "unsent text is owned by its chat":
// it seeds from the chat's stored draft, writes back as you type, drops the
// entry on a successful send, and KEEPS it when a send reports failure so the
// text is still there to retry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

/** Exactly how ChatRoute mounts it. */
function renderComposer(
  chatId: string,
  onSend: (message: string) => void | boolean | Promise<void | boolean>,
) {
  return render(
    <Composer
      key={chatId}
      chatId={chatId}
      daemonId="d1"
      onSend={onSend}
      initialValue={useComposerDraftStore.getState().get(chatId)}
      onValueChange={(t) => useComposerDraftStore.getState().setDraft(chatId, t)}
    />,
  );
}

describe('Composer — per-chat draft ownership', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    window.localStorage.clear();
    useComposerDraftStore.getState()._reset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('seeds the input from the chat s stored draft on mount', () => {
    useComposerDraftStore.getState().setDraft('c1', 'left here earlier');
    renderComposer('c1', () => {});
    expect(screen.getByTestId('composer-input')).toHaveValue('left here earlier');
  });

  it('writes what is typed back to that chat s entry', () => {
    renderComposer('c1', () => {});
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'typing' } });
    expect(useComposerDraftStore.getState().get('c1')).toBe('typing');
    expect(useComposerDraftStore.getState().get('c2')).toBe('');
  });

  it('a successful send clears the entry', () => {
    const onSend = vi.fn();
    renderComposer('c1', onSend);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'send me' } });
    fireEvent.submit(screen.getByTestId('composer'));

    expect(onSend).toHaveBeenCalledWith('send me');
    expect(useComposerDraftStore.getState().get('c1')).toBe('');
  });

  it('a ⌘↵ send clears the entry too', () => {
    const onSend = vi.fn();
    renderComposer('c1', onSend);
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'send me too' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });

    expect(onSend).toHaveBeenCalled();
    expect(useComposerDraftStore.getState().get('c1')).toBe('');
  });

  it('a send that FAILS keeps the text as this chat s draft', async () => {
    renderComposer('c1', () => Promise.resolve(false));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'will not land' } });
    fireEvent.submit(screen.getByTestId('composer'));

    await waitFor(() => expect(useComposerDraftStore.getState().get('c1')).toBe('will not land'));
    expect(screen.getByTestId('composer-input')).toHaveValue('will not land');
  });

  describe('server-owned live sync (spec/14 § Composer)', () => {
    it('a draft arriving from another surface appears live, with the composer never focused', () => {
      renderComposer('c1', () => {});
      expect(screen.getByTestId('composer-input')).toHaveValue('');
      act(() => {
        useComposerDraftStore.getState().applyDraftUpdated('c1', 'typed elsewhere', Date.now());
      });
      expect(screen.getByTestId('composer-input')).toHaveValue('typed elsewhere');
    });

    it('a focused composer is not clobbered by an incoming update — applied only on blur', () => {
      renderComposer('c1', () => {});
      const input = screen.getByTestId('composer-input');
      fireEvent.change(input, { target: { value: 'still typing' } });
      fireEvent.focus(input);

      useComposerDraftStore
        .getState()
        .applyDraftUpdated('c1', 'from another surface', Date.now() + 60_000);
      expect(input).toHaveValue('still typing');

      fireEvent.blur(input);
      expect(input).toHaveValue('from another surface');
    });

    it('a clear from another surface empties a non-focused composer', () => {
      useComposerDraftStore.getState().setDraft('c1', 'about to vanish');
      renderComposer('c1', () => {});
      act(() => {
        useComposerDraftStore.getState().applyDraftCleared('c1', Date.now());
      });
      expect(screen.getByTestId('composer-input')).toHaveValue('');
    });
  });
});
