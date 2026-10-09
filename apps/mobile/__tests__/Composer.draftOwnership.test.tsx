// spec/15 § Composer — unsent composer text is OWNED by the chat it was typed
// in (same contract as web, spec/14 § Composer): re-opening that chat restores
// it, another chat never shows it, a successful send drops it, and it survives
// the app being killed because it lives in MMKV.
//
// deliveryTracker.submit is spied out: this is about what the composer keeps,
// not about delivery.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findHost, byLabel, byType, renderRN, update } from './testUtils/render';
import {
  usePresenceStore,
  type ConnectionState,
  type DaemonPresence,
} from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';
import {
  getComposerDraft,
  setComposerDraft,
  clearComposerDraft,
  useComposerDraftStore,
} from '../src/lib/composerDraft';

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
  },
}));

import { Composer } from '../src/components/Composer';

function setPresence(connection: ConnectionState, daemon: DaemonPresence): void {
  usePresenceStore.setState({ connection, daemon, accountId: null, surfaceId: null });
}

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  setPresence('connected', 'online');
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
});

describe('composerDraft store', () => {
  it('keeps one entry per chat and reads back exactly what was typed', () => {
    setComposerDraft('c1', 'text for one');
    setComposerDraft('c2', 'text for two');
    expect(getComposerDraft('c1')).toBe('text for one');
    expect(getComposerDraft('c2')).toBe('text for two');
  });

  it('a chat with nothing typed reads empty, never another chat s text', () => {
    setComposerDraft('c1', 'text for one');
    expect(getComposerDraft('c_never_typed_in')).toBe('');
  });

  it('emptying the composer drops the entry rather than storing an empty string', () => {
    setComposerDraft('c1', 'typed');
    setComposerDraft('c1', '');
    expect(getComposerDraft('c1')).toBe('');
  });

  it('clearDraft drops only the named chat', () => {
    setComposerDraft('c1', 'one');
    setComposerDraft('c2', 'two');
    clearComposerDraft('c1');
    expect(getComposerDraft('c1')).toBe('');
    expect(getComposerDraft('c2')).toBe('two');
  });
});

describe('Composer — per-chat draft ownership', () => {
  it('seeds the input from the chat s stored draft', () => {
    setComposerDraft('c1', 'left here earlier');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('left here earlier');
  });

  it('writes what is typed back to that chat s entry, and only that one', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('unsent for c1');
    update(r, <Composer chatId="c1" folder="work" />);

    expect(getComposerDraft('c1')).toBe('unsent for c1');
    expect(getComposerDraft('c2')).toBe('');
  });

  it('re-opening the chat restores its text; the other chat shows its own', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('unsent for c1');
    update(r, <Composer chatId="c1" folder="work" />);

    // Switch to c2 in the SAME instance — the worst case, where the component
    // is reused rather than remounted, and the one a `key` would have hidden.
    update(r, <Composer chatId="c2" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');

    findHost(r.root, byType('TextInput')).props['onChangeText']('unsent for c2');
    update(r, <Composer chatId="c2" folder="work" />);

    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('unsent for c1');
    // Switching away must not have overwritten c2's own text with c1's.
    expect(getComposerDraft('c2')).toBe('unsent for c2');
  });

  it('a fresh mount of the chat restores its text (survives the app being killed)', () => {
    const first = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(first.root, byType('TextInput')).props['onChangeText']('still here later');
    update(first, <Composer chatId="c1" folder="work" />);

    const second = renderRN(<Composer chatId="c1" folder="work" />);
    expect(findHost(second.root, byType('TextInput')).props['value']).toBe('still here later');
  });

  it('a successful send clears the entry', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findHost(r.root, byType('TextInput'));
    input.props['onChangeText']('send me');
    update(r, <Composer chatId="c1" folder="work" />);

    findHost(r.root, byLabel('Send message')).props['onPress']();
    update(r, <Composer chatId="c1" folder="work" />);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(getComposerDraft('c1')).toBe('');
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  describe('server-owned live sync (spec/14 § Composer, spec/15 § Composer)', () => {
    it('re-opening the chat shows a draft that arrived from another surface while it was closed', () => {
      const r = renderRN(<Composer chatId="c1" folder="work" />);
      update(r, <Composer chatId="c2" folder="work" />);
      useComposerDraftStore.getState().applyDraftUpdated('c1', 'typed elsewhere', Date.now());
      update(r, <Composer chatId="c1" folder="work" />);
      expect(findHost(r.root, byType('TextInput')).props['value']).toBe('typed elsewhere');
    });

    it('a focused composer is not clobbered by an incoming update — applied only on blur', () => {
      const r = renderRN(<Composer chatId="c1" folder="work" />);
      const input = findHost(r.root, byType('TextInput'));
      input.props['onChangeText']('still typing');
      update(r, <Composer chatId="c1" folder="work" />);
      input.props['onFocus']();

      useComposerDraftStore
        .getState()
        .applyDraftUpdated('c1', 'from another surface', Date.now() + 60_000);
      update(r, <Composer chatId="c1" folder="work" />);
      expect(findHost(r.root, byType('TextInput')).props['value']).toBe('still typing');

      findHost(r.root, byType('TextInput')).props['onBlur']();
      update(r, <Composer chatId="c1" folder="work" />);
      expect(findHost(r.root, byType('TextInput')).props['value']).toBe('from another surface');
    });

    it('a clear from another surface, held while focused, empties the composer on blur', () => {
      const r = renderRN(<Composer chatId="c1" folder="work" />);
      const input = findHost(r.root, byType('TextInput'));
      input.props['onChangeText']('about to vanish');
      update(r, <Composer chatId="c1" folder="work" />);
      input.props['onFocus']();

      useComposerDraftStore.getState().applyDraftCleared('c1', Date.now() + 60_000);
      update(r, <Composer chatId="c1" folder="work" />);
      expect(findHost(r.root, byType('TextInput')).props['value']).toBe('about to vanish');

      findHost(r.root, byType('TextInput')).props['onBlur']();
      update(r, <Composer chatId="c1" folder="work" />);
      expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    });
  });
});
