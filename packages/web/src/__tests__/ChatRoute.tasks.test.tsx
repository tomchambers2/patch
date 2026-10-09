// spec/02 § Task list + spec/14 § Main chat panel — the task bar.
//
// The agent's Claude Code TodoWrite list is mirrored onto chat state; this bar
// is where the user sees it and edits it back. These tests pin: it only appears
// once there IS a list, collapsed it reads "<current item> · done/total",
// expanding exposes one row per task, and every mutation (status cycle, rename,
// delete, add) sends the WHOLE list optimistically and reverts with a toast on
// failure (NO FALLBACK). The goal bar's in-place edit lives here too — it is the
// same InlineEditText control.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { TodoItem } from '@patch/wire';
import { ChatRoute } from '../routes/ChatRoute.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setTodos: vi.fn(async () => undefined),
  },
}));

const LIST: TodoItem[] = [
  { text: 'read the current indexer', status: 'completed' },
  { text: 'rebuild the index', status: 'in_progress' },
  { text: 'schedule it nightly', status: 'pending' },
];

function seed(todos: TodoItem[], goal: string | null = null): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'index rebuild',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal,
      todos,
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function expand(): void {
  fireEvent.click(screen.getByTestId('task-bar-summary'));
}

/** The list the component last sent to the API. */
function lastSent(): TodoItem[] {
  const calls = vi.mocked(api.setTodos).mock.calls;
  return calls[calls.length - 1]?.[1] as TodoItem[];
}

describe('ChatRoute — task bar (spec/02 § Task list)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.setTodos)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(api.setGoal)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows no task bar until the agent has written a list', () => {
    seed([]);
    renderChat();
    expect(screen.queryByTestId('task-bar')).not.toBeInTheDocument();
  });

  it('collapsed, names the in-progress task and the progress count', () => {
    seed(LIST);
    renderChat();
    expect(screen.getByTestId('task-bar-head')).toHaveTextContent('rebuild the index');
    expect(screen.getByTestId('task-bar-count')).toHaveTextContent('1/3');
    // Collapsed means collapsed: the rows aren't in the DOM yet.
    expect(screen.queryByTestId('task-bar-list')).not.toBeInTheDocument();
  });

  it('falls back to the next pending task when nothing is in progress', () => {
    seed([
      { text: 'read the current indexer', status: 'completed' },
      { text: 'rebuild the index', status: 'pending' },
    ]);
    renderChat();
    expect(screen.getByTestId('task-bar-head')).toHaveTextContent('rebuild the index');
  });

  it('says all tasks are done when every item is completed', () => {
    seed([{ text: 'read the current indexer', status: 'completed' }]);
    renderChat();
    expect(screen.getByTestId('task-bar-head')).toHaveTextContent('All tasks done');
    expect(screen.getByTestId('task-bar-count')).toHaveTextContent('1/1');
  });

  it('expands to one row per task', () => {
    seed(LIST);
    renderChat();
    expand();
    const rows = screen.getAllByTestId('task-row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('rebuild the index');
  });

  it('cycles a task status and sends the whole list', async () => {
    seed(LIST);
    renderChat();
    expand();
    // Row 2 is in_progress → clicking marks it completed.
    fireEvent.click(screen.getAllByTestId('task-status-btn')[1] as HTMLElement);

    await waitFor(() => expect(api.setTodos).toHaveBeenCalled());
    expect(lastSent()).toEqual([
      { text: 'read the current indexer', status: 'completed' },
      { text: 'rebuild the index', status: 'completed' },
      { text: 'schedule it nightly', status: 'pending' },
    ]);
    expect(useChatStore.getState().chats['c1']?.todos[1]?.status).toBe('completed');
  });

  it('renames a task in place on Enter', async () => {
    seed(LIST);
    renderChat();
    expand();
    fireEvent.click(screen.getAllByTestId('task-text')[2] as HTMLElement);
    const input = screen.getByTestId('task-text-input');
    fireEvent.change(input, { target: { value: 'schedule it hourly' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.setTodos).toHaveBeenCalled());
    expect(lastSent()[2]).toEqual({ text: 'schedule it hourly', status: 'pending' });
  });

  it('reverts an in-place rename on Escape without calling the API', () => {
    seed(LIST);
    renderChat();
    expand();
    fireEvent.click(screen.getAllByTestId('task-text')[2] as HTMLElement);
    const input = screen.getByTestId('task-text-input');
    fireEvent.change(input, { target: { value: 'nonsense' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(api.setTodos).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('task-text')[2]).toHaveTextContent('schedule it nightly');
  });

  it('deletes a task', async () => {
    seed(LIST);
    renderChat();
    expand();
    fireEvent.click(screen.getAllByTestId('task-delete-btn')[0] as HTMLElement);

    await waitFor(() => expect(api.setTodos).toHaveBeenCalled());
    expect(lastSent()).toEqual([
      { text: 'rebuild the index', status: 'in_progress' },
      { text: 'schedule it nightly', status: 'pending' },
    ]);
  });

  it('adds a task at the end as pending', async () => {
    seed(LIST);
    renderChat();
    expand();
    const input = screen.getByTestId('task-add-input');
    fireEvent.change(input, { target: { value: 'benchmark it' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.setTodos).toHaveBeenCalled());
    expect(lastSent()[3]).toEqual({ text: 'benchmark it', status: 'pending' });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('reverts the list + surfaces a toast when the write fails (NO FALLBACK)', async () => {
    vi.mocked(api.setTodos).mockRejectedValueOnce(new Error('network down'));
    seed(LIST);
    renderChat();
    expand();
    fireEvent.click(screen.getAllByTestId('task-delete-btn')[0] as HTMLElement);

    // Optimistic first…
    expect(useChatStore.getState().chats['c1']?.todos).toHaveLength(2);
    // …then back to where it was, with the failure surfaced.
    await waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.todos).toEqual(LIST);
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('tasks');
  });
});

describe('ChatRoute — goal bar edits in place (spec/14 § Goal bar)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.setGoal)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('rewrites the goal from the banner without retyping the command', async () => {
    seed([], 'Ship the release by Friday');
    renderChat();
    fireEvent.click(screen.getByTestId('goal-banner-text'));
    const input = screen.getByTestId('goal-edit-input');
    fireEvent.change(input, { target: { value: 'Ship the release by Monday' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));

    await waitFor(() => {
      expect(api.setGoal).toHaveBeenCalledWith('c1', 'Ship the release by Monday');
    });
    expect(screen.getByTestId('goal-banner')).toHaveTextContent('Ship the release by Monday');
  });

  it('reverts the edited goal + surfaces a toast when the write fails', async () => {
    vi.mocked(api.setGoal).mockRejectedValueOnce(new Error('network down'));
    seed([], 'Ship the release by Friday');
    renderChat();
    fireEvent.click(screen.getByTestId('goal-banner-text'));
    const input = screen.getByTestId('goal-edit-input');
    fireEvent.change(input, { target: { value: 'Ship it whenever' } });
    fireEvent.click(screen.getByTestId('goal-edit-save'));

    await waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.goal).toBe('Ship the release by Friday');
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('goal');
  });

  it('still clears the goal from the × control', async () => {
    seed([], 'Ship the release by Friday');
    renderChat();
    fireEvent.click(screen.getByTestId('goal-clear-btn'));

    await waitFor(() => expect(api.setGoal).toHaveBeenCalledWith('c1', null));
    expect(screen.queryByTestId('goal-banner')).not.toBeInTheDocument();
  });
});
