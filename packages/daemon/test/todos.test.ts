// patch/todo.md § Features to add — "todo list": a managing feature that keeps
// the agent focused. The agent tracks work via its native TodoWrite tool; the
// host mirrors that list onto chat state and, when a turn settles with nothing
// left to do, fires the NEXT still-pending todo back into the chat as a fresh
// turn ("so it doesn't get distracted"). This guards the two pure pieces:
//   - parseTodoWriteArgs: TodoWrite tool args → normalised TodoItem[] | null
//   - selectNextTodo: (list, lastFired) → advance decision (fire/clear/stalled)
//   - markTodoStarted: honest status for an item a turn ran on but didn't finish

import { describe, it, expect } from 'vitest';
import {
  buildTodoFireSystemReminder,
  markTodoStarted,
  parseTodoWriteArgs,
  selectNextTodo,
  TODO_PREFIX,
} from '../src/todos.js';
import type { TodoItem } from '@patch/wire';

describe('parseTodoWriteArgs', () => {
  it('normalises TodoWrite args (content → text, keeps status, drops activeForm)', () => {
    const out = parseTodoWriteArgs({
      todos: [
        { content: 'write the parser', status: 'completed', activeForm: 'Writing the parser' },
        { content: 'wire the host', status: 'in_progress', activeForm: 'Wiring the host' },
        { content: 'ship it', status: 'pending', activeForm: 'Shipping it' },
      ],
    });
    expect(out).toEqual([
      { text: 'write the parser', status: 'completed' },
      { text: 'wire the host', status: 'in_progress' },
      { text: 'ship it', status: 'pending' },
    ] satisfies TodoItem[]);
  });

  it('accepts an empty list (the agent cleared its todos)', () => {
    expect(parseTodoWriteArgs({ todos: [] })).toEqual([]);
  });

  it('returns null (declines to mirror) when args are not the TodoWrite shape', () => {
    // NO FALLBACK: malformed input is declined, never coerced into fake todos.
    expect(parseTodoWriteArgs(null)).toBeNull();
    expect(parseTodoWriteArgs({})).toBeNull();
    expect(parseTodoWriteArgs({ todos: 'nope' })).toBeNull();
    expect(parseTodoWriteArgs({ todos: [{ content: 'x' }] })).toBeNull(); // missing status
    expect(parseTodoWriteArgs({ todos: [{ status: 'pending' }] })).toBeNull(); // missing content
    expect(parseTodoWriteArgs({ todos: [{ content: 'x', status: 'weird' }] })).toBeNull();
    expect(parseTodoWriteArgs({ todos: [{ content: '', status: 'pending' }] })).toBeNull(); // empty text
  });
});

describe('selectNextTodo', () => {
  const t = (text: string, status: TodoItem['status']): TodoItem => ({ text, status });

  it('fires the first incomplete todo when nothing has been fired yet', () => {
    const todos = [t('a', 'completed'), t('b', 'pending'), t('c', 'pending')];
    expect(selectNextTodo(todos, null)).toEqual({ action: 'fire', text: 'b' });
  });

  it('treats in_progress as incomplete (the head that still needs doing)', () => {
    const todos = [t('a', 'completed'), t('b', 'in_progress'), t('c', 'pending')];
    expect(selectNextTodo(todos, null)).toEqual({ action: 'fire', text: 'b' });
  });

  it('does NOT re-fire the same head todo it already fired (no nag loop)', () => {
    // The agent worked on "b" but did not complete it (e.g. it asked the user a
    // question). The head-incomplete is still "b" and we already fired it — leave
    // it for the user instead of firing "b" at the agent again, and name it so
    // the caller can show that a turn was spent on it.
    const todos = [t('a', 'completed'), t('b', 'pending'), t('c', 'pending')];
    expect(selectNextTodo(todos, 'b')).toEqual({ action: 'stalled', text: 'b' });
  });

  it('reports a stalled head that is already in progress too (no re-fire)', () => {
    const todos = [t('a', 'completed'), t('b', 'in_progress'), t('c', 'pending')];
    expect(selectNextTodo(todos, 'b')).toEqual({ action: 'stalled', text: 'b' });
  });

  it('advances to the next todo once the previously-fired one is completed', () => {
    const todos = [t('a', 'completed'), t('b', 'completed'), t('c', 'pending')];
    expect(selectNextTodo(todos, 'b')).toEqual({ action: 'fire', text: 'c' });
  });

  it('clears the fired marker when every todo is complete', () => {
    const todos = [t('a', 'completed'), t('b', 'completed')];
    expect(selectNextTodo(todos, 'b')).toEqual({ action: 'clear' });
  });

  it('does nothing for an empty list', () => {
    expect(selectNextTodo([], null)).toEqual({ action: 'clear' });
  });
});

describe('markTodoStarted', () => {
  const t = (text: string, status: TodoItem['status']): TodoItem => ({ text, status });

  it('promotes a stalled pending item to in_progress (a turn WAS spent on it)', () => {
    // The bug: the host fires "b", the agent runs a whole turn on it and never
    // calls TodoWrite, so the surface goes on reading "b" as pending — i.e. not
    // started — for ever. `in_progress` is the honest reading of what happened.
    const todos = [t('a', 'completed'), t('b', 'pending'), t('c', 'pending')];
    expect(markTodoStarted(todos, 'b')).toEqual([
      t('a', 'completed'),
      t('b', 'in_progress'),
      t('c', 'pending'),
    ]);
  });

  it('never marks anything completed, and leaves the rest of the list alone', () => {
    // NO FALLBACK: a finished turn is not evidence the item is done.
    const todos = [t('b', 'pending'), t('c', 'pending')];
    const out = markTodoStarted(todos, 'b');
    expect(out?.some((i) => i.status === 'completed')).toBe(false);
    expect(out?.[1]).toEqual(t('c', 'pending'));
    expect(todos[0]).toEqual(t('b', 'pending')); // input not mutated
  });

  it('returns null when there is nothing to change', () => {
    const todos = [t('b', 'in_progress'), t('c', 'pending')];
    expect(markTodoStarted(todos, 'b')).toBeNull(); // already in progress
    expect(markTodoStarted(todos, 'gone')).toBeNull(); // item no longer on the list
    expect(markTodoStarted([], 'b')).toBeNull();
  });

  it('promotes only the first match when a list repeats an item text', () => {
    const todos = [t('b', 'pending'), t('b', 'pending')];
    expect(markTodoStarted(todos, 'b')).toEqual([t('b', 'in_progress'), t('b', 'pending')]);
  });
});

describe('buildTodoFireSystemReminder', () => {
  it('tells the agent the fired line is its own TodoWrite item and to close it out', () => {
    const block = buildTodoFireSystemReminder('sweep the "yard"');
    expect(block.startsWith('<system-reminder>\n')).toBe(true);
    expect(block.endsWith('</system-reminder>\n\n')).toBe(true);
    expect(block).toContain('TodoWrite');
    expect(block).toContain('in_progress');
    expect(block).toContain('completed');
    // Quotes in the item text can't break out of the block.
    expect(block).toContain(JSON.stringify('sweep the "yard"'));
  });
});

describe('TODO_PREFIX', () => {
  it('is the data marker that rides the fired turn (parity with [wake])', () => {
    expect(TODO_PREFIX).toBe('[todo] ');
  });
});
