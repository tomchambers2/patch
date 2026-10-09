// spec/14 § Main chat panel — Background task bar.
//
// A `patch_watch` task outlives the turn that launched it, so the chat can be
// idle while work is still in flight. The bar is the standing readout of THIS
// chat's own still-running tasks — ONE BAR PER TASK by default, foldable to a
// single counted summary line; it goes when they finish.
//
// Rows now come from `GET /api/chats/:id/watch` (`api.watchList`), not from
// scraping the transcript for Bash/Task `run_in_background` calls (that
// mechanism is permanently denied — sdkBackend.ts's `canUseTool`). The bar's
// very existence is gated on the chat's LIVE `chat.state.backgroundTasks`
// count, which the host now updates the instant a watch starts or is
// killed; the polled list only fills in the rows once something is known to
// be running.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import { api } from '../api/rest.js';
import type { WatchTaskRow } from '@patch/wire';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
    watchList: vi.fn(async () => ({ tasks: [] as WatchTaskRow[] })),
    watchStop: vi.fn(async () => ({ stopped: true })),
  },
}));

const watchListApi = api.watchList as unknown as ReturnType<typeof vi.fn>;
const watchStopApi = api.watchStop as unknown as ReturnType<typeof vi.fn>;

function task(over: Partial<WatchTaskRow> = {}): WatchTaskRow {
  return {
    taskId: 't1',
    description: 'Build web package to compile CSS',
    command: 'pnpm --filter @patch/web build',
    outputFile: '/data/chats/c1/watch/t1.output',
    status: 'running',
    startedAt: 0,
    ...over,
  };
}

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'deploy',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
}

