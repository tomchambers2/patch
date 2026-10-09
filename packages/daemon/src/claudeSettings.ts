// Reads/writes a host's Claude Code settings.json and lists/edits/deletes its
// memory entries (spec/02 § Claude Code settings).
//
// Both live under the same root the host already resolves for Claude
// Code's OWN transcript history (`config.claudeProjectsRoot` — spec/02
// § Stack: "the agent's native history under ~/.claude/projects/... is read
// directly; we don't duplicate it"): `settings.json` sits in that root's
// parent directory, and each project's memory files sit under
// `<projectsRoot>/<project>/memory/`. Reusing the same root means the same
// PATCH_CLAUDE_PROJECTS_ROOT test override that sandboxes history reading
// also sandboxes this — nothing here can touch a real `~/.claude` in a test.
//
// NO FALLBACK: a settings.json write that would leave invalid JSON on disk is
// refused up front, and a memory file whose frontmatter cannot be parsed is
// still listed (with the unparsed fields blank) rather than hidden — a memory
// a person cannot see is not one they can delete.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeMemoryEntry } from '@patch/wire';

const MEMORY_INDEX_FILE = 'MEMORY.md';

export class InvalidSettingsJsonError extends Error {}
export class InvalidMemoryRefError extends Error {}
export class MemoryNotFoundError extends Error {}

/** `~/.claude` (or its test-sandboxed equivalent) from the projects root the host already resolves. */
export function claudeHomeFromProjectsRoot(claudeProjectsRoot: string): string {
  return dirname(claudeProjectsRoot);
}

