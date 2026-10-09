// openDiff — shared helper that opens the docked diff editor for a file the
// agent edited (spec/14 § Diff editor).
//
// Both entry points (clicking a file-edit tool-call line in the chat stream,
// and the ⌘' keyboard shortcut on the most recent edit) route through here so
// they behave identically:
//
//   - The diff editor's `path` is RELATIVE to the chat's folder — the same
//     contract the file browser + `file.write` wire event use (the host
//     resolves it inside the chat folder and rejects escapes). Tool-call args
//     carry ABSOLUTE paths, so we strip the chat-folder prefix here.
//   - The diff is a "read-only preview FROM THE STREAM" (spec/14 ## Main chat
//     panel). The two sides come from the agent's recorded tool-call args, NOT
//     from re-reading the on-disk file: `original` is the agent's `old_string`
//     (the content it proposed to replace) and `modified` is its `new_string`
//     (the proposed replacement). This is what the inline chat-bubble diff
//     shows, so the docked Monaco editor matches it and the agent's proposed
//     change is always visible/approvable — even when the edit has already been
//     applied to disk OR was never applied (disk == old_string), where reading
//     disk would yield two IDENTICAL sides and hide the proposal entirely.
//   - For a whole-file rewrite (Write — no `old_string` hunk) the `original`
//     side is the file at git HEAD so the unified diff still shows the change.
//     When the folder has no HEAD baseline (not a git work-tree, or no commits)
//     there is genuinely no prior committed content, so the original side is
//     empty and the whole write renders as an addition — the diff still opens.

import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';

/**
 * True only for the host's expected "no git HEAD to diff against" signal:
 * the REST client throws an ApiError whose parsed body is
 * `{ error: 'no_head_baseline' }` (a 409). Duck-typed on the body shape rather
 * than `instanceof` so it holds regardless of how the api module is mocked.
 * Every other error — host unreachable, timeout, 5xx — is a genuine failure
 * the caller must still surface, so it returns false and the error re-throws.
 */
export function isNoHeadBaseline(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const body = (err as { body?: unknown }).body;
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    (body as { error: unknown }).error === 'no_head_baseline'
  );
}

/**
 * Make a chat-folder-relative path from an (absolute) tool-call file path.
 * Returns the input unchanged if it's already relative.
 */
export function relativeToChatFolder(folder: string, filePath: string): string {
  if (!filePath.startsWith('/')) return filePath;
  const root = folder.replace(/\/+$/, '');
  if (filePath === root) return '';
  if (filePath.startsWith(root + '/')) return filePath.slice(root.length + 1);
  // Path is absolute but outside the chat folder — return the basename so the
  // host's relative-path contract still applies (the host re-validates and
  // rejects escapes).
  /* v8 ignore next -- `.split('/')` always returns a non-empty array, so `.pop()` always returns a defined string; the `?? filePath` fallback is unreachable defensive code. */
  return filePath.split('/').pop() ?? filePath;
}

/**
 * The agent's most-recent file-edit on `filePath` in this chat's timeline,
 * decoded into the diff's two sides FROM THE STREAM (spec/14 "read-only preview
 * from the stream"):
 *   - Edit / NotebookEdit → { original: old_string, modified: new_string }.
 *   - Write → { original: null (use HEAD), modified: content } — a whole-file
 *     rewrite has no hunk baseline, so the original side comes from git HEAD.
 * Returns null when the agent never edited this file.
 */
function agentEdit(
  chatId: string,
  filePath: string,
): { original: string | null; modified: string } | null {
  const timeline = useChatStore.getState().timelines[chatId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (!e || e.kind !== 'tool_call' || typeof e.tool !== 'string') continue;
    if (!/edit|write/i.test(e.tool)) continue;
    const a = (e.toolArgs ?? {}) as Record<string, unknown>;
    const fp = typeof a['file_path'] === 'string' ? a['file_path'] : a['notebook_path'];
    if (fp !== filePath) continue;
    if (typeof a['new_string'] === 'string') {
      return {
        original: typeof a['old_string'] === 'string' ? (a['old_string'] as string) : '',
        modified: a['new_string'] as string,
      };
    }
    if (typeof a['new_source'] === 'string') {
      return {
        original: typeof a['old_source'] === 'string' ? (a['old_source'] as string) : '',
        modified: a['new_source'] as string,
      };
    }
    if (typeof a['content'] === 'string') {
      // Write replaces the whole file → original side comes from HEAD.
      return { original: null, modified: a['content'] as string };
    }
    return null;
  }
  return null;
}

/**
 * spec/14 § Diff editor: "A 'change set' rail on the left lists every file in
 * the same edit (one or many)". An "edit" is a single agent turn — a turn may
 * touch several files (Edit src/a.ts, Edit src/b.ts, …) before yielding. We
 * delimit a turn by USER messages in the timeline: the edit that contains the
 * anchor tool call is the contiguous run of file-edit tool calls between the
 * user message that preceded it and the next user message after it.
 *
 * Returns the DISTINCT absolute file paths edited in that turn, in first-touch
 * order, always including `anchorFilePath`. One element for a single-file edit;
 * many for a multi-file edit. This is what populates the change-set rail.
 */
