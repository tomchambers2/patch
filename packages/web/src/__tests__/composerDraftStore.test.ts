// Composer drafts (spec/14 § Composer) — unsent text in an EXISTING chat's
// composer, keyed by chatId, synced through the SERVER (not the host) so it
// follows the chat onto every open surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useComposerDraftStore,
  clearComposerDraft,
  DRAFT_SEND_DEBOUNCE_MS,
} from '../stores/composerDraftStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';

const OLD_KEY = 'patch.composer-drafts.v1';
const CACHE_KEY = 'patch.composer-drafts-cache.v1';

describe('composerDraftStore', () => {
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

  it('keeps one entry per chat and reads back exactly what was typed', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'text for a');
    s.setDraft('chat_b', 'text for b');

    expect(useComposerDraftStore.getState().get('chat_a')).toBe('text for a');
    expect(useComposerDraftStore.getState().get('chat_b')).toBe('text for b');
  });

  it('a chat with nothing typed reads as empty, never another chat’s text', () => {
    useComposerDraftStore.getState().setDraft('chat_a', 'text for a');
    expect(useComposerDraftStore.getState().get('chat_never_typed_in')).toBe('');
  });

  it('emptying the composer drops the entry rather than storing an empty string', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'typed');
    s.setDraft('chat_a', '');

    expect(useComposerDraftStore.getState().get('chat_a')).toBe('');
    expect(useComposerDraftStore.getState().drafts).not.toHaveProperty('chat_a');
  });

  it('whitespace-only text is not a draft', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'typed');
    s.setDraft('chat_a', '   \n ');
    expect(useComposerDraftStore.getState().get('chat_a')).toBe('');
    expect(useComposerDraftStore.getState().drafts).not.toHaveProperty('chat_a');
  });

  it('clearDraft drops only the named chat', () => {
    const s = useComposerDraftStore.getState();
    s.setDraft('chat_a', 'a');
    s.setDraft('chat_b', 'b');
    clearComposerDraft('chat_a');

    expect(useComposerDraftStore.getState().get('chat_a')).toBe('');
    expect(useComposerDraftStore.getState().get('chat_b')).toBe('b');
  });

  it('persists to its own cache key for offline survival, leaving the new-chat drafts key alone', () => {
    useComposerDraftStore.getState().setDraft('chat_a', 'survives a reload');

    expect(JSON.parse(window.localStorage.getItem(CACHE_KEY)!)).toEqual({
      chat_a: 'survives a reload',
    });
    expect(window.localStorage.getItem('patch.drafts.v1')).toBeNull();
  });

  it('text that cannot be persisted SAYS so (NO FALLBACK)', () => {
    useUiStore.getState().clearToasts();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      useComposerDraftStore.getState().setDraft('chat_a', 'unsaveable');
    } finally {
      spy.mockRestore();
    }
    expect(useUiStore.getState().errors.some((e) => /unsent message/i.test(e.message))).toBe(true);
  });

  // These need a fresh module graph — the migration + initial-cache-load logic
  // only runs once, at module init.
  describe('loading at module init', () => {
    it('a corrupt cache yields an empty set, never a silently-wrong draft (NO FALLBACK)', async () => {
      window.localStorage.setItem(CACHE_KEY, '{not json');
      vi.resetModules();
      const mod = await import('../stores/composerDraftStore.js');
      expect(mod.useComposerDraftStore.getState().drafts).toEqual({});
    });

    it('non-string entries in a stored cache are dropped, not coerced', async () => {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({ chat_a: 42, chat_b: 'real text' }));
      vi.resetModules();
      const mod = await import('../stores/composerDraftStore.js');
      expect(mod.useComposerDraftStore.getState().drafts).toEqual({ chat_b: 'real text' });
    });

    describe('migration from the pre-server-drafts localStorage blob', () => {
      it('reads the old key once, seeds the new store, and removes the old key', async () => {
        window.localStorage.setItem(
          OLD_KEY,
          JSON.stringify({ chat_a: 'typed before the update', chat_b: '  ' }),
        );
        vi.resetModules();
        const mod = await import('../stores/composerDraftStore.js');
        expect(mod.useComposerDraftStore.getState().drafts).toEqual({
          chat_a: 'typed before the update',
        });
        expect(window.localStorage.getItem(OLD_KEY)).toBeNull();
        // Migrated into the new cache too, so a reload before the first
        // reconnect flush still has it.
        expect(JSON.parse(window.localStorage.getItem(CACHE_KEY)!)).toEqual({
          chat_a: 'typed before the update',
        });
      });

      it('pushes every migrated draft to the server on the first reconnect', async () => {
        window.localStorage.setItem(OLD_KEY, JSON.stringify({ chat_a: 'migrate me' }));
        vi.resetModules();
        const mod = await import('../stores/composerDraftStore.js');
        const wsMod = await import('../api/ws.js');
        const send = vi.fn();
        wsMod.setActiveWs({ send } as unknown as PatchWs);
        try {
          mod.useComposerDraftStore.getState().resendPendingOnReconnect();
          expect(send).toHaveBeenCalledWith({
            type: 'composer_draft.set',
            chatId: 'chat_a',
            text: 'migrate me',
          });
        } finally {
          wsMod.setActiveWs(null);
        }
      });

      it('a corrupt old blob migrates to nothing, not a crash', async () => {
        window.localStorage.setItem(OLD_KEY, '{not json');
        vi.resetModules();
        const mod = await import('../stores/composerDraftStore.js');
        expect(mod.useComposerDraftStore.getState().drafts).toEqual({});
        expect(window.localStorage.getItem(OLD_KEY)).toBeNull();
      });
    });
  });

  describe('sending to the server', () => {
    it('debounces: a burst of keystrokes sends once, after the pause', () => {
      const send = vi.fn();
      setActiveWs({ send } as unknown as PatchWs);
      const s = useComposerDraftStore.getState();
      s.setDraft('c1', 'h');
      s.setDraft('c1', 'he');
      s.setDraft('c1', 'hel');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS - 1);
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ type: 'composer_draft.set', chatId: 'c1', text: 'hel' });
    });

    it('clearDraft sends immediately, not debounced', () => {
      const send = vi.fn();
      setActiveWs({ send } as unknown as PatchWs);
      useComposerDraftStore.getState().setDraft('c1', 'hello');
      send.mockClear();
      clearComposerDraft('c1');
      expect(send).toHaveBeenCalledWith({ type: 'composer_draft.clear', chatId: 'c1' });
    });

    it('offline (no active ws): keeps the text locally and does not error', () => {
      useUiStore.getState().clearToasts();
      useComposerDraftStore.getState().setDraft('c1', 'typed offline');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
      expect(useComposerDraftStore.getState().get('c1')).toBe('typed offline');
      expect(useUiStore.getState().errors).toEqual([]);
    });

    it('reconnecting pushes a draft the server never confirmed', () => {
      useComposerDraftStore.getState().setDraft('c1', 'typed offline');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
      const send = vi.fn();
      setActiveWs({ send } as unknown as PatchWs);
      useComposerDraftStore.getState().resendPendingOnReconnect();
      expect(send).toHaveBeenCalledWith({
        type: 'composer_draft.set',
        chatId: 'c1',
        text: 'typed offline',
      });
    });

    it('a real send failure (not "not connected") surfaces the save-failed toast', () => {
      useUiStore.getState().clearToasts();
      const send = vi.fn(() => {
        throw new Error('boom');
      });
      setActiveWs({ send } as unknown as PatchWs);
      useComposerDraftStore.getState().setDraft('c1', 'hello');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
      expect(useUiStore.getState().errors.some((e) => /unsent message/i.test(e.message))).toBe(
        true,
      );
    });

    it('a "PatchWs: not connected" throw is treated as offline, not an error', () => {
      useUiStore.getState().clearToasts();
      const send = vi.fn(() => {
        throw new Error('PatchWs: not connected');
      });
      setActiveWs({ send } as unknown as PatchWs);
      useComposerDraftStore.getState().setDraft('c1', 'hello');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
      expect(useUiStore.getState().errors).toEqual([]);
    });

    it('after a successful send, reconnecting resends nothing more for that chat', () => {
      const send = vi.fn();
      setActiveWs({ send } as unknown as PatchWs);
      useComposerDraftStore.getState().setDraft('c1', 'hello');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
      expect(send).toHaveBeenCalledTimes(1);
      send.mockClear();
      useComposerDraftStore.getState().resendPendingOnReconnect();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('receiving updates from the server', () => {
    it('applyDraftUpdated sets the draft for a chat with no local focus', () => {
      useComposerDraftStore.getState().applyDraftUpdated('c1', 'from another surface', 1000);
      expect(useComposerDraftStore.getState().get('c1')).toBe('from another surface');
    });

    it('applyDraftCleared drops the draft', () => {
      useComposerDraftStore.getState().setDraft('c1', 'hello');
      useComposerDraftStore.getState().applyDraftCleared('c1', 1000);
      expect(useComposerDraftStore.getState().get('c1')).toBe('');
    });

    it('applyDraftList seeds every draft the account has', () => {
      useComposerDraftStore.getState().applyDraftList([
        { chatId: 'c1', text: 'first', updatedAt: 1 },
        { chatId: 'c2', text: 'second', updatedAt: 2 },
      ]);
      expect(useComposerDraftStore.getState().drafts).toEqual({ c1: 'first', c2: 'second' });
    });

    it('applyDraftList drops a local draft the server no longer has', () => {
      const send = vi.fn();
      setActiveWs({ send } as unknown as PatchWs);
      useComposerDraftStore.getState().setDraft('stale', 'old text');
      vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS); // confirmed sent — no longer "owed"
      useComposerDraftStore.getState().applyDraftList([]);
      expect(useComposerDraftStore.getState().get('stale')).toBe('');
    });

    it('applyDraftList never drops a write still owed to the server', () => {
      // Never sent (offline) — still pending — must survive a snapshot that
      // doesn't mention it yet.
      useComposerDraftStore.getState().setDraft('unsent', 'not sent yet');
      useComposerDraftStore.getState().applyDraftList([]);
      expect(useComposerDraftStore.getState().get('unsent')).toBe('not sent yet');
    });
  });

  describe('a focused composer is never clobbered under the cursor', () => {
    it('an update while focused is held, and applied on blur if newer than the last local edit', () => {
      const s = useComposerDraftStore.getState();
      s.setDraft('c1', 'my edit');
      s.setFocused('c1', true);
      // Arrives while still focused — must not touch what's rendered.
      s.applyDraftUpdated('c1', 'someone else’s newer text', Date.now() + 10_000);
      expect(useComposerDraftStore.getState().get('c1')).toBe('my edit');

      const applied = useComposerDraftStore.getState().setFocused('c1', false);
      expect(applied).toBe('someone else’s newer text');
      expect(useComposerDraftStore.getState().get('c1')).toBe('someone else’s newer text');
    });

    it('a keystroke made after the held update supersedes it — blur keeps the local edit', () => {
      const s = useComposerDraftStore.getState();
      s.setFocused('c1', true);
      s.applyDraftUpdated('c1', 'stale by the time it arrived', 1); // ms-epoch 1: ancient
      s.setDraft('c1', 'typed after that update arrived');
      const applied = useComposerDraftStore.getState().setFocused('c1', false);
      expect(applied).toBeUndefined();
      expect(useComposerDraftStore.getState().get('c1')).toBe('typed after that update arrived');
    });

    it('blur with nothing pending returns undefined (nothing to apply)', () => {
      useComposerDraftStore.getState().setFocused('c1', true);
      const applied = useComposerDraftStore.getState().setFocused('c1', false);
      expect(applied).toBeUndefined();
    });

    it('a clear held while focused is applied on blur as an emptied composer', () => {
      const s = useComposerDraftStore.getState();
      s.setDraft('c1', 'my edit');
      s.setFocused('c1', true);
      s.applyDraftCleared('c1', Date.now() + 10_000);
      expect(useComposerDraftStore.getState().get('c1')).toBe('my edit');
      const applied = useComposerDraftStore.getState().setFocused('c1', false);
      expect(applied).toBe('');
      expect(useComposerDraftStore.getState().get('c1')).toBe('');
    });

    it('applyDraftList also defers to focus, holding the snapshot rather than applying it', () => {
      const s = useComposerDraftStore.getState();
      s.setDraft('c1', 'my edit');
      s.setFocused('c1', true);
      s.applyDraftList([{ chatId: 'c1', text: 'server snapshot', updatedAt: Date.now() + 10_000 }]);
      expect(useComposerDraftStore.getState().get('c1')).toBe('my edit');
      const applied = useComposerDraftStore.getState().setFocused('c1', false);
      expect(applied).toBe('server snapshot');
    });
  });
});