/** Raw text of `<claudeHome>/settings.json`. Empty string when the host has none. */
export function readClaudeSettingsJson(claudeHome: string): string {
  const path = join(claudeHome, 'settings.json');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/**
 * Overwrite `<claudeHome>/settings.json` verbatim. Non-empty text must parse
 * as JSON — writing malformed config Claude Code would then fail to start
 * against is worse than refusing. Atomic write (temp + fsync + rename), the
 * same discipline `HostStateStore` uses for `host.json`.
 */
export function writeClaudeSettingsJson(claudeHome: string, json: string): void {
  const trimmed = json.trim();
  if (trimmed.length > 0) {
    try {
      JSON.parse(trimmed);
    } catch (e) {
      throw new InvalidSettingsJsonError((e as Error).message);
    }
  }
  mkdirSync(claudeHome, { recursive: true });
  const path = join(claudeHome, 'settings.json');
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, json, 'utf8');
  const fd = openSync(tmp, 'r');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/**
 * One file's YAML-ish frontmatter, parsed leniently — a missing field comes
 * back ''. Shared beyond memory files: a `SKILL.md`'s frontmatter uses the
 * same `key: value` shape and the same `description:` field, so the host's
 * skill listing (`handleSkillsRequest` in `index.ts`) reuses this rather than
 * writing a second parser for an identical shape.
 */
export function parseFrontmatter(text: string): {
  name: string;
  description: string;
  memoryType: string;
} {
  const fields = { name: '', description: '', memoryType: '' };
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return fields;
  for (const line of match[1]!.split('\n')) {
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    const v = (value ?? '').trim();
    if (key === 'name') fields.name = v;
    else if (key === 'description') fields.description = v;
    else if (key === 'type') fields.memoryType = v;
  }
  return fields;
}

/**
 * A file's WHOLE frontmatter block as a flat string map, keyed by whatever
 * field names it declares (`description`, `user-invocable`, `argument-hint`,
 * `allowed-tools`, ...) — unlike `parseFrontmatter` above, which only reads
 * the three fields memory files use and renames `type` to `memoryType`. Used
 * for a `SKILL.md`'s frontmatter (`handleSkillsRequest` in `index.ts`), where
 * the set of keys isn't known in advance and every one of them is shown
 * verbatim in the skill's preview panel. Keys may contain hyphens
 * (`user-invocable`); an empty or missing frontmatter block returns `{}`.
 */
export function parseFrontmatterFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return fields;
  for (const line of match[1]!.split('\n')) {
    const kv = /^([a-zA-Z][a-zA-Z0-9-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    fields[key!] = (value ?? '').trim();
  }
  return fields;
}

/** A path-safe project/file component: no separator, no `..` climb. */
function isSafeComponent(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && value !== '..';
}

/**
 * Split a memory file into its frontmatter block and its body.
 *
 * `head` is everything up to where the body starts: the `---` block AND the
 * blank line(s) after it, byte-for-byte, so an edit that writes `head + body`
 * leaves the frontmatter exactly as it was. A file with no (or unterminated)
 * frontmatter has an empty head and is all body.
 */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const match = /^---\n[\s\S]*?\n---(?:\n|$)\n*/.exec(text);
  if (!match) return { head: '', body: text };
  return { head: match[0], body: text.slice(match[0].length) };
}

/**
 * Does the real path segment `real` encode to `encoded`? Claude Code names a
 * project's directory by turning every character that is not a letter or digit
 * into `-` (older builds kept `.` and `_`), so an encoded `-` stands for any
 * non-alphanumeric character and every other character stands for itself.
 */
function segmentMatches(real: string, encoded: string): boolean {
  if (real.length !== encoded.length) return false;
  for (let i = 0; i < real.length; i++) {
    const r = real[i]!;
    const e = encoded[i]!;
    if (r === e) continue;
    if (e === '-' && !/[A-Za-z0-9]/.test(r)) continue;
    return false;
  }
  return true;
}

/**
 * The folder on this machine that Claude Code's encoded project name stands
 * for, or undefined when no existing directory encodes to it.
 *
 * The encoding is lossy (`/`, `.` and `-` all become `-`), so it is resolved
 * against the disk rather than decoded: starting at `/`, try every child
 * directory whose name matches a prefix of what is left, and backtrack when a
 * branch runs out. Where two real folders encode alike, the one with the
 * longer name at the first point they differ wins. `readdir` is cached through `cache`, so one
 * listing resolving many projects under the same home reads each directory
 * once.
 */
export function resolveProjectDir(
  encoded: string,
  cache: Map<string, string[]> = new Map(),
  fsRoot = '/',
): string | undefined {
  if (!encoded.startsWith('-')) return undefined;
  const childDirs = (dir: string): string[] => {
    const hit = cache.get(dir);
    if (hit) return hit;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(join(dir, entry.name)).isDirectory()) dirs.push(entry.name);
        } catch {
          // A dangling link is not a folder a project can live in.
        }
      }
    }
    // Longest name first, so where two real folders encode the same (`a-b`
    // beside `a/b`) the answer is the same on every read, and it is the one
    // needing the fewest guesses about which `-` was a separator.
    dirs.sort((a, b) => b.length - a.length || a.localeCompare(b));
    cache.set(dir, dirs);
    return dirs;
  };
  const walk = (dir: string, rest: string): string | undefined => {
    if (rest === '') return dir;
    for (const name of childDirs(dir)) {
      if (name.length > rest.length) continue;
      if (!segmentMatches(name, rest.slice(0, name.length))) continue;
      if (name.length === rest.length) return join(dir, name);
      if (rest[name.length] !== '-') continue;
      const found = walk(join(dir, name), rest.slice(name.length + 1));
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(fsRoot, encoded.slice(1));
}

/**
 * Every memory entry across every project on this host, each with its text
 * (frontmatter stripped), its file's mtime, and — when the folder still
 * exists — the real project folder its encoded name stands for. `MEMORY.md`
 * indexes are excluded — they are the structural index, not a memory entry
 * themselves. A project directory or memory dir that fails to read (missing,
 * permissions) contributes nothing rather than failing the whole listing.
 */
export function listClaudeMemories(
  claudeProjectsRoot: string,
  opts: { fsRoot?: string } = {},
): ClaudeMemoryEntry[] {
  if (!existsSync(claudeProjectsRoot)) return [];
  const out: ClaudeMemoryEntry[] = [];
  const dirCache = new Map<string, string[]>();
  for (const project of readdirSync(claudeProjectsRoot)) {
    const memoryDir = join(claudeProjectsRoot, project, 'memory');
    let files: string[] = [];
    try {
      if (statSync(memoryDir).isDirectory()) files = readdirSync(memoryDir);
    } catch {
      files = [];
    }
    let projectDir: string | undefined;
    let resolved = false;
    for (const file of files) {
      if (file === MEMORY_INDEX_FILE || !file.endsWith('.md')) continue;
      const path = join(memoryDir, file);
      let text: string;
      let updatedAt: number;
      try {
        text = readFileSync(path, 'utf8');
        updatedAt = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (!resolved) {
        projectDir = resolveProjectDir(project, dirCache, opts.fsRoot);
        resolved = true;
      }
      const fm = parseFrontmatter(text);
      out.push({
        project,
        file,
        name: fm.name,
        description: fm.description,
        memoryType: fm.memoryType,
        ...(projectDir !== undefined ? { projectDir } : {}),
        body: splitFrontmatter(text).body,
        updatedAt: Math.floor(updatedAt),
      });
    }
  }
  return out;
}

/**
 * Replace one memory entry's text, keeping its frontmatter (and the blank
 * line after it) byte-for-byte. Refused like the delete: a ref that would
 * leave the memory dir, or a file the host does not have. Atomic write, so a
 * chat reading the entry mid-edit sees the old text or the new, never half.
 */
export function setClaudeMemory(
  claudeProjectsRoot: string,
  project: string,
  file: string,
  body: string,
): void {
  if (!isSafeComponent(project) || !isSafeComponent(file)) {
    throw new InvalidMemoryRefError(`invalid memory reference: project=${project} file=${file}`);
  }
  const target = join(claudeProjectsRoot, project, 'memory', file);
  if (file === MEMORY_INDEX_FILE || !existsSync(target) || !statSync(target).isFile()) {
    throw new MemoryNotFoundError(`no memory file ${file} for project ${project}`);
  }
  const { head } = splitFrontmatter(readFileSync(target, 'utf8'));
  // A file that ends on its closing `---` has no newline to put the body after.
  const sep = head !== '' && !head.endsWith('\n') && body !== '' ? '\n' : '';
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, head + sep + body, 'utf8');
  renameSync(tmp, target);
}

/**
 * Delete one memory entry: the file itself, then its line in that project's
 * `MEMORY.md` index (matched by `(file)` appearing in the index line — the
 * link-target convention the memory-writing instructions use). The index
 * edit is best-effort: a missing or already-inconsistent index is left
 * alone rather than refused, because the file deletion is the operation that
 * matters and must still happen.
 */
export function deleteClaudeMemory(
  claudeProjectsRoot: string,
  project: string,
  file: string,
): void {
  if (!isSafeComponent(project) || !isSafeComponent(file)) {
    throw new InvalidMemoryRefError(`invalid memory reference: project=${project} file=${file}`);
  }
  const memoryDir = join(claudeProjectsRoot, project, 'memory');
  const target = join(memoryDir, file);
  if (!existsSync(target)) {
    throw new MemoryNotFoundError(`no memory file ${file} for project ${project}`);
  }
  rmSync(target);
  const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
  if (!existsSync(indexPath)) return;
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  const kept = lines.filter((line) => !line.includes(`(${file})`));
  if (kept.length !== lines.length) {
    writeFileSync(indexPath, kept.join('\n'), 'utf8');
  }
}
