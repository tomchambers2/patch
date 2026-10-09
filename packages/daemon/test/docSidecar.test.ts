// Document editor — sidecar storage (spec/14 § Document editor, step 2 of 3).
// Pure filesystem helpers: no chat/daemon state.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFindReplace,
  countOccurrences,
  defaultSidecar,
  DocConflictError,
  readSidecar,
  recordVersion,
  sidecarPathFor,
  writeSidecar,
} from '../src/docSidecar.js';

function tmpMd(content = '# Title\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'patch-docsidecar-'));
  const path = join(dir, 'notes.md');
  writeFileSync(path, content);
  return path;
}

describe('sidecarPathFor', () => {
  it('names the sidecar as a dotfile beside the document', () => {
    expect(sidecarPathFor('/tmp/foo/notes.md')).toBe('/tmp/foo/.notes.md.patch-doc.json');
  });
});

describe('readSidecar / writeSidecar', () => {
  it('defaults to change mode with nothing recorded when no sidecar exists', () => {
    const md = tmpMd();
    expect(readSidecar(md)).toEqual(defaultSidecar());
    expect(existsSync(sidecarPathFor(md))).toBe(false);
  });

  it('round-trips a written sidecar', () => {
    const md = tmpMd();
    const data = defaultSidecar();
    data.mode = 'propose';
    recordVersion(data, '# Title\n', 'user', 1000);
    writeSidecar(md, data);
    expect(readSidecar(md)).toEqual(data);
    expect(existsSync(sidecarPathFor(md))).toBe(true);
  });

  it('writes the sidecar as pretty JSON, not inside the document itself', () => {
    const md = tmpMd('# Title\nUnchanged.\n');
    const before = readFileSync(md, 'utf8');
    const data = defaultSidecar();
    data.mode = 'comment';
    writeSidecar(md, data);
    expect(readFileSync(md, 'utf8')).toBe(before);
    expect(readFileSync(sidecarPathFor(md), 'utf8')).toContain('"mode": "comment"');
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping matches', () => {
    expect(countOccurrences('abcabcabc', 'abc')).toBe(3);
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('nothing here', 'xyz')).toBe(0);
    expect(countOccurrences('anything', '')).toBe(0);
  });
});

describe('applyFindReplace', () => {
  it('replaces a unique match', () => {
    expect(applyFindReplace('one two three', 'two', 'TWO')).toBe('one TWO three');
  });

  it('supports a pure insertion (find = anchor, replace = anchor + inserted text)', () => {
    expect(applyFindReplace('Hello world.', 'Hello', 'Hello there,')).toBe('Hello there, world.');
  });

  it('supports a pure deletion (replace = "")', () => {
    expect(applyFindReplace('Hello world.', ' world', '')).toBe('Hello.');
  });

  it('throws DocConflictError when find is not present', () => {
    expect(() => applyFindReplace('one two three', 'four', 'FOUR')).toThrow(DocConflictError);
  });

  it('throws DocConflictError when find is not unique', () => {
    expect(() => applyFindReplace('one one one', 'one', 'ONE')).toThrow(DocConflictError);
  });
});

describe('recordVersion', () => {
  it('appends a version with the given content, author and timestamp', () => {
    const data = defaultSidecar();
    recordVersion(data, 'v1', 'user', 100);
    recordVersion(data, 'v2', 'agent', 200);
    expect(data.versions).toHaveLength(2);
    expect(data.versions[0]).toMatchObject({ content: 'v1', savedBy: 'user', createdAt: 100 });
    expect(data.versions[1]).toMatchObject({ content: 'v2', savedBy: 'agent', createdAt: 200 });
    expect(data.versions[0]!.id).not.toBe(data.versions[1]!.id);
  });

  it('stamps restoredFrom only when given', () => {
    const data = defaultSidecar();
    recordVersion(data, 'v1', 'user', 100, 'some-version-id');
    expect(data.versions[0]!.restoredFrom).toBe('some-version-id');
  });
});
