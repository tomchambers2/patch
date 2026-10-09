// spec/15 § Composer — unsent text belongs to the chat it was typed in, and
// the SERVER owns it (spec/14 § Composer), synced through `../api/ws` — it is
// restored when that chat is reopened on ANY surface, never shown in another
// chat, and dropped when it is sent. A composer typed into and then EMPTIED
// has nothing to restore — whitespace included, same rule as web
// (`packages/web/src/lib/draftText.ts`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useComposerDraftStore,
  getComposerDraft,
  setComposerDraft,
  clearComposerDraft,
  hasDraftText,
  DRAFT_SEND_DEBOUNCE_MS,
} from '../src/lib/composerDraft';
import { useUiStore } from '../src/stores/uiStore';
import { getWs } from '../src/api/ws';
import { __clearAllMmkv } from './stubs/mmkv';
import { store } from '../src/lib/credential';

vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

beforeEach(() => {
  vi.mocked(getWs).mockReset();
  vi.useFakeTimers();
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  useUiStore.setState({ errors: [] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('composerDraft (plain function API)', () => {
  it('keeps each chat s unsent text under its own chat', () => {
    setComposerDraft('chat_a', 'text for a');
    setComposerDraft('chat_b', 'text for b');
    expect(getComposerDraft('chat_a')).toBe('text for a');
    expect(getComposerDraft('chat_b')).toBe('text for b');
  });

  it('a chat never typed in has no text', () => {
    setComposerDraft('chat_a', 'text for a');
    expect(getComposerDraft('chat_b')).toBe('');
  });

  it('emptying the composer leaves nothing to restore', () => {
    setComposerDraft('chat_a', 'typed');
    setComposerDraft('chat_a', '');
    expect(getComposerDraft('chat_a')).toBe('');
  });

  it('whitespace-only is NOT a draft', () => {
    setComposerDraft('chat_a', 'typed');
    setComposerDraft('chat_a', '   \n ');
    expect(getComposerDraft('chat_a')).toBe('');
    expect(hasDraftText('   \n ')).toBe(false);
    expect(hasDraftText(' x ')).toBe(true);
  });

  it('sending clears only that chat s text', () => {
    setComposerDraft('chat_a', 'a');
    setComposerDraft('chat_b', 'b');
    clearComposerDraft('chat_a');
    expect(getComposerDraft('chat_a')).toBe('');
    expect(getComposerDraft('chat_b')).toBe('b');
  });

  it('persists to MMKV under the same per-chat key as before, and reads it back fresh', () => {
    setComposerDraft('chat_a', 'survives a relaunch');
    expect(store().getString('patch.composerDraft:chat_a')).toBe('survives a relaunch');
  });
});

describe('loading at module init', () => {
  it('every existing MMKV entry migrates in as-is, marked owed to the server', async () => {
    store().set('patch.composerDraft:chat_a', 'typed before the update');
    store().set('patch.composerDraft:chat_b', '  '); // whitespace-only: not a draft
    vi.resetModules();
    const mod = await import('../src/lib/composerDraft');
    expect(mod.useComposerDraftStore.getState().drafts).toEqual({
      chat_a: 'typed before the update',
    });
  });

  it('pushes every pre-existing draft to the server on the first reconnect', async () => {
    store().set('patch.composerDraft:chat_a', 'migrate me');
    vi.resetModules();
    const mod = await import('../src/lib/composerDraft');
    const wsMod = await import('../src/api/ws');
    const send = vi.fn();
    vi.mocked(wsMod.getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    mod.useComposerDraftStore.getState().resendPendingOnReconnect();
    expect(send).toHaveBeenCalledWith({
      type: 'composer_draft.set',
      chatId: 'chat_a',
      text: 'migrate me',
    });
  });
});

describe('sending to the server', () => {
  it('debounces: a burst of keystrokes sends once, after the pause', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('chat_a', 'h');
    setComposerDraft('chat_a', 'he');
    setComposerDraft('chat_a', 'hel');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'composer_draft.set',
      chatId: 'chat_a',
      text: 'hel',
    });
  });

  it('clearDraft sends immediately, not debounced', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('chat_a', 'hello');
    send.mockClear();
    clearComposerDraft('chat_a');
    expect(send).toHaveBeenCalledWith({ type: 'composer_draft.clear', chatId: 'chat_a' });
  });

  it('offline ("not connected"): keeps the text locally and does not error', () => {
    vi.mocked(getWs).mockReturnValue({
      send: () => {
        throw new Error('PatchWs: not connected');
      },
    } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('chat_a', 'typed offline');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    expect(getComposerDraft('chat_a')).toBe('typed offline');
    expect(useUiStore.getState().errors).toEqual([]);
  });

  it('reconnecting pushes a draft the server never confirmed', () => {
    vi.mocked(getWs).mockReturnValue({
      send: () => {
        throw new Error('PatchWs: not connected');
      },
    } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('chat_a', 'typed offline');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);

    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    useComposerDraftStore.getState().resendPendingOnReconnect();
    expect(send).toHaveBeenCalledWith({
      type: 'composer_draft.set',
      chatId: 'chat_a',
      text: 'typed offline',
    });
  });

  it('a real send failure (not "not connected") surfaces the save-failed toast', () => {
    vi.mocked(getWs).mockReturnValue({
      send: () => {
        throw new Error('boom');
      },
    } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('chat_a', 'hello');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    expect(useUiStore.getState().errors.some((e) => /unsent message/i.test(e.message))).toBe(true);
  });

  it('after a successful send, reconnecting resends nothing more for that chat', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('chat_a', 'hello');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    useComposerDraftStore.getState().resendPendingOnReconnect();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('receiving updates from the server', () => {
  it('applyDraftUpdated sets the draft for a chat with no local focus', () => {
    useComposerDraftStore.getState().applyDraftUpdated('chat_a', 'from another surface', 1000);
    expect(getComposerDraft('chat_a')).toBe('from another surface');
  });

  it('applyDraftCleared drops the draft', () => {
    setComposerDraft('chat_a', 'hello');
    useComposerDraftStore.getState().applyDraftCleared('chat_a', 1000);
    expect(getComposerDraft('chat_a')).toBe('');
  });

  it('applyDraftList seeds every draft the account has', () => {
    useComposerDraftStore.getState().applyDraftList([
      { chatId: 'chat_a', text: 'first', updatedAt: 1 },
      { chatId: 'chat_b', text: 'second', updatedAt: 2 },
    ]);
    expect(useComposerDraftStore.getState().drafts).toEqual({
      chat_a: 'first',
      chat_b: 'second',
    });
  });

  it('applyDraftList drops a local draft the server no longer has', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    setComposerDraft('stale', 'old text');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS); // confirmed sent
    useComposerDraftStore.getState().applyDraftList([]);
    expect(getComposerDraft('stale')).toBe('');
  });

  it('applyDraftList never drops a write still owed to the server', () => {
    setComposerDraft('unsent', 'not sent yet');
    useComposerDraftStore.getState().applyDraftList([]);
    expect(getComposerDraft('unsent')).toBe('not sent yet');
  });
});

describe('a focused composer is never clobbered under the cursor', () => {
  it('an update while focused is held, and applied on blur if newer than the last local edit', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'my edit');
    s.setFocused('chat_a', true);
    s.applyDraftUpdated('chat_a', 'someone else’s newer text', Date.now() + 10_000);
    expect(getComposerDraft('chat_a')).toBe('my edit');

    const applied = useComposerDraftStore.getState().setFocused('chat_a', false);
    expect(applied).toBe('someone else’s newer text');
    expect(getComposerDraft('chat_a')).toBe('someone else’s newer text');
  });

  it('a keystroke made after the held update supersedes it — blur keeps the local edit', () => {
    const s = useComposerDraftStore.getState();
    s.setFocused('chat_a', true);
    s.applyDraftUpdated('chat_a', 'stale by the time it arrived', 1);
    s.setDraft('chat_a', 'typed after that update arrived');
    const applied = useComposerDraftStore.getState().setFocused('chat_a', false);
    expect(applied).toBeUndefined();
    expect(getComposerDraft('chat_a')).toBe('typed after that update arrived');
  });

  it('a clear held while focused is applied on blur as an emptied composer', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'my edit');
    s.setFocused('chat_a', true);
    s.applyDraftCleared('chat_a', Date.now() + 10_000);
    expect(getComposerDraft('chat_a')).toBe('my edit');
    const applied = useComposerDraftStore.getState().setFocused('chat_a', false);
    expect(applied).toBe('');
    expect(getComposerDraft('chat_a')).toBe('');
  });

  it('applyDraftList stashes a focused chat instead of applying it, same as applyDraftUpdated', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'my edit');
    s.setFocused('chat_a', true);
    s.applyDraftList([
      { chatId: 'chat_a', text: 'server snapshot', updatedAt: Date.now() + 10_000 },
    ]);
    expect(getComposerDraft('chat_a')).toBe('my edit');
    const applied = useComposerDraftStore.getState().setFocused('chat_a', false);
    expect(applied).toBe('server snapshot');
  });

  it('clearDraft while a remote update is held (focused, never blurred) drops the pending update too', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'my edit');
    s.setFocused('chat_a', true);
    s.applyDraftUpdated('chat_a', 'from another surface', Date.now() + 10_000);
    s.clearDraft('chat_a');
    // Nothing left to apply on a later blur — the clear discarded it.
    const applied = useComposerDraftStore.getState().setFocused('chat_a', false);
    expect(applied).toBeUndefined();
  });
});

