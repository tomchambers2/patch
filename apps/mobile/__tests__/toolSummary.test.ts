// spec/15 ## Chat detail — mobile's tool rows follow web's rules: a summary
// that says what the call is doing, and consecutive runs collapsed to one row.
// src/lib/toolSummary.ts is a deliberate mirror of the web module, so these
// mirror the web tests too — a rule that changes on one surface has to change
// on both.

import { describe, it, expect } from 'vitest';
import {
  toolCallSummary,
  toolRunNarrative,
  groupToolRuns,
  pairedResult,
} from '../src/lib/toolSummary';
import type { ChatEventEntry } from '../src/stores/chatStore';

const call = (seq: number, tool: string, toolArgs?: unknown, callId?: string): ChatEventEntry =>
  ({ seq, kind: 'tool_call', tool, toolArgs, callId, at: seq }) as ChatEventEntry;
const result = (seq: number, tool: string, callId?: string): ChatEventEntry =>
  ({ seq, kind: 'tool_result', tool, toolResult: { ok: true }, callId, at: seq }) as ChatEventEntry;
const message = (seq: number): ChatEventEntry =>
  ({ seq, kind: 'message', role: 'assistant', content: 'hi', at: seq }) as ChatEventEntry;

describe('toolCallSummary', () => {
  it("prefers the call's own description over the raw argument", () => {
    expect(toolCallSummary('Bash', { command: 'pnpm test', description: 'Run the suite' })).toBe(
      'Bash Run the suite',
    );
  });

  it('falls back to what the call acted on', () => {
    expect(toolCallSummary('Read', { file_path: 'src/poll.ts' })).toBe('Read poll.ts');
    expect(toolCallSummary('Grep', { pattern: 'timeout' })).toBe('Grep "timeout"');
    expect(toolCallSummary('Bash', { command: 'pnpm test' })).toBe('Bash "pnpm test"');
    expect(toolCallSummary('Task', { subagent_type: 'Explore' })).toBe('Task Explore');
  });

  it('reads as the bare tool name when there is nothing to name', () => {
    expect(toolCallSummary('TodoWrite', { todos: [] })).toBe('TodoWrite');
    expect(toolCallSummary('Bash', undefined)).toBe('Bash');
    expect(toolCallSummary(undefined, {})).toBe('tool');
  });

  it('ignores a blank or non-string description, and keeps the row to one line', () => {
    expect(toolCallSummary('Bash', { command: 'pnpm test', description: '  ' })).toBe(
      'Bash "pnpm test"',
    );
    expect(toolCallSummary('Bash', { description: 'a'.repeat(90) })).toMatch(/…$/);
  });
});