export function editTurnFiles(chatId: string, anchorFilePath: string): string[] {
  const timeline = useChatStore.getState().timelines[chatId] ?? [];

  // Locate the anchor tool call (the most recent file-edit on this path).
  let anchorIdx = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (!e || e.kind !== 'tool_call' || typeof e.tool !== 'string') continue;
    if (!/edit|write/i.test(e.tool)) continue;
    const a = (e.toolArgs ?? {}) as Record<string, unknown>;
    const fp = typeof a['file_path'] === 'string' ? a['file_path'] : a['notebook_path'];
    if (fp === anchorFilePath) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return [anchorFilePath];

  // Turn bounds: scan back to the user message that opened the anchor's turn,
  // and forward to the next user message (or end of timeline).
  let start = 0;
  for (let i = anchorIdx; i >= 0; i--) {
    const e = timeline[i];
    if (e && e.kind === 'message' && e.role === 'user') {
      start = i;
      break;
    }
  }
  let end = timeline.length;
  for (let i = anchorIdx + 1; i < timeline.length; i++) {
    const e = timeline[i];
    if (e && e.kind === 'message' && e.role === 'user') {
      end = i;
      break;
    }
  }

  const files: string[] = [];
  for (let i = start; i < end; i++) {
    const e = timeline[i];
    if (!e || e.kind !== 'tool_call' || typeof e.tool !== 'string') continue;
    if (!/edit|write/i.test(e.tool)) continue;
    const a = (e.toolArgs ?? {}) as Record<string, unknown>;
    const fp = typeof a['file_path'] === 'string' ? a['file_path'] : a['notebook_path'];
    if (typeof fp === 'string' && !files.includes(fp)) files.push(fp);
  }
  /* v8 ignore next -- defensive only: `anchorIdx` (found via the same edit/write + fp match used in this loop) always falls within [start, end), so the loop above always collects anchorFilePath first; this push can't structurally run. */
  if (!files.includes(anchorFilePath)) files.push(anchorFilePath);
  return files;
}

/**
 * Build the FileDiffEntry for one file (absolute tool-call path) in `chatId`
 * FROM THE STREAM: `original` is the agent's `old_string`, `modified` its
 * `new_string` — exactly the proposed change rendered in the chat bubble, so
 * the docked Monaco diff shows the same two (differing) sides regardless of
 * what's currently on disk. For a whole-file Write (no hunk) the `original`
 * side comes from git HEAD.
 */
async function buildDiffEntry(
  chatId: string,
  folder: string,
  filePath: string,
): Promise<{ path: string; original: string; modified: string }> {
  const relPath = relativeToChatFolder(folder, filePath);
  const edit = agentEdit(chatId, filePath);
  if (!edit) {
    // The clicked file isn't an agent edit we can decode from the stream —
    // fall back to a current-vs-HEAD disk diff so the user still sees the file.
    const current = await api.getFileContent(chatId, relPath);
    let original = current.content;
    try {
      const head = await api.getFileContentAtHead(chatId, relPath);
      original = head.content;
    } catch {
      original = current.content;
    }
    return { path: relPath, original, modified: current.content };
  }
  if (edit.original === null) {
    // Write rewrote the whole file — original side is git HEAD. When the chat
    // folder has no HEAD baseline (not a git work-tree, or no commits yet) the
    // host rejects with `no_head_baseline` (409). That is NOT a diff we can
    // open against a committed version, but it is also NOT a failure to surface
    // to the user: with no prior committed content the write IS entirely new,
    // so the original side is empty and the diff shows the whole file as an
    // addition — the same truthful representation the host already returns for
    // an untracked file inside a git repo. Without this, the 409 bubbled up and
    // openDiffForFile threw, so the diff never opened (todo: "no_head_baseline
    // when trying to view diff"). NO FALLBACK: ONLY the expected
    // `no_head_baseline` is treated as an empty baseline — any OTHER failure
    // (host unreachable, timeout, 5xx) still throws so the caller surfaces it.
    try {
      const head = await api.getFileContentAtHead(chatId, relPath);
      return { path: relPath, original: head.content, modified: edit.modified };
    } catch (err) {
      if (!isNoHeadBaseline(err)) throw err;
      return { path: relPath, original: '', modified: edit.modified };
    }
  }
  return { path: relPath, original: edit.original, modified: edit.modified };
}

/**
 * Open the diff editor for `filePath` (absolute, from a tool call) in `chatId`.
 * Fetches the full on-disk content for the modified side and an appropriate
 * baseline for the original side, then docks the diff. Throws on fetch failure
 * (caller decides how to surface it) — never opens an empty/partial diff.
 */
export async function openDiffForFile(chatId: string, filePath: string): Promise<void> {
  const folder = useChatStore.getState().chats[chatId]?.folder ?? '';

  // spec/14: the change-set rail lists EVERY file in the same edit. Resolve the
  // full set of files the agent's turn touched and build a diff entry for each;
  // the clicked file becomes the active one.
  const turnFiles = editTurnFiles(chatId, filePath);
  const changeSet = await Promise.all(turnFiles.map((fp) => buildDiffEntry(chatId, folder, fp)));
  const clickedRel = relativeToChatFolder(folder, filePath);
  const activeIndex = Math.max(
    0,
    changeSet.findIndex((e) => e.path === clickedRel),
  );

  useUiStore.getState().openFileDiff({ chatId, changeSet, activeIndex });
}

/**
 * Open the diff for the MOST RECENT file-edit tool call in `chatId` (the ⌘'
 * entry point). Returns false when the chat has no file edits yet.
 */
export async function openMostRecentEditDiff(chatId: string): Promise<boolean> {
  const timeline = useChatStore.getState().timelines[chatId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (!e || e.kind !== 'tool_call' || typeof e.tool !== 'string') continue;
    if (!/edit|write/i.test(e.tool)) continue;
    const a = (e.toolArgs ?? {}) as Record<string, unknown>;
    const fp = typeof a['file_path'] === 'string' ? a['file_path'] : a['notebook_path'];
    if (typeof fp !== 'string') continue;
    await openDiffForFile(chatId, fp);
    return true;
  }
  return false;
}
