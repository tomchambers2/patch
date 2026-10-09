import { describe, it, expect } from 'vitest';
import { diffFromToolCall } from '../src/components/UnifiedDiff';

describe('diffFromToolCall — maps Edit/Write/MultiEdit tool calls to diff pairs', () => {
  it('extracts old→new from an Edit tool call', () => {
    expect(
      diffFromToolCall('Edit', { old_string: 'two', new_string: 'TWO', file_path: '/x' }),
    ).toEqual([{ oldText: 'two', newText: 'TWO' }]);
  });

  it('treats a Write tool call as an all-added (new file) diff', () => {
    expect(diffFromToolCall('Write', { content: 'hello\nworld' })).toEqual([
      { oldText: '', newText: 'hello\nworld' },
    ]);
  });

  it('concatenates each edit of a MultiEdit', () => {
    expect(
      diffFromToolCall('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      }),
    ).toEqual([
      { oldText: 'a', newText: 'A' },
      { oldText: 'b', newText: 'B' },
    ]);
  });

  it('is case-insensitive on the tool name (real SDK emits "Edit")', () => {
    expect(diffFromToolCall('edit', { old_string: 'x', new_string: 'y' })).toEqual([
      { oldText: 'x', newText: 'y' },
    ]);
  });

  it('returns null for a non-diff tool (so it renders as a plain collapsible call)', () => {
    expect(diffFromToolCall('Bash', { command: 'ls' })).toBeNull();
    expect(diffFromToolCall('Read', { file_path: '/x' })).toBeNull();
    expect(diffFromToolCall(undefined, {})).toBeNull();
  });

  it('returns null for a MultiEdit with no well-formed edits', () => {
    expect(diffFromToolCall('MultiEdit', { edits: [{ nope: 1 }] })).toBeNull();
  });
});
