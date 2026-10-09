import { describe, it, expect } from 'vitest';
import type { ChatSearchHostResult } from '@patch/wire';
import {
  findRanges,
  highlightSegments,
  hostMarkerText,
  localSearchHits,
  searchHitPath,
  searchableQuery,
  sectionLabel,
} from '../lib/chatSearch';
import type { ChatRow } from '../stores/types';

function row(over: Partial<ChatRow>): ChatRow {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'auto',
    name: null,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    pendingWake: null,
    todos: [],
    folder: '/home/tom/projects/patch',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
    jobId: null,
    snoozedUntil: null,
    ...over,
  } as ChatRow;
}

describe('searchableQuery', () => {
  it('trims and refuses anything shorter than the minimum', () => {
    expect(searchableQuery('')).toBeNull();
    expect(searchableQuery(' a ')).toBeNull();
    expect(searchableQuery('  ab  ')).toBe('ab');
  });
});

describe('highlightSegments', () => {
  it('splits text into plain and marked runs', () => {
    expect(highlightSegments('find the bus stop', [[9, 12]])).toEqual([
      { text: 'find the ', marked: false },
      { text: 'bus', marked: true },
      { text: ' stop', marked: false },
    ]);
  });

  it('returns the whole text unmarked when there are no ranges', () => {
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', marked: false }]);
    expect(highlightSegments('', [])).toEqual([{ text: '', marked: false }]);
  });

  it('marks from the very start and to the very end', () => {
    expect(
      highlightSegments('abcdef', [
        [0, 2],
        [4, 6],
      ]),
    ).toEqual([
      { text: 'ab', marked: true },
      { text: 'cd', marked: false },
      { text: 'ef', marked: true },
    ]);
  });

  it('merges overlapping and touching ranges, in any order', () => {
    expect(
      highlightSegments('abcdefgh', [
        [4, 6],
        [1, 3],
        [2, 5],
        [6, 7],
      ]),
    ).toEqual([
      { text: 'a', marked: false },
      { text: 'bcdefg', marked: true },
      { text: 'h', marked: false },
    ]);
  });

  it('clamps out-of-range ends and drops empty or inverted ranges', () => {
    expect(
      highlightSegments('abc', [
        [-5, 1],
        [2, 99],
        [2, 2],
        [3, 1],
        [50, 60],
      ]),
    ).toEqual([
      { text: 'a', marked: true },
      { text: 'b', marked: false },
      { text: 'c', marked: true },
    ]);
  });
});

describe('findRanges', () => {
  it('finds every case-insensitive occurrence', () => {
    expect(findRanges('Bus to the BUS station', 'bus')).toEqual([
      [0, 3],
      [11, 14],
    ]);
    expect(findRanges('nothing', 'bus')).toEqual([]);
  });
});

