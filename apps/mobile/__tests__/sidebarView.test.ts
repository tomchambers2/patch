// The Chats tab's view dropdown — pure logic (spec/15 § Chats tab; mirrors
// packages/web/src/__tests__/sidebarView.test.ts exactly).

import { describe, it, expect, vi } from 'vitest';
import {
  applySidebarView,
  sidebarViewFrom,
  sidebarViewTriggerLabel,
  SIDEBAR_VIEW_OPTIONS,
} from '../src/lib/sidebarView';

describe('sidebarViewFrom', () => {
  it('reads "all" when nothing is active', () => {
    expect(sidebarViewFrom(false, false, 'all')).toBe('all');
  });

  it('batch mode wins over everything else', () => {
    expect(sidebarViewFrom(true, true, 'working')).toBe('batch');
  });

  it('unread wins over the state filter', () => {
    expect(sidebarViewFrom(false, true, 'failed')).toBe('unread');
  });

  it('reads the state filter when nothing else is active', () => {
    expect(sidebarViewFrom(false, false, 'working')).toBe('working');
    expect(sidebarViewFrom(false, false, 'waiting')).toBe('waiting');
    expect(sidebarViewFrom(false, false, 'failed')).toBe('failed');
  });

  it('an unreachable state filter value falls back to "all"', () => {
    expect(sidebarViewFrom(false, false, 'done')).toBe('all');
  });
});

describe('applySidebarView', () => {
  function actions(): {
    setBatchMode: ReturnType<typeof vi.fn>;
    setAttentionOnly: ReturnType<typeof vi.fn>;
    setStateFilter: ReturnType<typeof vi.fn>;
  } {
    return { setBatchMode: vi.fn(), setAttentionOnly: vi.fn(), setStateFilter: vi.fn() };
  }

  it('batch: only batch mode turns on', () => {
    const a = actions();
    applySidebarView('batch', a);
    expect(a.setBatchMode).toHaveBeenCalledWith(true);
    expect(a.setAttentionOnly).toHaveBeenCalledWith(false);
    expect(a.setStateFilter).toHaveBeenCalledWith('all');
  });

  it('unread: only attentionOnly turns on', () => {
    const a = actions();
    applySidebarView('unread', a);
    expect(a.setBatchMode).toHaveBeenCalledWith(false);
    expect(a.setAttentionOnly).toHaveBeenCalledWith(true);
    expect(a.setStateFilter).toHaveBeenCalledWith('all');
  });

  it.each(['working', 'waiting', 'failed'] as const)('%s: sets the matching state filter', (v) => {
    const a = actions();
    applySidebarView(v, a);
    expect(a.setBatchMode).toHaveBeenCalledWith(false);
    expect(a.setAttentionOnly).toHaveBeenCalledWith(false);
    expect(a.setStateFilter).toHaveBeenCalledWith(v);
  });

  it('all: clears every piece', () => {
    const a = actions();
    applySidebarView('all', a);
    expect(a.setBatchMode).toHaveBeenCalledWith(false);
    expect(a.setAttentionOnly).toHaveBeenCalledWith(false);
    expect(a.setStateFilter).toHaveBeenCalledWith('all');
  });
});

describe('sidebarViewTriggerLabel', () => {
  it('reads "All chats" for the default, and the bare option label otherwise', () => {
    expect(sidebarViewTriggerLabel('all')).toBe('All chats');
    expect(sidebarViewTriggerLabel('unread')).toBe('Unread');
    expect(sidebarViewTriggerLabel('waiting')).toBe('Waiting on you');
    expect(sidebarViewTriggerLabel('batch')).toBe('Batch');
  });
});

describe('SIDEBAR_VIEW_OPTIONS', () => {
  it('is exactly the six options the spec names, in order', () => {
    expect(SIDEBAR_VIEW_OPTIONS.map((o) => o.label)).toEqual([
      'All',
      'Unread',
      'Working',
      'Waiting on you',
      'Failed',
      'Batch',
    ]);
  });
});
