// G3-1 / G3-d1: the shared diff-opener used by BOTH the tool-call click and the
// ⌘' keyboard shortcut. Asserts:
//   - tool-call ABSOLUTE paths are converted to chat-folder-RELATIVE paths (the
//     file.write contract — the host writes inside the chat folder),
//   - the diff is built FROM THE STREAM: `original` = the agent's old_string,
//     `modified` = its new_string, so the proposed change is always visible
//     even when disk == old_string (the G3-d1 identical-sides defect),
//   - a whole-file Write uses git HEAD for the original side,
//   - the keyboard entry point opens the MOST RECENT edit.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const getFileContent = vi.fn();
const getFileContentAtHead = vi.fn();
// Keep the REAL ApiError class — openDiff narrows no_head_baseline with
// `instanceof ApiError`, so a stub class would defeat that check.
vi.mock('../api/rest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/rest.js')>();
  return {
    ApiError: actual.ApiError,
    api: {
      getFileContent: (...a: unknown[]) => getFileContent(...a),
      getFileContentAtHead: (...a: unknown[]) => getFileContentAtHead(...a),
    },
  };
});

import { ApiError } from '../api/rest.js';
import { relativeToChatFolder, openDiffForFile, openMostRecentEditDiff } from '../lib/openDiff.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';

function seed(chatId: string, folder: string, timeline: unknown[]): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder,
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: timeline as never } }));
}

describe('relativeToChatFolder', () => {
  it('strips the chat-folder prefix from an absolute path', () => {
    expect(relativeToChatFolder('/private/tmp/proj', '/private/tmp/proj/src/a.ts')).toBe(
      'src/a.ts',
    );
  });
  it('handles a trailing slash on the folder', () => {
    expect(relativeToChatFolder('/private/tmp/proj/', '/private/tmp/proj/a.ts')).toBe('a.ts');
  });
  it('returns a relative path unchanged', () => {
    expect(relativeToChatFolder('/private/tmp/proj', 'src/a.ts')).toBe('src/a.ts');
  });
  it('falls back to the basename for an absolute path outside the folder', () => {
    expect(relativeToChatFolder('/private/tmp/proj', '/etc/passwd')).toBe('passwd');
  });
  it('returns an empty string when the path IS the folder root itself', () => {
    expect(relativeToChatFolder('/private/tmp/proj', '/private/tmp/proj')).toBe('');
  });
});