// The bug this rule exists for (Todoist "can't see filename", 28 Aug 2026 — the
// report came from THIS screen): the row is a `<Text numberOfLines={1}>` at
// 12px mono, so it truncates at the TAIL, and every path from one chat's folder
// shares the same ~40-char absolute prefix. Rendering the whole path spent the
// row on the part that is identical on every row and cut off the filename — the
// only part that differs. Worse in a collapsed run, which joins three summaries
// onto that one line. So a path-valued target is its FILENAME; the full path is
// still one tap away in the expanded args. Mirrors the web test of the same name.
describe('toolCallSummary — path targets read as the filename (spec/15 § Chat detail)', () => {
  const LONG = '/home/claude-dev/projects/portfolio/docs/google-cloud.md';

  it('shows the filename, not the long absolute path, for every path-valued tool', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit']) {
      expect(toolCallSummary(tool, { file_path: LONG })).toBe(`${tool} google-cloud.md`);
    }
    expect(toolCallSummary('NotebookEdit', { notebook_path: LONG })).toBe(
      'NotebookEdit google-cloud.md',
    );
  });

  it('keeps the filename visible on a deep path (the original bug)', () => {
    const summary = toolCallSummary('Write', { file_path: LONG });
    expect(summary).toContain('google-cloud.md');
    expect(summary).not.toContain('/home/claude-dev');
    expect(summary.length).toBeLessThan(30);
  });

  it('two files in one folder no longer read as the same truncated row', () => {
    const a = toolCallSummary('Edit', { file_path: LONG });
    const b = toolCallSummary('Edit', {
      file_path: '/home/claude-dev/projects/portfolio/docs/real-container-testing.md',
    });
    expect(a).not.toBe(b);
  });

  // A collapsed run is the tightest case: three summaries on one line. With
  // filenames the whole run still fits and says what it did.
  it('a folded run of three file calls fits on one line', () => {
    const labels = [
      toolCallSummary('Read', { file_path: LONG }),
      toolCallSummary('Edit', { file_path: '/home/claude-dev/projects/portfolio/CONTEXT.md' }),
      toolCallSummary('Write', { file_path: '/home/claude-dev/projects/portfolio/deploy.md' }),
    ];
    expect(labels.join(', ')).toBe('Read google-cloud.md, Edit CONTEXT.md, Write deploy.md');
  });

  it('leaves a bare filename alone — there is no directory to drop', () => {
    expect(toolCallSummary('Read', { file_path: 'poll.ts' })).toBe('Read poll.ts');
    expect(toolCallSummary('NotebookEdit', { notebook_path: 'run.ipynb' })).toBe(
      'NotebookEdit run.ipynb',
    );
  });

  it('handles a path with no filename rather than going blank', () => {
    expect(toolCallSummary('Read', { file_path: '/' })).toBe('Read /');
    expect(toolCallSummary('Read', { file_path: '/home/claude-dev/projects/' })).toBe(
      'Read projects',
    );
  });

  it("NotebookEdit still falls back to file_path when there's no notebook_path", () => {
    expect(toolCallSummary('NotebookEdit', { file_path: '/home/tom/nb/run.ipynb' })).toBe(
      'NotebookEdit run.ipynb',
    );
    expect(
      toolCallSummary('NotebookEdit', {
        notebook_path: '   ',
        file_path: '/home/tom/nb/run.ipynb',
      }),
    ).toBe('NotebookEdit run.ipynb');
  });

  it('leaves non-path targets untouched — a Glob pattern is not a path', () => {
    expect(toolCallSummary('Glob', { pattern: 'src/**/*.ts' })).toBe('Glob src/**/*.ts');
    expect(toolCallSummary('WebFetch', { url: 'https://example.com/a/b.html' })).toBe(
      'WebFetch https://example.com/a/b.html',
    );
  });
});