/** Report the chat's LIVE running count, as the host's `chat.state` does. */
function setLiveCount(n: number): void {
  useChatStore.getState().applyEvent({
    type: 'chat.state',
    chatId: 'c1',
    permissionMode: 'bypassPermissions',
    activity: 'idle',
    lastUpdated: Date.now(),
    backgroundTasks: n,
  });
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

/** Mount, report the live count, and let the first watchList poll land. */
async function renderWithTasks(n: number, tasks: WatchTaskRow[]): Promise<void> {
  seed();
  watchListApi.mockResolvedValue({ tasks });
  renderChat();
  await act(async () => {
    setLiveCount(n);
    await Promise.resolve();
  });
}

describe('ChatRoute — background task bar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    useTerminalStore.getState()._reset();
    useLayoutStore.getState()._reset();
    window.localStorage.removeItem('patch.chat.backgroundTasksCollapsed');
    useUiStore.getState().setBackgroundTasksCollapsed(false);
    window.localStorage.removeItem('patch.chat.backgroundTasksShowAll');
    useUiStore.getState().setBackgroundTasksShowAll(false);
    watchListApi.mockReset();
    watchListApi.mockResolvedValue({ tasks: [] });
    watchStopApi.mockReset();
    watchStopApi.mockResolvedValue({ stopped: true });
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows no bar, and never polls, when the chat has nothing running', () => {
    seed();
    renderChat();
    expect(screen.queryByTestId('background-task-bar')).toBeNull();
    expect(watchListApi).not.toHaveBeenCalled();
  });

  it('gives the one running task its own bar, named, once the live count says something is running', async () => {
    await renderWithTasks(1, [task()]);
    const bar = screen.getByTestId('background-task-bar');
    expect(bar.dataset['collapsed']).toBe('false');
    expect(screen.getAllByTestId('background-task-bar-task')).toHaveLength(1);
    expect(bar.textContent).toContain('Build web package to compile CSS');
    expect(screen.getByTestId('background-task-bar-count').textContent).toBe('1 background task');
  });

  it('appears live the moment chat.state reports a count, before the list poll even resolves', async () => {
    seed();
    // Never resolves within this test — the bar's EXISTENCE must not wait on it.
    watchListApi.mockReturnValue(new Promise(() => {}));
    renderChat();
    act(() => setLiveCount(1));
    expect(screen.getByTestId('background-task-bar-count').textContent).toBe('1 background task');
  });

  it('draws one bar per running task, newest first', async () => {
    await renderWithTasks(2, [
      task({ taskId: 'a', description: 'older', startedAt: 1 }),
      task({ taskId: 'b', description: 'newer', startedAt: 2 }),
    ]);
    const rows = screen.getAllByTestId('background-task-bar-task');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('newer');
    expect(rows[1]!.textContent).toContain('older');
  });

  it('every running row carries a spinner glyph', async () => {
    await renderWithTasks(2, [
      task({ taskId: 'a', startedAt: 1 }),
      task({ taskId: 'b', startedAt: 2 }),
    ]);
    expect(
      screen.getByTestId('background-task-bar').querySelectorAll('.background-task-bar-spinner'),
    ).toHaveLength(2);
  });

  it('collapses the stack to one counted summary line, and back', async () => {
    await renderWithTasks(2, [
      task({ taskId: 'a', startedAt: 1 }),
      task({ taskId: 'b', startedAt: 2 }),
    ]);
    const toggle = screen.getByTestId('background-task-bar-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId('background-task-bar-task')).toHaveLength(0);
    expect(screen.getByTestId('background-task-bar').dataset['collapsed']).toBe('true');
    fireEvent.click(screen.getByTestId('background-task-bar-toggle'));
    expect(screen.getAllByTestId('background-task-bar-task')).toHaveLength(2);
  });

  describe('elapsed time', () => {
    it("shows a running task's elapsed clock next to the spinner, and it ticks", async () => {
      vi.useFakeTimers();
      try {
        seed();
        watchListApi.mockResolvedValue({ tasks: [task({ startedAt: Date.now() })] });
        renderChat();
        await act(async () => {
          setLiveCount(1);
          await Promise.resolve();
        });
        expect(screen.getByTestId('background-task-bar-elapsed').textContent).toBe('0s');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });
        expect(screen.getByTestId('background-task-bar-elapsed').textContent).toBe('3s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('an ended row carries no elapsed clock', async () => {
      await renderWithTasks(1, [
        task({ taskId: 'run', startedAt: 2 }),
        task({ taskId: 'end', status: 'exited', startedAt: 1, endedAt: 5 }),
      ]);
      useUiStore.getState().setBackgroundTasksShowAll(true);
      await act(async () => {
        await Promise.resolve();
      });
      const rows = screen.getAllByTestId('background-task-bar-task');
      const ended = rows.find((r) => r.dataset['ended'] === 'true')!;
      expect(ended.querySelector('[data-testid="background-task-bar-elapsed"]')).toBeNull();
    });
  });

  describe('command preview', () => {
    it('truncates a long command and expands it on click', async () => {
      const long =
        'pnpm --filter @patch/web build --with-a-very-long-flag-that-runs-past-the-preview-length';
      await renderWithTasks(1, [task({ command: long })]);
      const preview = screen.getByTestId('background-task-bar-command');
      expect(preview.textContent).not.toBe(long);
      expect(preview.textContent!.length).toBeLessThan(long.length);
      fireEvent.click(preview);
      expect(screen.getByTestId('background-task-bar-command').textContent).toBe(long);
    });

    it('clicking the command preview does not also open the terminal', async () => {
      await renderWithTasks(1, [task()]);
      fireEvent.click(screen.getByTestId('background-task-bar-command'));
      expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c1' })).toBeNull();
    });

    it('a short command is shown in full with nothing to expand', async () => {
      await renderWithTasks(1, [task({ command: 'ls' })]);
      expect(screen.getByTestId('background-task-bar-command').textContent).toBe('ls');
    });
  });

  describe('kill', () => {
    it('a running row carries a kill control; an ended one does not', async () => {
      await renderWithTasks(1, [
        task({ taskId: 'run', startedAt: 2 }),
        task({ taskId: 'end', status: 'exited', startedAt: 1, endedAt: 5 }),
      ]);
      useUiStore.getState().setBackgroundTasksShowAll(true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getAllByTestId('background-task-bar-kill')).toHaveLength(1);
    });

    it("clicking kill calls watchStop for that task and not the row's open-terminal action", async () => {
      await renderWithTasks(1, [task({ taskId: 't1' })]);
      fireEvent.click(screen.getByTestId('background-task-bar-kill'));
      expect(watchStopApi).toHaveBeenCalledWith('c1', 't1');
      expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c1' })).toBeNull();
    });

    it('killing the last running task takes the bar away once chat.state reports 0', async () => {
      await renderWithTasks(1, [task({ taskId: 't1' })]);
      await act(async () => {
        fireEvent.click(screen.getByTestId('background-task-bar-kill'));
        await Promise.resolve();
      });
      // The host's own emitState is what actually drops the count in
      // production; this test drives that edge directly.
      act(() => setLiveCount(0));
      expect(screen.queryByTestId('background-task-bar')).toBeNull();
    });
  });

  describe('clicking a task (not the kill button)', () => {
    it('every task row is a real button, named for the task it opens', async () => {
      await renderWithTasks(1, [task()]);
      const row = screen.getByTestId('background-task-bar-task');
      expect(row.tagName).toBe('BUTTON');
      expect(row.getAttribute('aria-label')).toBe(
        'Show what "Build web package to compile CSS" is doing in the terminal',
      );
    });

    it("switches the terminal to its tab form, tailing the watch's own output file", async () => {
      await renderWithTasks(1, [task({ outputFile: '/data/chats/c1/watch/t1.output' })]);
      expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c1' })).toBeNull();
      fireEvent.click(screen.getByTestId('background-task-bar-task'));
      expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c1' })).not.toBeNull();
      const pending = useTerminalStore.getState().pending['c1'];
      expect(pending?.kind).toBe('command');
      expect(pending?.text).toBe("tail -n 200 -f '/data/chats/c1/watch/t1.output'");
    });

    it('the collapse chevron still folds the stack and does not open a terminal', async () => {
      await renderWithTasks(1, [task()]);
      fireEvent.click(screen.getByTestId('background-task-bar-toggle'));
      expect(screen.getByTestId('background-task-bar').dataset['collapsed']).toBe('true');
      expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c1' })).toBeNull();
    });
  });

  describe('show all', () => {
    it('by default draws only the running task, not the ended one', async () => {
      await renderWithTasks(1, [
        task({ taskId: 'run', startedAt: 2 }),
        task({ taskId: 'end', status: 'exited', startedAt: 1, endedAt: 5 }),
      ]);
      expect(screen.getAllByTestId('background-task-bar-task')).toHaveLength(1);
      expect(screen.getByTestId('background-task-bar-count').textContent).toBe('1 background task');
    });

    it('checking it lists the ended task under the running one, struck (data-ended)', async () => {
      await renderWithTasks(1, [
        task({ taskId: 'run', description: 'still going', startedAt: 2 }),
        task({ taskId: 'end', description: 'done', status: 'exited', startedAt: 1, endedAt: 5 }),
      ]);
      fireEvent.click(screen.getByTestId('background-task-bar-show-all'));
      const rows = screen.getAllByTestId('background-task-bar-task');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toContain('still going');
      expect(rows[0]!.dataset['ended']).toBe('false');
      expect(rows[1]!.textContent).toContain('done');
      expect(rows[1]!.dataset['ended']).toBe('true');
    });

    it('an ended row does not spin', async () => {
      await renderWithTasks(1, [
        task({ taskId: 'run', startedAt: 2 }),
        task({ taskId: 'end', status: 'exited', startedAt: 1, endedAt: 5 }),
      ]);
      useUiStore.getState().setBackgroundTasksShowAll(true);
      await act(async () => {
        await Promise.resolve();
      });
      const ended = screen
        .getAllByTestId('background-task-bar-task')
        .find((r) => r.dataset['ended'] === 'true')!;
      expect(ended.querySelectorAll('.background-task-bar-spinner')).toHaveLength(0);
    });

    it('takes the bar away when the last running task ends, ended list or not', async () => {
      await renderWithTasks(1, [task({ taskId: 't1' })]);
      useUiStore.getState().setBackgroundTasksShowAll(true);
      expect(screen.getByTestId('background-task-bar')).toBeTruthy();
      act(() => setLiveCount(0));
      expect(screen.queryByTestId('background-task-bar')).toBeNull();
    });
  });

  describe('polling', () => {
    it('re-polls the list on an interval while something is running', async () => {
      vi.useFakeTimers();
      try {
        seed();
        watchListApi.mockResolvedValue({ tasks: [task()] });
        renderChat();
        await act(async () => {
          setLiveCount(1);
          await Promise.resolve();
        });
        expect(watchListApi).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(watchListApi.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops polling once the live count drops to 0', async () => {
      vi.useFakeTimers();
      try {
        seed();
        watchListApi.mockResolvedValue({ tasks: [task()] });
        renderChat();
        await act(async () => {
          setLiveCount(1);
          await Promise.resolve();
        });
        watchListApi.mockClear();
        act(() => setLiveCount(0));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12_000);
        });
        expect(watchListApi).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
