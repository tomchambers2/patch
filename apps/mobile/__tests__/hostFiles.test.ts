// Host files and terminal — the pure half (spec/15 § Host files and terminal).

import { describe, it, expect } from 'vitest';
import {
  childPath,
  editRoute,
  filesRoute,
  formatSize,
  isSaveConflict,
  startFolders,
  terminalRoute,
} from '../src/lib/hostFiles';
import { ApiError } from '../src/api/rest';

describe('startFolders', () => {
  it('is the host`s roots then recents, each once, in order', () => {
    expect(startFolders(['/p/a', '/p/b'], ['/p/c', '/p/a'])).toEqual(['/p/a', '/p/b', '/p/c']);
    expect(startFolders([], [])).toEqual([]);
  });
});

describe('isSaveConflict', () => {
  it('is a 409 from the server and nothing else', () => {
    expect(isSaveConflict(new ApiError(409, 'conflict: changed', null))).toBe(true);
    expect(isSaveConflict(new ApiError(404, 'not_found', null))).toBe(false);
    expect(isSaveConflict(new Error('409'))).toBe(false);
  });
});

describe('formatSize', () => {
  it('reads as a person would say it', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(1.3 * 1024 * 1024)).toBe('1.3 MB');
  });
});

describe('childPath', () => {
  it('joins without doubling the root slash', () => {
    expect(childPath('/', 'etc')).toBe('/etc');
    expect(childPath('/home/tom', '.claude')).toBe('/home/tom/.claude');
  });
});

describe('routes', () => {
  it('address the host screens with typed params, leaving out what was not given', () => {
    expect(filesRoute('d1')).toEqual({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1' },
    });
    expect(filesRoute('d1', '/x')).toEqual({
      pathname: '/hosts/[daemonId]/files',
      params: { daemonId: 'd1', path: '/x' },
    });
    expect(editRoute('d1', '/x/a.md')).toEqual({
      pathname: '/hosts/[daemonId]/edit',
      params: { daemonId: 'd1', path: '/x/a.md' },
    });
    expect(terminalRoute('d1')).toEqual({
      pathname: '/hosts/[daemonId]/terminal',
      params: { daemonId: 'd1' },
    });
    expect(terminalRoute('d1', '/x')).toEqual({
      pathname: '/hosts/[daemonId]/terminal',
      params: { daemonId: 'd1', folder: '/x' },
    });
  });
});
