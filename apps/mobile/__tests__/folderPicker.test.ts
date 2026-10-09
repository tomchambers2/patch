// The folder picker sheet's pure logic (spec/15 § Folder picker sheet).

import { describe, it, expect } from 'vitest';
import {
  buildRecentFolders,
  completePath,
  filterPathEntries,
  filterRows,
  isPathQuery,
  shortHomePath,
  splitPathQuery,
} from '../src/lib/folderPicker';
import type { ChatRow } from '../src/stores/types';

const chat = (p: Partial<ChatRow> & { chatId: string }): ChatRow =>
  ({ daemonId: 'd1', folder: '', status: 'active', lastUpdated: 1, jobId: null, ...p }) as ChatRow;

describe('shortHomePath', () => {
  it('shortens linux and mac home directories', () => {
    expect(shortHomePath('/home/tom/projects/x')).toBe('~/projects/x');
    expect(shortHomePath('/Users/tom/x')).toBe('~/x');
    expect(shortHomePath('/home/tom')).toBe('~');
    expect(shortHomePath('/srv/x')).toBe('/srv/x');
  });
});

describe('isPathQuery / splitPathQuery', () => {
  it('detects path-like text', () => {
    expect(isPathQuery('/a')).toBe(true);
    expect(isPathQuery('~')).toBe(true);
    expect(isPathQuery('proj')).toBe(false);
  });
  it('splits the directory from the partial segment', () => {
    expect(splitPathQuery('~/projects/po')).toEqual({ dir: '~/projects', partial: 'po' });
    expect(splitPathQuery('~/')).toEqual({ dir: '~', partial: '' });
    expect(splitPathQuery('/')).toEqual({ dir: '/', partial: '' });
    expect(splitPathQuery('/abc')).toEqual({ dir: '/', partial: 'abc' });
  });
  it('completes a suggestion into a drillable path', () => {
    expect(completePath('~/projects', 'x')).toBe('~/projects/x/');
    expect(completePath('/', 'x')).toBe('/x/');
  });
  it('filters entries by prefix, case-insensitively', () => {
    const e = [{ name: 'Alpha' }, { name: 'beta' }];
    expect(filterPathEntries(e, 'a')).toEqual([{ name: 'Alpha' }]);
    expect(filterPathEntries(e, '')).toEqual(e);
  });
});

describe('buildRecentFolders', () => {
  it('orders by recency, drops junk, job and deleted chats, dedupes, adds roots at 0', () => {
    const out = buildRecentFolders(
      {
        a: chat({ chatId: 'a', folder: '/p/old', lastUpdated: 1 }),
        b: chat({ chatId: 'b', folder: '/p/new', lastUpdated: 5 }),
        c: chat({ chatId: 'c', folder: '/p/new', lastUpdated: 7 }),
        j: chat({ chatId: 'j', folder: '/p/job', lastUpdated: 9, jobId: 'x' }),
        d: chat({ chatId: 'd', folder: '/p/gone', lastUpdated: 9, status: 'deleted' }),
        t: chat({ chatId: 't', folder: '/tmp', lastUpdated: 9 }),
      },
      { d1: { roots: ['/p/root', '/p/old'], recent: [] } },
    );
    expect(out.map((r) => [r.folder, r.lastUpdated])).toEqual([
      ['/p/new', 7],
      ['/p/old', 1],
      ['/p/root', 0],
    ]);
  });
  it('keeps the same folder on two hosts as two rows', () => {
    const out = buildRecentFolders(
      {
        a: chat({ chatId: 'a', folder: '/p/x' }),
        b: chat({ chatId: 'b', folder: '/p/x', daemonId: 'd2' }),
      },
      {},
    );
    expect(out).toHaveLength(2);
  });
});

describe('filterRows', () => {
  const recents = [
    { folder: '/home/tom/projects/alpha', daemonId: 'd1', lastUpdated: 2 },
    { folder: '/p/beta', daemonId: 'd2', lastUpdated: 1 },
  ];
  it('matches name or short path and narrows by host', () => {
    expect(filterRows(recents, 'alp', 'all').map((r) => r.name)).toEqual(['alpha']);
    expect(filterRows(recents, 'projects', 'all').map((r) => r.name)).toEqual(['alpha']);
    expect(filterRows(recents, '', 'd2').map((r) => r.name)).toEqual(['beta']);
    expect(filterRows(recents, '', 'all')).toHaveLength(2);
  });
});
