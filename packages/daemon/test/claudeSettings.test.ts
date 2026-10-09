// Unit coverage for claudeSettings.ts's file-level behaviour that the
// index-main.test.ts full-boot test doesn't reach: the path-traversal guard
// on memory refs, and the MEMORY.md index line getting pruned alongside the
// file it points at.

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeHomeFromProjectsRoot,
  deleteClaudeMemory,
  InvalidMemoryRefError,
  InvalidSettingsJsonError,
  listClaudeMemories,
  MemoryNotFoundError,
  readClaudeSettingsJson,
  resolveProjectDir,
  setClaudeMemory,
  splitFrontmatter,
  writeClaudeSettingsJson,
} from '../src/claudeSettings.js';

/** Claude Code's own project-directory naming: every non-alphanumeric → `-`. */
function encodeProject(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'patch-claude-settings-'));
}

describe('claudeHomeFromProjectsRoot', () => {
  it('is the parent of the projects root, matching where Claude Code puts settings.json', () => {
    expect(claudeHomeFromProjectsRoot('/home/tom/.claude/projects')).toBe('/home/tom/.claude');
  });
});

describe('readClaudeSettingsJson / writeClaudeSettingsJson', () => {
  it('reads empty string when the host has no settings.json yet', () => {
    const home = makeRoot();
    try {
      expect(readClaudeSettingsJson(home)).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('round-trips valid JSON and refuses invalid JSON without touching the file on disk', () => {
    const home = makeRoot();
    try {
      writeClaudeSettingsJson(home, '{"model":"opus"}');
      expect(readClaudeSettingsJson(home)).toBe('{"model":"opus"}');

      expect(() => writeClaudeSettingsJson(home, '{not json')).toThrow(InvalidSettingsJsonError);
      // NO FALLBACK: a refused write must leave the last-good file in place.
      expect(readClaudeSettingsJson(home)).toBe('{"model":"opus"}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts an empty string as "no settings"', () => {
    const home = makeRoot();
    try {
      writeClaudeSettingsJson(home, '{"model":"opus"}');
      writeClaudeSettingsJson(home, '');
      expect(readClaudeSettingsJson(home)).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('listClaudeMemories', () => {
  it('returns [] when the projects root does not exist — no fallback to a guessed default', () => {
    expect(listClaudeMemories(join(makeRoot(), 'does-not-exist'))).toEqual([]);
  });

  it('excludes MEMORY.md itself and non-.md files, and parses frontmatter leniently', () => {
    const root = makeRoot();
    try {
      const memoryDir = join(root, 'proj-a', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'MEMORY.md'), '- an index line\n', 'utf8');
      writeFileSync(join(memoryDir, 'notes.txt'), 'not a memory file', 'utf8');
      writeFileSync(
        join(memoryDir, 'user_role.md'),
        '---\nname: user_role\ndescription: a description\ntype: user\n---\n\nBody.\n',
        'utf8',
      );
      // Malformed frontmatter (no closing `---`) still lists, with blank fields.
      writeFileSync(
        join(memoryDir, 'broken.md'),
        '---\nname: broken\nBody with no close.\n',
        'utf8',
      );

      const memories = listClaudeMemories(root);
      expect(memories).toHaveLength(2);
      // `proj-a` does not start with `-`, so it names no absolute folder and
      // `projectDir` is absent rather than guessed.
      expect(memories).toContainEqual({
        project: 'proj-a',
        file: 'user_role.md',
        name: 'user_role',
        description: 'a description',
        memoryType: 'user',
        body: 'Body.\n',
        updatedAt: expect.any(Number),
      });
      expect(memories).toContainEqual({
        project: 'proj-a',
        file: 'broken.md',
        name: '',
        description: '',
        memoryType: '',
        body: '---\nname: broken\nBody with no close.\n',
        updatedAt: expect.any(Number),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the file mtime and the real folder the encoded project name stands for', () => {
    const root = makeRoot();
    const disk = realpathSync(mkdtempSync(join(tmpdir(), 'patch-memory-dir-')));
    try {
      const folder = join(disk, 'my.app', 'web-ui');
      mkdirSync(folder, { recursive: true });
      const project = encodeProject(folder);
      const memoryDir = join(root, project, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'a.md'), '---\nname: a\n---\nText.\n', 'utf8');
      utimesSync(join(memoryDir, 'a.md'), 1_700_000_000, 1_700_000_000);
      // A project whose folder has since been deleted.
      const goneDir = join(root, encodeProject(join(disk, 'gone')), 'memory');
      mkdirSync(goneDir, { recursive: true });
      writeFileSync(join(goneDir, 'b.md'), 'No frontmatter.\n', 'utf8');

      const memories = listClaudeMemories(root);
      expect(memories.find((m) => m.file === 'a.md')).toMatchObject({
        project,
        projectDir: folder,
        body: 'Text.\n',
        updatedAt: 1_700_000_000_000,
      });
      const gone = memories.find((m) => m.file === 'b.md');
      expect(gone?.body).toBe('No frontmatter.\n');
      expect(gone).not.toHaveProperty('projectDir');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(disk, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectDir', () => {
  it('backtracks out of a folder that matches a prefix but leads nowhere', () => {
    const disk = realpathSync(mkdtempSync(join(tmpdir(), 'patch-resolve-')));
    try {
      // `<disk>/a/b-c` would read the same encoded, but only `<disk>/a-b/c`
      // exists; `<disk>/a` is a decoy with an unrelated child.
      mkdirSync(join(disk, 'a', 'x'), { recursive: true });
      mkdirSync(join(disk, 'a-b', 'c'), { recursive: true });
      expect(resolveProjectDir(encodeProject(join(disk, 'a-b', 'c')))).toBe(join(disk, 'a-b', 'c'));
    } finally {
      rmSync(disk, { recursive: true, force: true });
    }
  });

  it('reads dots and underscores both ways, since older Claude Code builds kept them', () => {
    const disk = realpathSync(mkdtempSync(join(tmpdir(), 'patch-resolve-')));
    try {
      const folder = join(disk, '.hidden', 'snake_case');
      mkdirSync(folder, { recursive: true });
      expect(resolveProjectDir(encodeProject(folder))).toBe(folder);
      expect(resolveProjectDir(folder.replace(/\//g, '-'))).toBe(folder);
    } finally {
      rmSync(disk, { recursive: true, force: true });
    }
  });

  it('is undefined for a folder that does not exist, and for a name that is not a path', () => {
    const disk = realpathSync(mkdtempSync(join(tmpdir(), 'patch-resolve-')));
    try {
      expect(resolveProjectDir(encodeProject(join(disk, 'nope')))).toBeUndefined();
      expect(resolveProjectDir('proj-a')).toBeUndefined();
      expect(resolveProjectDir('-')).toBe('/');
    } finally {
      rmSync(disk, { recursive: true, force: true });
    }
  });
});

describe('splitFrontmatter', () => {
  it('keeps the frontmatter and the blank line after it in the head', () => {
    expect(splitFrontmatter('---\nname: a\n---\n\nBody.\n')).toEqual({
      head: '---\nname: a\n---\n\n',
      body: 'Body.\n',
    });
    expect(splitFrontmatter('Just text.')).toEqual({ head: '', body: 'Just text.' });
  });
});

describe('setClaudeMemory', () => {
  it('replaces the body and keeps the frontmatter byte-for-byte', () => {
    const root = makeRoot();
    try {
      const memoryDir = join(root, 'proj-a', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      const frontmatter = '---\nname: a\ndescription:   spaced  \ntype: user\n---\n\n';
      writeFileSync(join(memoryDir, 'a.md'), frontmatter + 'Old.\n', 'utf8');

      setClaudeMemory(root, 'proj-a', 'a.md', 'New text.\n\nSecond paragraph.\n');

      expect(readFileSync(join(memoryDir, 'a.md'), 'utf8')).toBe(
        frontmatter + 'New text.\n\nSecond paragraph.\n',
      );
      expect(listClaudeMemories(root)[0]).toMatchObject({
        description: 'spaced',
        body: 'New text.\n\nSecond paragraph.\n',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('puts the body on its own line when the file ended on its closing ---', () => {
    const root = makeRoot();
    try {
      const memoryDir = join(root, 'proj-a', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'a.md'), '---\nname: a\n---', 'utf8');
      setClaudeMemory(root, 'proj-a', 'a.md', 'Body.');
      expect(readFileSync(join(memoryDir, 'a.md'), 'utf8')).toBe('---\nname: a\n---\nBody.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a ref that climbs out, a missing file, and the MEMORY.md index', () => {
    const root = makeRoot();
    try {
      const memoryDir = join(root, 'proj-a', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'MEMORY.md'), '- [A](a.md)\n', 'utf8');
      expect(() => setClaudeMemory(root, '../escape', 'a.md', 'x')).toThrow(InvalidMemoryRefError);
      expect(() => setClaudeMemory(root, 'proj-a', '../../x.md', 'x')).toThrow(
        InvalidMemoryRefError,
      );
      expect(() => setClaudeMemory(root, 'proj-a', 'nope.md', 'x')).toThrow(MemoryNotFoundError);
      expect(() => setClaudeMemory(root, 'proj-a', 'MEMORY.md', 'x')).toThrow(MemoryNotFoundError);
      // Nothing was created by the refusal.
      expect(existsSync(join(memoryDir, 'nope.md'))).toBe(false);
      expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe('- [A](a.md)\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deleteClaudeMemory', () => {
  it('rejects a project or file component that would climb out of the memory dir', () => {
    const root = makeRoot();
    try {
      expect(() => deleteClaudeMemory(root, '../escape', 'file.md')).toThrow(InvalidMemoryRefError);
      expect(() => deleteClaudeMemory(root, 'proj', '../../escape.md')).toThrow(
        InvalidMemoryRefError,
      );
      expect(() => deleteClaudeMemory(root, '', 'file.md')).toThrow(InvalidMemoryRefError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws MemoryNotFoundError, named, for a memory entry that does not exist', () => {
    const root = makeRoot();
    try {
      expect(() => deleteClaudeMemory(root, 'proj-a', 'nope.md')).toThrow(MemoryNotFoundError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes the file and prunes its line from MEMORY.md, leaving other lines intact', () => {
    const root = makeRoot();
    try {
      const memoryDir = join(root, 'proj-a', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'a.md'), '---\nname: a\n---\n', 'utf8');
      writeFileSync(join(memoryDir, 'b.md'), '---\nname: b\n---\n', 'utf8');
      writeFileSync(
        join(memoryDir, 'MEMORY.md'),
        '- [A](a.md) — about a\n- [B](b.md) — about b\n',
        'utf8',
      );

      deleteClaudeMemory(root, 'proj-a', 'a.md');

      expect(existsSync(join(memoryDir, 'a.md'))).toBe(false);
      expect(existsSync(join(memoryDir, 'b.md'))).toBe(true);
      const index = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
      expect(index).not.toContain('a.md');
      expect(index).toContain('b.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes the file even with no MEMORY.md index present — the file delete is what matters', () => {
    const root = makeRoot();
    try {
      const memoryDir = join(root, 'proj-a', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'a.md'), '---\nname: a\n---\n', 'utf8');

      deleteClaudeMemory(root, 'proj-a', 'a.md');

      expect(existsSync(join(memoryDir, 'a.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
