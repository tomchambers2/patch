// patch doesn't recognise tilde in workspace paths — every host entry point
// that accepts a raw folder string typed by a person expands a leading `~`
// through this helper before any fs call.

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '../src/expandHome.js';

describe('expandHome', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands ~/rest to a path under the home directory', () => {
    expect(expandHome('~/projects/example')).toBe(join(homedir(), 'projects/example'));
  });

  it('leaves an absolute path unchanged', () => {
    expect(expandHome('/home/tom/projects/example')).toBe('/home/tom/projects/example');
  });

  it('leaves a ~ that is not a leading path segment unchanged', () => {
    expect(expandHome('/home/tom/~backup')).toBe('/home/tom/~backup');
  });

  it('does not expand ~otheruser (unsupported, left as-is)', () => {
    expect(expandHome('~tom/projects')).toBe('~tom/projects');
  });
});
