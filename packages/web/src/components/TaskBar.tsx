// TaskBar — the chat's task list at the top of the chat panel (spec/02 § Task
// list, spec/14 § Main chat panel). The list is the agent's own Claude Code
// TodoWrite list, mirrored onto chat state by the host; here it is also
// editable, because it is what the host fires the next turn from. Collapsed
// it is one line (current item + progress); expanded, every item's status,
// text and existence is the user's to change.
//
// Every edit sends the WHOLE list and is optimistic, reverting + surfacing a
// toast on failure (NO FALLBACK), matching the goal bar's pattern.

import { useState, type JSX, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, Plus, X } from 'lucide-react';
import type { TodoItem } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { InlineEditText } from './InlineEditText.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';

/** pending → in progress → done → pending, so one control covers the lifecycle. */
const NEXT_STATUS: Record<TodoItem['status'], TodoItem['status']> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending',
};

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'done',
};

function StatusIcon({ status }: { status: TodoItem['status'] }): JSX.Element {
  if (status === 'completed') return <CircleCheck size={14} aria-hidden />;
  if (status === 'in_progress') return <CircleDot size={14} aria-hidden />;
  return <Circle size={14} aria-hidden />;
}

export function TaskBar({ row }: { row: ChatRow }): JSX.Element | null {
  const setTodos = useChatStore((s) => s.setTodos);
  const pushError = useUiStore((s) => s.pushError);
  const [expanded, setExpanded] = useState(false);
  const [newTask, setNewTask] = useState('');

  const todos = row.todos;
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  // What the chat is on right now: the in-progress item, else the next pending
  // one. All done → say so rather than showing a stale last item.
  const head =
    todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'completed');

  async function commit(next: TodoItem[]): Promise<void> {
    const prev = todos;
    setTodos(row.chatId, next);
    try {
      await api.setTodos(row.chatId, next);
    } catch (err) {
      setTodos(row.chatId, prev);
      pushError(failed('updating tasks'), undefined, (err as Error).message);
    }
  }

  function cycle(index: number): void {
    const item = todos[index];
    if (!item) return;
    void commit(
      todos.map((t, i) => (i === index ? { ...t, status: NEXT_STATUS[item.status] } : t)),
    );
  }

  function rename(index: number, text: string): void {
    void commit(todos.map((t, i) => (i === index ? { ...t, text } : t)));
  }

  function remove(index: number): void {
    void commit(todos.filter((_, i) => i !== index));
  }

  function onNewTaskKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = newTask.trim();
    if (text === '') return;
    setNewTask('');
    void commit([...todos, { text, status: 'pending' }]);
  }

  return (
    <div className="task-bar" data-testid="task-bar">
      <button
        type="button"
        className="task-bar-summary"
        data-testid="task-bar-summary"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse task list' : 'Expand task list'}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span className="task-bar-head" data-testid="task-bar-head">
          {head ? head.text : 'All tasks done'}
        </span>
        <span className="task-bar-count" data-testid="task-bar-count">
          {done}/{todos.length}
        </span>
      </button>
      {expanded ? (
        <ul className="task-bar-list" data-testid="task-bar-list">
          {todos.map((t, i) => (
            <li
              className={`task-row task-row-${t.status}`}
              data-testid="task-row"
              key={`${i}-${t.text}`}
            >
              <button
                type="button"
                className="task-status-btn"
                data-testid="task-status-btn"
                aria-label={`Task ${STATUS_LABEL[t.status]}, mark ${STATUS_LABEL[NEXT_STATUS[t.status]]}`}
                title={STATUS_LABEL[t.status]}
                onClick={() => cycle(i)}
              >
                <StatusIcon status={t.status} />
              </button>
              <InlineEditText
                className="task-text"
                testId="task-text"
                editLabel="Edit task"
                value={t.text}
                onCommit={(text) => rename(i, text)}
              />
              <button
                type="button"
                className="task-delete-btn"
                data-testid="task-delete-btn"
                aria-label="Delete task"
                title="Delete task"
                onClick={() => remove(i)}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
          <li className="task-row task-row-add">
            <span className="task-status-btn task-add-icon" aria-hidden>
              <Plus size={14} />
            </span>
            <input
              className="task-text task-add-input"
              data-testid="task-add-input"
              aria-label="Add task"
              placeholder="Add task"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={onNewTaskKeyDown}
            />
          </li>
        </ul>
      ) : null}
    </div>
  );
}