describe('storage failures (NO FALLBACK)', () => {
  it('a write failure surfaces the save-failed toast rather than losing the text silently', () => {
    const spy = vi.spyOn(store(), 'set').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      setComposerDraft('chat_a', 'unsaveable');
    } finally {
      spy.mockRestore();
    }
    expect(useUiStore.getState().errors.some((e) => /unsent message/i.test(e.message))).toBe(true);
  });

  it('loadAll starts empty, not crashing, when getAllKeys() itself fails', async () => {
    store().set('patch.composerDraft:chat_a', 'would have migrated');
    vi.resetModules();
    // Spy on the instance the freshly-imported module's own `store()`
    // resolves to (see the getString test below for why the pre-reset one
    // won't do).
    const credentialMod = await import('../src/lib/credential');
    const freshStore = credentialMod.store();
    const spy = vi.spyOn(freshStore, 'getAllKeys').mockImplementation(() => {
      throw new Error('mmkv unavailable');
    });
    try {
      const mod = await import('../src/lib/composerDraft');
      expect(mod.useComposerDraftStore.getState().drafts).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  it('loadAll skips a key whose value cannot be read, rather than crashing', async () => {
    store().set('patch.composerDraft:chat_a', 'readable');
    store().set('patch.composerDraft:chat_b', 'will fail to read');
    vi.resetModules();
    // The spy must attach to the SAME MMKV instance the freshly-imported
    // module's own `store()` resolves to — resetModules gives `credential.ts`
    // a fresh module (and hence a fresh MMKV object), so a spy set up on the
    // pre-reset `store()` above would miss it entirely.
    const credentialMod = await import('../src/lib/credential');
    const freshStore = credentialMod.store();
    const original = freshStore.getString.bind(freshStore);
    const spy = vi.spyOn(freshStore, 'getString').mockImplementation((key: string) => {
      if (key === 'patch.composerDraft:chat_b') throw new Error('corrupt entry');
      return original(key);
    });
    try {
      const mod = await import('../src/lib/composerDraft');
      expect(mod.useComposerDraftStore.getState().drafts).toEqual({ chat_a: 'readable' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the new-chat placeholder key', () => {
  it('is local only: typing into it never reaches the server', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as never);
    setComposerDraft('new', 'half-written new chat');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS * 2);
    expect(getComposerDraft('new')).toBe('half-written new chat');
    expect(send).not.toHaveBeenCalled();
    clearComposerDraft('new');
    expect(send).not.toHaveBeenCalled();
  });
});
