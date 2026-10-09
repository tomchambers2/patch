// Per-chat Tools on/off store (src/stores/toolsStore.ts). Mirrors the
// intent of packages/web/src/stores/toolsStore.ts, persisted via MMKV instead
// of localStorage — the one real difference from web.

import { describe, it, expect, beforeEach } from 'vitest';
import { useToolsStore, loadDisabledFromStorage } from '../src/stores/toolsStore';
import { store } from '../src/lib/credential';

const STORAGE_KEY = 'patch.tools.disabledByChat.v1';

beforeEach(() => {
  useToolsStore.getState()._reset();
});

describe('toolsStore — isDisabled / disabledFor', () => {
  it('every tool starts on for a chat that has never been touched', () => {
    expect(useToolsStore.getState().isDisabled('c1', 'Bash')).toBe(false);
    expect(useToolsStore.getState().disabledFor('c1')).toEqual([]);
  });

  it('toggling a tool off, then on again, round-trips', () => {
    useToolsStore.getState().toggle('c1', 'Bash');
    expect(useToolsStore.getState().isDisabled('c1', 'Bash')).toBe(true);
    expect(useToolsStore.getState().disabledFor('c1')).toEqual(['Bash']);

    useToolsStore.getState().toggle('c1', 'Bash');
    expect(useToolsStore.getState().isDisabled('c1', 'Bash')).toBe(false);
    expect(useToolsStore.getState().disabledFor('c1')).toEqual([]);
  });

  it('OFF sets are independent per chat', () => {
    useToolsStore.getState().toggle('c1', 'Bash');
    useToolsStore.getState().toggle('c2', 'Read');
    expect(useToolsStore.getState().disabledFor('c1')).toEqual(['Bash']);
    expect(useToolsStore.getState().disabledFor('c2')).toEqual(['Read']);
  });

  it('persists across a fresh store read (MMKV round-trip)', () => {
    useToolsStore.getState().toggle('c1', 'Bash');
    useToolsStore.getState().toggle('c1', 'mcp__patch__patch_spawn');
    expect(loadDisabledFromStorage()).toEqual({
      c1: ['Bash', 'mcp__patch__patch_spawn'],
    });
  });

  it('an empty OFF set is removed from storage entirely, not kept as []', () => {
    useToolsStore.getState().toggle('c1', 'Bash');
    useToolsStore.getState().toggle('c1', 'Bash'); // back off
    expect(loadDisabledFromStorage()).toEqual({});
  });
});

describe('toolsStore — loadDisabledFromStorage (NO FALLBACK to a wrong gating)', () => {
  it('a corrupt JSON blob degrades to an empty set, not a crash', () => {
    store().set(STORAGE_KEY, '{not json');
    expect(loadDisabledFromStorage()).toEqual({});
  });

  it('a non-object root (e.g. a JSON array or number) degrades to an empty set', () => {
    store().set(STORAGE_KEY, '[1,2,3]');
    expect(loadDisabledFromStorage()).toEqual({});
    store().set(STORAGE_KEY, '42');
    expect(loadDisabledFromStorage()).toEqual({});
  });

  it('non-string entries inside a chat list are dropped, not kept as junk', () => {
    store().set(STORAGE_KEY, JSON.stringify({ c1: ['Bash', 42, null, 'Read'] }));
    expect(loadDisabledFromStorage()).toEqual({ c1: ['Bash', 'Read'] });
  });

  it('a chat whose list is empty after sanitising is dropped entirely', () => {
    store().set(STORAGE_KEY, JSON.stringify({ c1: [42, null] }));
    expect(loadDisabledFromStorage()).toEqual({});
  });
});
