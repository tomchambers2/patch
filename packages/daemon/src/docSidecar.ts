// Document editor — modes, suggestions, comments, history (spec/14 § Document
// editor, step 2 of 3). Everything that is NOT the document's own Markdown
// text lives in a sidecar JSON beside it, `.<name>.patch-doc.json`, so the
// `.md` file itself stays exactly what the user wrote (round-trips cleanly,
// per step 1's own FORMAT requirement) and every other surface reading it
// (git, the plain editor, an export) never sees patch's own bookkeeping.
//
// Pure, synchronous, filesystem-only — no chat/daemon state. `chatRunner.ts`
// resolves `chatId` to a chat folder and an absolute path, then calls into
// here; the daemon-internal routes mcp.ts's tools hit do the same.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ulid } from 'ulid';

export type DocMode = 'change' | 'propose' | 'comment';

export interface DocSuggestion {
  id: string;
  find: string;
  replace: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export interface DocCommentEntry {
  id: string;
  author: 'user' | 'agent';
  text: string;
  createdAt: number;
}

export interface DocThread {
  id: string;
  anchor: string;
  resolved: boolean;
  comments: DocCommentEntry[];
}

export interface DocVersion {
  id: string;
  content: string;
  savedBy: 'user' | 'agent';
  createdAt: number;
  restoredFrom?: string;
}

/** Set once this `.md` was produced by converting a `.docx` (spec/14 § Document editor, step 3 of 3) — lets a re-open of the same `.docx` skip reconverting (and so never clobbers edits made since) when the source hasn't changed. */
export interface DocSourceDocx {
  /** The `.docx`'s own path, relative to the chat folder. */
  path: string;
  mtimeMs: number;
}

export interface DocSidecarData {
  mode: DocMode;
  suggestions: DocSuggestion[];
  threads: DocThread[];
  versions: DocVersion[];
  sourceDocx?: DocSourceDocx;
  /** Anything the last `.docx` import couldn't carry over — named on open rather than silently dropped. */
  importWarnings?: string[];
}

export function defaultSidecar(): DocSidecarData {
  return { mode: 'change', suggestions: [], threads: [], versions: [] };
}

/** `notes.md` → `.notes.md.patch-doc.json`, in the same directory. */
export function sidecarPathFor(mdAbsPath: string): string {
  return join(dirname(mdAbsPath), `.${basename(mdAbsPath)}.patch-doc.json`);
}

/**
 * Missing sidecar is the overwhelmingly common case (most `.md` files have
 * never been through this feature) and means the default, not an error. A
 * sidecar that exists but fails to parse is a real bug — NO FALLBACK, let it
 * throw.
 */
export function readSidecar(mdAbsPath: string): DocSidecarData {
  const path = sidecarPathFor(mdAbsPath);
  if (!existsSync(path)) return defaultSidecar();
  return JSON.parse(readFileSync(path, 'utf8')) as DocSidecarData;
}

/** Same atomic tmp-write + fsync + rename `chatRunner.ts`'s `writeFile` uses for the document itself. */
export function writeSidecar(mdAbsPath: string, data: DocSidecarData): void {
  const path = sidecarPathFor(mdAbsPath);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.patch-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o644 });
  const fd = openSync(tmp, 'r');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/** How many non-overlapping times `needle` occurs in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export class DocConflictError extends Error {}

/**
 * `find` → `replace` against `content`, requiring EXACTLY one match — the
 * same contract the native `Edit` tool holds `old_string` to. Thrown
 * (`DocConflictError`), not returned, because every caller (create, accept
 * one, accept all) treats "the document moved out from under this
 * suggestion" as a real failure to report, never a silent no-op.
 */
export function applyFindReplace(content: string, find: string, replace: string): string {
  const count = countOccurrences(content, find);
  if (count === 0) {
    throw new DocConflictError(`"${find}" is no longer in the document`);
  }
  if (count > 1) {
    throw new DocConflictError(`"${find}" matches ${count} places in the document — not unique`);
  }
  const at = content.indexOf(find);
  return content.slice(0, at) + replace + content.slice(at + find.length);
}

/** Pushed on every real content change — see `chatRunner.ts`'s `writeFile` and its agent-edit hook. */
export function recordVersion(
  sidecar: DocSidecarData,
  content: string,
  savedBy: 'user' | 'agent',
  now: number,
  restoredFrom?: string,
): void {
  sidecar.versions.push({
    id: ulid(),
    content,
    savedBy,
    createdAt: now,
    ...(restoredFrom !== undefined ? { restoredFrom } : {}),
  });
}
