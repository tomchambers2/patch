// stores/uiStore.ts — banner errors + transient notices (the wire-decoder and
// several lib modules push failures here so the user sees something rather
// than a silent skip).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUiStore } from '../src/stores/uiStore';
import { __clearAllMmkv } from './stubs/mmkv';

beforeEach(() => {
  __clearAllMmkv();
  useUiStore.setState({
    errors: [],
    diagnosticsOpen: false,
    diagnosticsBlockingClosed: false,
    attentionOnly: false,
    stateFilter: 'all',
  });
});

describe('uiStore', () => {
  it('pushError appends a new error with an id + timestamp', () => {
    useUiStore.getState().pushError('boom');
    const errors = useUiStore.getState().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'boom' });
    expect(typeof errors[0]!.id).toBe('number');
    expect(typeof errors[0]!.at).toBe('number');
  });

  it('pushError appends (does not replace) across multiple calls, with unique ids', () => {
    useUiStore.getState().pushError('first');
    useUiStore.getState().pushError('second');
    const errors = useUiStore.getState().errors;
    expect(errors.map((e) => e.message)).toEqual(['first', 'second']);
    expect(errors[0]!.id).not.toBe(errors[1]!.id);
  });

  it('dismissError removes only the matching error by id', () => {
    useUiStore.getState().pushError('first');
    useUiStore.getState().pushError('second');
    const [first, second] = useUiStore.getState().errors;
    useUiStore.getState().dismissError(first!.id);
    const remaining = useUiStore.getState().errors;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(second!.id);
  });

  it('dismissError with an unknown id is a no-op', () => {
    useUiStore.getState().pushError('first');
    useUiStore.getState().dismissError(999999);
    expect(useUiStore.getState().errors).toHaveLength(1);
  });

  it('setDiagnosticsOpen toggles the on-demand overlay', () => {
    useUiStore.getState().setDiagnosticsOpen(true);
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.getState().setDiagnosticsOpen(false);
    expect(useUiStore.getState().diagnosticsOpen).toBe(false);
  });

  it('closeDiagnosticsBlocking latches for the session — it never flips back on its own', () => {
    expect(useUiStore.getState().diagnosticsBlockingClosed).toBe(false);
    useUiStore.getState().closeDiagnosticsBlocking();
    expect(useUiStore.getState().diagnosticsBlockingClosed).toBe(true);
    useUiStore.getState().setDiagnosticsOpen(true);
    useUiStore.getState().setDiagnosticsOpen(false);
    expect(useUiStore.getState().diagnosticsBlockingClosed).toBe(true);
  });

  // The Chats tab view dropdown (spec/15 § Chats tab) persists its choice —
  // picking Unread/Working/Waiting on you/Failed is a standing choice, the
  // same as batch mode already is.
  describe('setAttentionOnly / setStateFilter persistence', () => {
    it('persists attentionOnly across a fresh module load', async () => {
      useUiStore.getState().setAttentionOnly(true);
      vi.resetModules();
      const fresh = await import('../src/stores/uiStore');
      expect(fresh.useUiStore.getState().attentionOnly).toBe(true);
    });

    it('persists stateFilter across a fresh module load', async () => {
      useUiStore.getState().setStateFilter('failed');
      vi.resetModules();
      const fresh = await import('../src/stores/uiStore');
      expect(fresh.useUiStore.getState().stateFilter).toBe('failed');
    });

    it('a missing or garbled stateFilter reads back as "all"', async () => {
      const { store } = await import('../src/lib/credential');
      store().set('patch.sidebar.stateFilter', 'nonsense');
      vi.resetModules();
      const fresh = await import('../src/stores/uiStore');
      expect(fresh.useUiStore.getState().stateFilter).toBe('all');
    });
  });
});