describe('localSearchHits', () => {
  it('matches name or preview case-insensitively, newest first', () => {
    const rows = [
      row({ chatId: 'p', name: 'tea order', preview: 'which DARJEELING seller', lastUpdated: 9 }),
      row({ chatId: 'n', name: 'Darjeeling compare', preview: null, lastUpdated: 1 }),
      row({ chatId: 'x', name: 'bus watch', preview: 'the 57 bus' }),
    ];
    const hits = localSearchHits(rows, '  darjeeling ');
    expect(hits.map((h) => h.chatId)).toEqual(['p', 'n']);
    expect(hits[1]!.nameMatch).toBe(true);
    expect(hits[1]!.nameHighlights).toEqual([[0, 10]]);
    expect(hits[1]!.snippet).toBeNull();
    expect(hits[0]!.snippet).toMatchObject({ text: 'which DARJEELING seller', seq: null });
    expect(hits[0]!.snippet!.highlights).toEqual([[6, 16]]);
  });

  it('treats a quoted run as an exact phrase and needs every term', () => {
    const rows = [
      row({ chatId: 'a', name: 'Expansion vessel fix', preview: null }),
      row({ chatId: 'b', name: 'Vessel for expansion', preview: null }),
    ];
    expect(
      localSearchHits(rows, 'expansion vessel')
        .map((h) => h.chatId)
        .sort(),
    ).toEqual(['a', 'b']);
    const exact = localSearchHits(rows, '"expansion vessel"');
    expect(exact.map((h) => h.chatId)).toEqual(['a']);
    expect(exact[0]!.nameHighlights).toEqual([[0, 16]]);
  });

  it('ignores the preview when full text is off', () => {
    const rows = [row({ chatId: 'p', name: 'tea order', preview: 'which darjeeling seller' })];
    expect(localSearchHits(rows, 'darjeeling', true)).toHaveLength(1);
    expect(localSearchHits(rows, 'darjeeling', false)).toEqual([]);
    expect(localSearchHits(rows, 'tea', false)).toHaveLength(1);
  });

  it('skips deleted chats and names the section a row lives in', () => {
    const now = Date.now();
    const rows = [
      row({ chatId: 'del', name: 'kettle', status: 'deleted' }),
      row({ chatId: 'arc', name: 'kettle a', status: 'archived' }),
      row({ chatId: 'pin', name: 'kettle p', pinned: true }),
      row({ chatId: 'snz', name: 'kettle s', snoozedUntil: now + 60_000 }),
      row({ chatId: 'hid', name: 'kettle h', hidden: true }),
      row({ chatId: 'arh', name: 'kettle ah', status: 'archived', hidden: true }),
      row({ chatId: 'fol', name: 'kettle f' }),
      row({ chatId: 'thread_manager', name: 'kettle m' }),
    ];
    const byId = Object.fromEntries(localSearchHits(rows, 'kettle').map((h) => [h.chatId, h]));
    expect(byId['del']).toBeUndefined();
    expect(byId['arc']!.section).toBe('archived');
    expect(byId['pin']!.section).toBe('pinned');
    expect(byId['snz']!.section).toBe('snoozed');
    expect(byId['hid']!.section).toBe('hidden');
    // An archived chat keeps the flag but is archived (spec/04 § Hidden).
    expect(byId['arh']!.section).toBe('archived');
    expect(byId['fol']!.section).toBe('folders');
    expect(byId['thread_manager']!.section).toBe('manager');
  });
});

describe('sectionLabel / searchHitPath', () => {
  it('labels a folder hit by its project basename', () => {
    expect(sectionLabel({ section: 'folders', folder: '/home/tom/projects/patch' })).toBe('patch');
    expect(sectionLabel({ section: 'archived', folder: '/x' })).toBe('Archived');
    expect(sectionLabel({ section: 'manager', folder: '/x' })).toBe('Manager');
    expect(sectionLabel({ section: 'hidden', folder: '/x' })).toBe('Hidden');
  });

  it('carries the matched message seq when there is one', () => {
    const snippet = { text: 't', highlights: [], role: 'user' as const, createdAt: null };
    expect(searchHitPath({ chatId: 'c1', snippet: { ...snippet, seq: 12 } })).toBe(
      '/chats/c1?seq=12',
    );
    expect(searchHitPath({ chatId: 'c1', snippet: { ...snippet, seq: 0 } })).toBe(
      '/chats/c1?seq=0',
    );
    expect(searchHitPath({ chatId: 'c1', snippet: { ...snippet, seq: null } })).toBe('/chats/c1');
    expect(searchHitPath({ chatId: 'c1', snippet: null })).toBe('/chats/c1');
  });
});

describe('hostMarkerText', () => {
  const host = (over: Partial<ChatSearchHostResult>): ChatSearchHostResult => ({
    daemonId: 'd1',
    hostName: 'Mac',
    state: 'searched',
    ...over,
  });

  it('says nothing for a host that was searched', () => {
    expect(hostMarkerText(host({}), 'Mac')).toBeNull();
  });

  it('names every host that was not searched, and why', () => {
    expect(hostMarkerText(host({ state: 'offline' }), 'Mac')).toBe('Mac offline — not searched');
    expect(hostMarkerText(host({ state: 'timeout' }), 'Mac')).toBe(
      "Mac didn't answer — not searched",
    );
    expect(hostMarkerText(host({ state: 'error', message: 'disk full' }), 'Mac')).toBe(
      'Mac: disk full',
    );
    expect(hostMarkerText(host({ state: 'error' }), 'Mac')).toBe('Mac: search failed');
  });
});
