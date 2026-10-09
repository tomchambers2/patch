// spec/14 ## Main chat panel — a tool call's one-line summary names what the
// call is DOING: the tool plus its own description where the tool supplies one,
// else the thing it acted on. Same derivation feeds an ungrouped row and a
// collapsed run's summary, so it is tested once, here.

import { describe, it, expect } from 'vitest';
import { toolCallSummary, toolRunNarrative } from '../lib/toolSummary';

describe('toolCallSummary', () => {
  it("prefers the call's own description over the raw argument", () => {
    expect(
      toolCallSummary('Bash', { command: 'gh pr list --limit 5', description: 'List open PRs' }),
    ).toBe('Bash List open PRs');
  });

  it('falls back to the argument that says what was acted on when there is no description', () => {
    expect(toolCallSummary('Bash', { command: 'pnpm test' })).toBe('Bash "pnpm test"');
    expect(toolCallSummary('Read', { file_path: 'src/poll.ts' })).toBe('Read poll.ts');
    expect(toolCallSummary('Write', { file_path: 'src/new.ts' })).toBe('Write new.ts');
    expect(toolCallSummary('Edit', { file_path: 'src/poll.ts' })).toBe('Edit poll.ts');
    expect(toolCallSummary('MultiEdit', { file_path: 'src/poll.ts' })).toBe('MultiEdit poll.ts');
    expect(toolCallSummary('NotebookEdit', { notebook_path: 'run.ipynb' })).toBe(
      'NotebookEdit run.ipynb',
    );
    expect(toolCallSummary('Grep', { pattern: 'timeout' })).toBe('Grep "timeout"');
    expect(toolCallSummary('Glob', { pattern: 'src/**/*.ts' })).toBe('Glob src/**/*.ts');
    expect(toolCallSummary('WebFetch', { url: 'https://example.com/a' })).toBe(
      'WebFetch https://example.com/a',
    );
    expect(toolCallSummary('WebSearch', { query: 'vitest snapshot' })).toBe(
      'WebSearch "vitest snapshot"',
    );
    expect(toolCallSummary('Task', { subagent_type: 'Explore' })).toBe('Task Explore');
    expect(toolCallSummary('Skill', { skill: 'plant' })).toBe('Skill plant');
  });

  it('reads as the bare tool name when the tool names nothing it acted on', () => {
    expect(toolCallSummary('TodoWrite', { todos: [{ content: 'a' }] })).toBe('TodoWrite');
    expect(toolCallSummary('SomeUnknownTool', { whatever: 1 })).toBe('SomeUnknownTool');
  });

  it('survives a call with no args at all, or a missing tool name', () => {
    expect(toolCallSummary('Bash', undefined)).toBe('Bash');
    expect(toolCallSummary('Bash', null)).toBe('Bash');
    expect(toolCallSummary('Read', 'not an object')).toBe('Read');
    expect(toolCallSummary(undefined, { file_path: 'x.ts' })).toBe('tool');
  });

  // A description is free text the model wrote — it can be blank, padded, or
  // (from a tool we don't know) not a string at all. None of those may win over
  // the real argument, or the row goes anonymous.
  it('ignores a description that is blank or not a string', () => {
    expect(toolCallSummary('Bash', { command: 'pnpm test', description: '   ' })).toBe(
      'Bash "pnpm test"',
    );
    expect(toolCallSummary('Bash', { command: 'pnpm test', description: 42 })).toBe(
      'Bash "pnpm test"',
    );
  });

  it('keeps the row to one line: long descriptions and commands are truncated', () => {
    const long = 'a'.repeat(90);
    expect(toolCallSummary('Bash', { description: long }).length).toBeLessThan(70);
    expect(toolCallSummary('Bash', { description: long })).toMatch(/…$/);
    expect(toolCallSummary('Bash', { command: 'x'.repeat(90) })).toBe(`Bash "${'x'.repeat(39)}…"`);
    expect(toolCallSummary('Bash', { description: 'first line\nsecond line' })).toBe(
      'Bash first line',
    );
  });
});

// The bug this rule exists for (Todoist "can't see filename", 28 Aug 2026): the
// row is ONE line with TAIL truncation, and every path from one chat's folder
// shares the same ~40-char absolute prefix. Rendering the whole path spent the
// row on the part that is identical on every row and cut off the filename — the
// only part that differs, and the only part being looked for. So a path-valued
// target is its FILENAME; the full path is still in the expanded args.
describe('toolCallSummary — path targets read as the filename (spec/14 § Main chat panel)', () => {
  const LONG = '/home/claude-dev/projects/portfolio/docs/google-cloud.md';

  it('shows the filename, not the long absolute path, for every path-valued tool', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit']) {
      expect(toolCallSummary(tool, { file_path: LONG })).toBe(`${tool} google-cloud.md`);
    }
    expect(toolCallSummary('NotebookEdit', { notebook_path: LONG })).toBe(
      'NotebookEdit google-cloud.md',
    );
  });

  // The regression guard proper: whatever the rule becomes, the filename has to
  // survive into the summary, and the row must be short enough to render it.
  it('keeps the filename visible on a deep path (the original bug)', () => {
    const summary = toolCallSummary('Write', { file_path: LONG });
    expect(summary).toContain('google-cloud.md');
    expect(summary).not.toContain('/home/claude-dev');
    expect(summary.length).toBeLessThan(30);
  });

  it('two files in one folder no longer read as the same truncated row', () => {
    const a = toolCallSummary('Edit', { file_path: `${LONG}` });
    const b = toolCallSummary('Edit', {
      file_path: '/home/claude-dev/projects/portfolio/docs/real-container-testing.md',
    });
    expect(a).not.toBe(b);
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

describe('toolRunNarrative', () => {
  it('says what the batch did, by kind of work in first-seen order', () => {
    expect(
      toolRunNarrative([
        { tool: 'Bash' },
        { tool: 'Read' },
        { tool: 'Bash' },
        { tool: 'Grep' },
        { tool: 'Glob' },
        { tool: 'Read' },
        { tool: 'Bash' },
      ]),
    ).toBe('Ran 3 commands, read 2 files, searched for 2 patterns');
  });

  it('uses the singular for one of a kind', () => {
    expect(toolRunNarrative([{ tool: 'Read' }, { tool: 'WebFetch' }])).toBe(
      'Read 1 file, fetched 1 page',
    );
  });

  it('names the web, agents, skills, edits and housekeeping plainly', () => {
    expect(
      toolRunNarrative([
        { tool: 'WebSearch' },
        { tool: 'WebSearch' },
        { tool: 'Task' },
        { tool: 'Skill' },
        { tool: 'Write' },
        { tool: 'TodoWrite' },
        { tool: 'TodoWrite' },
        { tool: 'ToolSearch' },
      ]),
    ).toBe(
      'Searched the web 2 times, ran 1 agent, used 1 skill, edited 1 file, updated the todo list, loaded tools',
    );
  });

  it('reads an MCP tool as its server, and a patch tool as itself', () => {
    expect(
      toolRunNarrative([
        { tool: 'mcp__playwright__browser_navigate' },
        { tool: 'mcp__playwright__browser_snapshot' },
        { tool: 'mcp__patch__view_file' },
        { tool: 'SomethingNew' },
      ]),
    ).toBe('Called playwright 2 times, called view_file, called SomethingNew');
  });
});