describe('openDiffForFile', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useLayoutStore.getState()._reset();
    useUiStore.getState().clearFileDiff();
    getFileContent.mockReset();
    getFileContentAtHead.mockReset();
  });

  it('opens a docked diff from the stream: original=old_string, modified=new_string (G3-d1)', async () => {
    seed('c1', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: {
          file_path: '/private/tmp/proj/src/a.ts',
          old_string: 'old\n',
          new_string: 'new\n',
        },
        at: 0,
      },
    ]);
    // Disk content is NOT consulted for an Edit hunk — the diff comes from the
    // stream. (If it were, and disk==old_string, both sides would be identical.)
    getFileContent.mockResolvedValue({ path: 'src/a.ts', content: 'old\n', size: 0 });

    await openDiffForFile('c1', '/private/tmp/proj/src/a.ts');

    // No disk read for a decodable Edit hunk.
    expect(getFileContent).not.toHaveBeenCalled();
    const fd = useUiStore.getState().fileDiff;
    expect(fd).not.toBeNull();
    // spec/14 § Panes and tabs: each file in the change set opens as its own
    // tab ("one tab per file") instead of a docked rail.
    expect(
      useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c1', path: 'src/a.ts' }),
    ).not.toBeNull();
    const active = fd!.changeSet[fd!.activeIndex]!;
    expect(active.path).toBe('src/a.ts'); // RELATIVE path
    expect(active.original).toBe('old\n'); // agent's old_string
    expect(active.modified).toBe('new\n'); // agent's PROPOSED new_string
    // The two sides differ — the proposal is visible/approvable.
    expect(active.original).not.toBe(active.modified);
  });

  it('shows the proposed change even when disk already equals old_string (the G3-d1 defect)', async () => {
    // Reproduces g3clean: agent Edit note.txt old="hello world" new="hello
    // patch", but disk == HEAD == "hello world" (edit never applied). Reading
    // disk for the modified side gave two identical "hello world" sides and hid
    // the proposal. From the stream the modified side is the proposed "hello
    // patch".
    seed('clean', '/private/tmp/g3clean', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: {
          file_path: '/private/tmp/g3clean/note.txt',
          old_string: 'hello world\n',
          new_string: 'hello patch\n',
        },
        at: 0,
      },
    ]);
    getFileContent.mockResolvedValue({ path: 'note.txt', content: 'hello world\n', size: 0 });

    await openDiffForFile('clean', '/private/tmp/g3clean/note.txt');
    const active = useUiStore.getState().fileDiff!.changeSet[0]!;
    expect(active.original).toBe('hello world\n');
    expect(active.modified).toBe('hello patch\n');
    expect(active.original).not.toBe(active.modified);
  });

  it('builds a MULTI-FILE change-set listing every file in the same agent turn (G3-5)', async () => {
    // A single turn (user message → several Edits → next user message) that
    // touches three distinct files. spec/14: the change-set rail lists EVERY
    // file in the same edit so the user can navigate between them.
    seed('m1', '/private/tmp/proj', [
      { seq: 1, kind: 'message', role: 'user', content: 'edit everything', at: 0 },
      {
        seq: 2,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/note.txt', old_string: 'a\n', new_string: 'b\n' },
        at: 1,
      },
      {
        seq: 3,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: {
          file_path: '/private/tmp/proj/src/layout.ts',
          old_string: 'c\n',
          new_string: 'd\n',
        },
        at: 2,
      },
      {
        seq: 4,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: {
          file_path: '/private/tmp/proj/README.md',
          old_string: 'e\n',
          new_string: 'f\n',
        },
        at: 3,
      },
      { seq: 5, kind: 'message', role: 'assistant', content: 'done', at: 4 },
    ]);
    // Click the SECOND file's tool-call line.
    await openDiffForFile('m1', '/private/tmp/proj/src/layout.ts');

    const fd = useUiStore.getState().fileDiff!;
    // Every file in the turn, in first-touch order.
    expect(fd.changeSet.map((e) => e.path)).toEqual(['note.txt', 'src/layout.ts', 'README.md']);
    // The clicked file is the active one — cross-file navigation works because
    // the rail has all three to switch between.
    expect(fd.changeSet[fd.activeIndex]!.path).toBe('src/layout.ts');
    // Each entry carries its own old_string / new_string straight from the stream.
    expect(fd.changeSet[0]!.original).toBe('a\n');
    expect(fd.changeSet[0]!.modified).toBe('b\n');
    expect(fd.changeSet[2]!.original).toBe('e\n');
    expect(fd.changeSet[2]!.modified).toBe('f\n');
    // No disk reads for decodable Edit hunks.
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it('does NOT cross a user-message turn boundary into a separate edit', async () => {
    // Two separate turns; opening the diff for the second turn's file must list
    // ONLY that turn's file, not the earlier turn's.
    seed('m2', '/private/tmp/proj', [
      { seq: 1, kind: 'message', role: 'user', content: 'first', at: 0 },
      {
        seq: 2,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/early.ts', old_string: 'a', new_string: 'b' },
        at: 1,
      },
      { seq: 3, kind: 'message', role: 'user', content: 'second', at: 2 },
      {
        seq: 4,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/late.ts', old_string: 'c', new_string: 'd' },
        at: 3,
      },
    ]);
    getFileContent.mockImplementation((_c: string, rel: string) =>
      Promise.resolve({ path: rel, content: `disk:${rel}`, size: 0 }),
    );

    await openDiffForFile('m2', '/private/tmp/proj/late.ts');
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet.map((e) => e.path)).toEqual(['late.ts']);
  });

  it('stops the change-set turn at a later user message (not the end of the timeline)', async () => {
    seed('m3', '/private/tmp/proj', [
      { seq: 1, kind: 'message', role: 'user', content: 'first', at: 0 },
      {
        seq: 2,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/only.ts', old_string: 'a', new_string: 'b' },
        at: 1,
      },
      // A later turn exists after the anchor's edit — editTurnFiles must stop
      // at this boundary rather than scanning to the end of the timeline.
      { seq: 3, kind: 'message', role: 'user', content: 'second', at: 2 },
      {
        seq: 4,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/other.ts', old_string: 'c', new_string: 'd' },
        at: 3,
      },
    ]);
    await openDiffForFile('m3', '/private/tmp/proj/only.ts');
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet.map((e) => e.path)).toEqual(['only.ts']);
  });

  it('agentEdit returns null (no baseline decode) for a path with no matching tool call at all', async () => {
    // No tool_call in the timeline references this path, so editTurnFiles falls
    // back to [anchorFilePath] and agentEdit's scan runs to completion with no
    // match, hitting its final `return null`.
    seed('nomatch', '/private/tmp/proj', [
      { seq: 1, kind: 'message', role: 'user', content: 'hi', at: 0 },
    ]);
    getFileContent.mockResolvedValue({ path: 'ghost.ts', content: 'disk', size: 0 });
    getFileContentAtHead.mockResolvedValue({ path: 'ghost.ts', content: 'disk-head', size: 0 });

    await openDiffForFile('nomatch', '/private/tmp/proj/ghost.ts');
    const active = useUiStore.getState().fileDiff!.changeSet[0]!;
    expect(active.path).toBe('ghost.ts');
    expect(active.original).toBe('disk-head');
    expect(active.modified).toBe('disk');
  });

  it('decodes a NotebookEdit hunk via old_source/new_source', async () => {
    seed('nb1', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'NotebookEdit',
        toolArgs: {
          notebook_path: '/private/tmp/proj/nb.ipynb',
          old_source: 'print(1)',
          new_source: 'print(2)',
        },
        at: 0,
      },
    ]);
    await openDiffForFile('nb1', '/private/tmp/proj/nb.ipynb');
    const active = useUiStore.getState().fileDiff!.changeSet[0]!;
    expect(active.original).toBe('print(1)');
    expect(active.modified).toBe('print(2)');
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it('falls back to a current-vs-HEAD disk diff when the file is not a decodable agent edit', async () => {
    // The clicked file appears in the timeline (so editTurnFiles finds it) but
    // its tool call carries none of old_string/new_string/old_source/new_source/
    // content — agentEdit returns null for it.
    seed('nodecode', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/mystery.ts' },
        at: 0,
      },
    ]);
    getFileContent.mockResolvedValue({ path: 'mystery.ts', content: 'disk-current', size: 0 });
    getFileContentAtHead.mockResolvedValue({ path: 'mystery.ts', content: 'disk-head', size: 0 });

    await openDiffForFile('nodecode', '/private/tmp/proj/mystery.ts');
    const active = useUiStore.getState().fileDiff!.changeSet[0]!;
    expect(getFileContent).toHaveBeenCalledWith('nodecode', 'mystery.ts');
    expect(getFileContentAtHead).toHaveBeenCalledWith('nodecode', 'mystery.ts');
    expect(active.original).toBe('disk-head');
    expect(active.modified).toBe('disk-current');
  });

  it('falls back to current content for original when the HEAD fetch throws (no baseline)', async () => {
    seed('nohead', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/new-file.ts' },
        at: 0,
      },
    ]);
    getFileContent.mockResolvedValue({ path: 'new-file.ts', content: 'disk-current', size: 0 });
    getFileContentAtHead.mockRejectedValue(new Error('not found at HEAD'));

    await openDiffForFile('nohead', '/private/tmp/proj/new-file.ts');
    const active = useUiStore.getState().fileDiff!.changeSet[0]!;
    expect(active.original).toBe('disk-current');
    expect(active.modified).toBe('disk-current');
  });

  it('handles a chat with no timeline entry at all (falls back to [] for both scans)', async () => {
    useChatStore.getState()._reset();
    getFileContent.mockResolvedValue({ path: 'x.ts', content: 'disk', size: 0 });
    getFileContentAtHead.mockResolvedValue({ path: 'x.ts', content: 'disk-head', size: 0 });
    // 'brand-new-chat' has no chats[] entry and no timelines[] entry.
    await openDiffForFile('brand-new-chat', '/some/x.ts');
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet[0]!.path).toBe('some/x.ts');
    expect(fd.changeSet[0]!.original).toBe('disk-head');
  });

  it('defaults old_string/old_source to "" when the agent omits them', async () => {
    seed('nohunk', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/a.ts', new_string: 'new only' },
        at: 0,
      },
    ]);
    await openDiffForFile('nohunk', '/private/tmp/proj/a.ts');
    expect(useUiStore.getState().fileDiff!.changeSet[0]!.original).toBe('');

    seed('nohunk2', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'NotebookEdit',
        toolArgs: { notebook_path: '/private/tmp/proj/b.ipynb', new_source: 'new only' },
        at: 0,
      },
    ]);
    await openDiffForFile('nohunk2', '/private/tmp/proj/b.ipynb');
    expect(useUiStore.getState().fileDiff!.changeSet[0]!.original).toBe('');
  });

  it('handles a tool call with no toolArgs at all (undefined) without throwing', async () => {
    seed('noargs', '/private/tmp/proj', [
      { seq: 1, kind: 'tool_call', tool: 'Edit', at: 0 },
      {
        seq: 2,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/anchor.ts', old_string: 'a', new_string: 'b' },
        at: 1,
      },
    ]);
    await openDiffForFile('noargs', '/private/tmp/proj/anchor.ts');
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet.map((e) => e.path)).toEqual(['anchor.ts']);
  });

  it('does not duplicate the anchor file when it is already the last file collected in the turn', async () => {
    // The anchor's own tool call is scanned again in the files-collection pass,
    // so by construction it is already included — this exercises the
    // `!files.includes(anchorFilePath)` false branch.
    seed('dup', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/only.ts', old_string: 'a', new_string: 'b' },
        at: 0,
      },
    ]);
    await openDiffForFile('dup', '/private/tmp/proj/only.ts');
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet.map((e) => e.path)).toEqual(['only.ts']);
  });

  it('resolves an empty folder when the chat is unknown (chats[chatId] is undefined)', async () => {
    // No seed() call — 'ghost-chat' was never hydrated, so chats[chatId] is
    // undefined and openDiffForFile must fall back to folder ''.
    useChatStore.getState()._reset();
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        'ghost-chat': [
          {
            seq: 1,
            kind: 'tool_call',
            tool: 'Edit',
            toolArgs: { file_path: '/abs/path.ts', old_string: 'a', new_string: 'b' },
            at: 0,
          },
        ] as never,
      },
    }));
    await openDiffForFile('ghost-chat', '/abs/path.ts');
    const fd = useUiStore.getState().fileDiff!;
    // relativeToChatFolder('', '/abs/path.ts'): an empty root's "root + '/'"
    // is just '/', which every absolute path starts with, so it strips only
    // the leading slash.
    expect(fd.changeSet[0]!.path).toBe('abs/path.ts');
  });

  it('falls back to HEAD content as the baseline when the agent rewrote the whole file (Write)', async () => {
    seed('c2', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Write',
        toolArgs: { file_path: '/private/tmp/proj/w.txt', content: 'whole\n' },
        at: 0,
      },
    ]);
    getFileContent.mockResolvedValue({ path: 'w.txt', content: 'whole\n', size: 0 });
    getFileContentAtHead.mockResolvedValue({ path: 'w.txt', content: 'head\n', size: 0 });

    await openDiffForFile('c2', '/private/tmp/proj/w.txt');
    const active = useUiStore.getState().fileDiff!.changeSet[0]!;
    expect(active.original).toBe('head\n');
    expect(active.modified).toBe('whole\n');
  });

  it('opens a whole-file Write diff as a NEW file when there is no HEAD baseline (no_head_baseline)', async () => {
    // Regression (todo "File browser: no_head_baseline when trying to view
    // diff"): a whole-file Write in a folder with no git HEAD used to let the
    // 409 no_head_baseline bubble up out of buildDiffEntry, so openDiffForFile
    // threw and the diff never opened — the user just saw the error. With no
    // committed baseline the write IS entirely new content, so the original
    // side is empty and the diff shows the whole file as an addition.
    seed('c-nohead', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Write',
        toolArgs: { file_path: '/private/tmp/proj/fresh.txt', content: 'brand new\n' },
        at: 0,
      },
    ]);
    getFileContent.mockResolvedValue({ path: 'fresh.txt', content: 'brand new\n', size: 0 });
    getFileContentAtHead.mockRejectedValue(
      new ApiError(409, 'no_head_baseline', { error: 'no_head_baseline' }),
    );

    // Must NOT throw — the diff opens.
    await openDiffForFile('c-nohead', '/private/tmp/proj/fresh.txt');
    const fd = useUiStore.getState().fileDiff;
    expect(fd).not.toBeNull();
    const active = fd!.changeSet[0]!;
    expect(active.path).toBe('fresh.txt');
    expect(active.original).toBe(''); // no baseline → whole file is an addition
    expect(active.modified).toBe('brand new\n');
    expect(active.original).not.toBe(active.modified);
  });

  it('still THROWS a genuine HEAD-fetch failure for a Write (does not mask it as an empty baseline)', async () => {
    // NO FALLBACK: only the expected no_head_baseline is swallowed. A real
    // failure (host unreachable, timeout, 5xx) must still propagate so the
    // caller surfaces the error toast rather than opening a bogus empty diff.
    seed('c-fail', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Write',
        toolArgs: { file_path: '/private/tmp/proj/w.txt', content: 'whole\n' },
        at: 0,
      },
    ]);
    getFileContent.mockResolvedValue({ path: 'w.txt', content: 'whole\n', size: 0 });
    getFileContentAtHead.mockRejectedValue(new ApiError(502, 'daemon_unreachable', {}));

    await expect(openDiffForFile('c-fail', '/private/tmp/proj/w.txt')).rejects.toThrow(
      'daemon_unreachable',
    );
    expect(useUiStore.getState().fileDiff).toBeNull();
  });
});

