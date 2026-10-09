// Folder-picker option ordering (spec/04 § Folders, spec/15 § New chat flow).
// The picker offers host-owned folders FIRST, then folders seen in chats,
// deduped — the user taps a known folder rather than typing a path.

import { describe, it, expect } from 'vitest';
import { folderOptions, defaultFolder } from '../src/lib/folderOptions';

describe('folderOptions', () => {
  it('lists host folders first, then chat folders', () => {
    expect(folderOptions(['/daemon/a', '/daemon/b'], ['/chat/c'])).toEqual([
      '/daemon/a',
      '/daemon/b',
      '/chat/c',
    ]);
  });

  it('de-dupes a folder present in both sources (host wins the slot)', () => {
    expect(folderOptions(['/shared', '/daemon/x'], ['/chat/y', '/shared'])).toEqual([
      '/shared',
      '/daemon/x',
      '/chat/y',
    ]);
  });

  it('renders the host folders even when there are no chats yet', () => {
    expect(folderOptions(['/daemon/only'], [])).toEqual(['/daemon/only']);
  });

  it('drops empty entries', () => {
    expect(folderOptions(['', '/daemon/a'], ['', '/chat/b'])).toEqual(['/daemon/a', '/chat/b']);
  });

  it('drops junk recents (/tmp, .patch/threads/*, dot-dirs) — spec/04 § Folders', () => {
    expect(
      folderOptions(
        ['/home/tom/projects/patch'],
        ['/tmp', '/app/.patch/threads/manager', '/home/tom/.config/x', '/home/tom/projects/real'],
      ),
    ).toEqual(['/home/tom/projects/patch', '/home/tom/projects/real']);
  });
});

describe('defaultFolder', () => {
  it('defaults to the most-recently-used chat folder', () => {
    expect(defaultFolder(['/daemon/a'], ['/chat/mru', '/chat/older'])).toBe('/chat/mru');
  });

  it('falls back to the first host folder on a fresh install (no chats)', () => {
    expect(defaultFolder(['/daemon/a', '/daemon/b'], [])).toBe('/daemon/a');
  });

  it('returns empty when nothing is known', () => {
    expect(defaultFolder([], [])).toBe('');
  });

  it('skips a junk recent when picking the default (spec/04 § Folders)', () => {
    expect(defaultFolder(['/daemon/a'], ['/tmp', '/chat/real'])).toBe('/chat/real');
  });
});