describe('groupToolRuns', () => {
  it('folds a consecutive run of more than one call into a single row', () => {
    const rows = groupToolRuns([
      message(0),
      call(1, 'Grep', { pattern: 'timeout' }),
      result(2, 'Grep'),
      call(3, 'Read', { file_path: 'src/poll.ts' }),
      result(4, 'Read'),
      message(5),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'group', 'entry']);
    const group = rows[1];
    if (group?.kind !== 'group') throw new Error('expected a group row');
    expect(group.entries).toHaveLength(4);
  });

  it('leaves a lone call as its own row — one call is not a run', () => {
    const rows = groupToolRuns([call(0, 'Read', { file_path: 'a.ts' }), result(1, 'Read')]);
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'entry']);
  });

  it('keeps file-edit calls out of a run: each carries its own inline diff', () => {
    const rows = groupToolRuns([
      call(0, 'Grep', { pattern: 'x' }),
      result(1, 'Grep'),
      call(2, 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
      result(3, 'Edit'),
      call(4, 'Bash', { command: 'pnpm test' }),
      result(5, 'Bash'),
      call(6, 'Read', { file_path: 'a.ts' }),
    ]);
    // Grep alone (one call is not a run) → its call and result rows; the edit
    // call → its own row; then the Bash + Read run folds. The edit's RESULT
    // joins that run rather than trailing the edit — same as web, where a
    // result is always groupable and the run is maximal.
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'entry', 'entry', 'group']);
    const editRow = rows[2];
    if (editRow?.kind !== 'entry') throw new Error('expected the edit to keep its own row');
    expect(editRow.entry.tool).toBe('Edit');
  });

  it('gives every row a stable, unique key even when seqs repeat', () => {
    const rows = groupToolRuns([message(0), message(0), call(1, 'Read'), result(1, 'Read')]);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// The bug this exists for: a lone tool call rendered as TWO rows — the call,
// then a separate "↳ <tool> done" row — where web already folds a call and
// its own result into one row (Tom, via screenshot: "tool call appears
// twice", the same report that fixed web). Matched on callId, same as web's
// `pairedResult`.
describe('groupToolRuns — a lone call folds its own result into one row', () => {
  it('folds a call and its matching-callId result into a single entry row', () => {
    const rows = groupToolRuns([
      call(0, 'Read', { file_path: 'a.ts' }, 'call-1'),
      result(1, 'Read', 'call-1'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['entry']);
    const row = rows[0];
    if (row?.kind !== 'entry') throw new Error('expected an entry row');
    expect(row.entry.tool).toBe('Read');
    expect(row.result?.tool).toBe('Read');
    expect(row.result?.kind).toBe('tool_result');
  });

  it('does not fold when the adjacent result belongs to a different call', () => {
    const rows = groupToolRuns([
      call(0, 'Read', { file_path: 'a.ts' }, 'call-1'),
      result(1, 'Read', 'call-2'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'entry']);
    const row = rows[0];
    if (row?.kind !== 'entry') throw new Error('expected an entry row');
    expect(row.result).toBeUndefined();
  });

  it('does not fold when neither entry carries a callId', () => {
    const rows = groupToolRuns([call(0, 'Read', { file_path: 'a.ts' }), result(1, 'Read')]);
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'entry']);
  });

  it('leaves a batch of calls-then-results ungrouped for pairing — that run of >1 folds into a group instead', () => {
    // [call a, call b, result a, result b] — no call is adjacent to its own
    // result, so this is a run of two calls and folds into a `group` row
    // exactly as it did before pairing existed.
    const rows = groupToolRuns([
      call(0, 'Grep', { pattern: 'x' }, 'call-a'),
      call(1, 'Glob', { pattern: 'y' }, 'call-b'),
      result(2, 'Grep', 'call-a'),
      result(3, 'Glob', 'call-b'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['group']);
  });
});

describe('pairedResult', () => {
  it('returns the matching result at i + 1', () => {
    const timeline = [call(0, 'Read', {}, 'x'), result(1, 'Read', 'x')];
    expect(pairedResult(timeline, 0)).toBe(timeline[1]);
  });

  it('returns undefined with no next entry, a non-result next entry, or a mismatched callId', () => {
    expect(pairedResult([call(0, 'Read', {}, 'x')], 0)).toBeUndefined();
    expect(pairedResult([call(0, 'Read', {}, 'x'), message(1)], 0)).toBeUndefined();
    expect(pairedResult([call(0, 'Read', {}, 'x'), result(1, 'Read', 'y')], 0)).toBeUndefined();
  });
});

// Mirror of web's toolRunNarrative tests — the two files must agree.
describe('toolRunNarrative', () => {
  it('says what the batch did, by kind of work in first-seen order', () => {
    expect(
      toolRunNarrative([{ tool: 'Bash' }, { tool: 'Read' }, { tool: 'Bash' }, { tool: 'Glob' }]),
    ).toBe('Ran 2 commands, read 1 file, searched for 1 pattern');
  });

  it('reads an MCP tool as its server', () => {
    expect(
      toolRunNarrative([
        { tool: 'mcp__playwright__browser_navigate' },
        { tool: 'mcp__playwright__browser_snapshot' },
      ]),
    ).toBe('Called playwright 2 times');
  });
});

describe('groupToolRuns — view_file takes its own result', () => {
  it('folds a view_file call and its result into one entry row', () => {
    const rows = groupToolRuns([
      call(0, 'mcp__patch__view_file', { file_path: 'a.png' }, 'c1'),
      result(1, 'mcp__patch__view_file', 'c1'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'entry' });
    expect((rows[0] as { result?: unknown }).result).toBeDefined();
  });
});