describe('openMostRecentEditDiff', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearFileDiff();
    getFileContent.mockReset();
    getFileContentAtHead.mockReset();
  });

  it('opens the diff for the MOST RECENT file-edit tool call', async () => {
    seed('c3', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/first.ts', old_string: 'a', new_string: 'b' },
        at: 0,
      },
      { seq: 2, kind: 'message', role: 'assistant', text: 'done', at: 1 },
      {
        seq: 3,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/second.ts', old_string: 'c', new_string: 'd' },
        at: 2,
      },
    ]);
    const opened = await openMostRecentEditDiff('c3');
    expect(opened).toBe(true);
    // first.ts + second.ts were edited in the SAME turn (no user message between
    // them), so both populate the change-set rail; the most-recent edit is the
    // ACTIVE one. Sides come from the stream, not disk.
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet.map((e) => e.path)).toEqual(['first.ts', 'second.ts']);
    expect(fd.changeSet[fd.activeIndex]!.path).toBe('second.ts');
    expect(fd.changeSet[fd.activeIndex]!.original).toBe('c');
    expect(fd.changeSet[fd.activeIndex]!.modified).toBe('d');
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it('returns false when the chat has no file edits', async () => {
    seed('c4', '/private/tmp/proj', [{ seq: 1, kind: 'message', role: 'user', text: 'hi', at: 0 }]);
    const opened = await openMostRecentEditDiff('c4');
    expect(opened).toBe(false);
    expect(useUiStore.getState().fileDiff).toBeNull();
  });

  it('returns false when the chat has no timeline at all (never hydrated)', async () => {
    const opened = await openMostRecentEditDiff('never-seen-chat');
    expect(opened).toBe(false);
  });

  it('skips non edit/write tool calls and a tool call missing a file path while scanning', async () => {
    seed('c5', '/private/tmp/proj', [
      {
        seq: 1,
        kind: 'tool_call',
        tool: 'Edit',
        toolArgs: { file_path: '/private/tmp/proj/real.ts', old_string: 'a', new_string: 'b' },
        at: 0,
      },
      // An Edit with no toolArgs at all — must be skipped.
      { seq: 2, kind: 'tool_call', tool: 'Edit', at: 1 },
      // An Edit with toolArgs but no file_path/notebook_path — must be skipped.
      { seq: 3, kind: 'tool_call', tool: 'Edit', toolArgs: {}, at: 2 },
      // Most recent of all is a non-edit tool — must also be skipped.
      { seq: 4, kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'ls' }, at: 3 },
    ]);
    const opened = await openMostRecentEditDiff('c5');
    expect(opened).toBe(true);
    const fd = useUiStore.getState().fileDiff!;
    expect(fd.changeSet[fd.activeIndex]!.path).toBe('real.ts');
  });
});
