// Render coverage for the mobile Background task bar (spec/15 § Chat detail;
// background-task reliability overhaul part 3). Mirrors
// packages/web/src/__tests__/ChatRoute.backgroundTaskBar.test.tsx's shape,
// plus the tap-to-open modal.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderRN, queryHost, findAllHost, byTestId, textOf } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { BackgroundTaskBar } from '../src/components/BackgroundTaskBar';
import type { WatchTaskRow } from '@patch/wire';
import { routerMock } from './stubs/expo-router';

// `vi.mock` is hoisted above every top-level statement, including `import`s —
// and `BackgroundTaskBar` (imported below) statically imports `../api/rest`,
// so the mock factory runs during the import phase, before an ordinary
// top-level `const` would have been assigned. `vi.hoisted` is what makes the
// object it returns safe to close over from inside the factory.
const apiMocks = vi.hoisted(() => ({
  watchList: vi.fn(async () => ({ tasks: [] as WatchTaskRow[] })),
  watchStop: vi.fn(async () => ({ stopped: true })),
}));
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

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
      lastUpdated: 0,
    },
  ]);
}

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

describe('BackgroundTaskBar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    apiMocks.watchList.mockReset();
    apiMocks.watchList.mockResolvedValue({ tasks: [] });
    apiMocks.watchStop.mockReset();
    apiMocks.watchStop.mockResolvedValue({ stopped: true });
    seed();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing, and never polls, when the chat has nothing running', () => {
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    expect(queryHost(r.root, byTestId('background-task-bar'))).toBeNull();
    expect(apiMocks.watchList).not.toHaveBeenCalled();
  });

  it('appears the moment chat.state reports a count, and lists the running task once the poll lands', async () => {
    apiMocks.watchList.mockResolvedValue({ tasks: [task()] });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    expect(queryHost(r.root, byTestId('background-task-bar'))).not.toBeNull();
    expect(textOf(queryHost(r.root, byTestId('background-task-bar-count'))!)).toBe(
      '1 background task',
    );
    const rows = findAllHost(r.root, byTestId('background-task-bar-task'));
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]!)).toContain('Build web package to compile CSS');
  });

  it("shows a running row's elapsed time, ticking upward", async () => {
    vi.useFakeTimers();
    const NOW = 1_800_000_000_000;
    vi.setSystemTime(NOW);
    apiMocks.watchList.mockResolvedValue({ tasks: [task({ startedAt: NOW })] });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    expect(textOf(queryHost(r.root, byTestId('background-task-bar-elapsed'))!)).toBe('0s');
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(textOf(queryHost(r.root, byTestId('background-task-bar-elapsed'))!)).toBe('3s');
  });

  it('truncates a long command and expands it on tap', async () => {
    const long = 'pnpm --filter @patch/web test -- --grep a-much-longer-flag-than-the-preview';
    apiMocks.watchList.mockResolvedValue({ tasks: [task({ command: long })] });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    const preview = queryHost(r.root, byTestId('background-task-bar-command'))!;
    expect(textOf(preview)).not.toBe(long);
    await act(async () => {
      preview.props['onPress']();
    });
    expect(textOf(queryHost(r.root, byTestId('background-task-bar-command'))!)).toBe(long);
  });

  it('kill calls watchStop for that task', async () => {
    apiMocks.watchList.mockResolvedValue({ tasks: [task({ taskId: 't1' })] });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    const kill = queryHost(r.root, byTestId('background-task-bar-kill'))!;
    await act(async () => {
      kill.props['onPress']();
      await Promise.resolve();
    });
    expect(apiMocks.watchStop).toHaveBeenCalledWith('c1', 't1');
  });

  it('an ended row carries no elapsed clock and no kill control', async () => {
    apiMocks.watchList.mockResolvedValue({
      tasks: [
        task({ taskId: 'run', startedAt: 2 }),
        task({ taskId: 'end', status: 'exited', startedAt: 1, endedAt: 5 }),
      ],
    });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    const showAll = queryHost(r.root, byTestId('background-task-bar-show-all'))!;
    await act(async () => {
      showAll.props['onPress']();
    });
    const rows = findAllHost(r.root, byTestId('background-task-bar-task'));
    expect(rows).toHaveLength(2);
    expect(findAllHost(r.root, byTestId('background-task-bar-kill'))).toHaveLength(1);
    expect(findAllHost(r.root, byTestId('background-task-bar-elapsed'))).toHaveLength(1);
  });

  it('by default shows only running tasks, not ended ones', async () => {
    apiMocks.watchList.mockResolvedValue({
      tasks: [
        task({ taskId: 'run', startedAt: 2 }),
        task({ taskId: 'end', status: 'exited', startedAt: 1, endedAt: 5 }),
      ],
    });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    expect(findAllHost(r.root, byTestId('background-task-bar-task'))).toHaveLength(1);
  });

  it('collapses to the summary line and back', async () => {
    apiMocks.watchList.mockResolvedValue({ tasks: [task()] });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    const toggle = queryHost(r.root, byTestId('background-task-bar-toggle'))!;
    await act(async () => {
      toggle.props['onPress']();
    });
    expect(findAllHost(r.root, byTestId('background-task-bar-task'))).toHaveLength(0);
    expect(textOf(queryHost(r.root, byTestId('background-task-bar-count'))!)).toBe(
      '1 background task',
    );
  });

  it('disappears once the live count drops to 0', async () => {
    apiMocks.watchList.mockResolvedValue({ tasks: [task()] });
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      setLiveCount(1);
      await Promise.resolve();
    });
    expect(queryHost(r.root, byTestId('background-task-bar'))).not.toBeNull();
    await act(async () => {
      setLiveCount(0);
    });
    expect(queryHost(r.root, byTestId('background-task-bar'))).toBeNull();
  });

  it('tapping a task opens a modal with its full text; Terminal opens the host terminal tailing its output', async () => {
    apiMocks.watchList.mockResolvedValue({ tasks: [task()] });
    setLiveCount(1);
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      await Promise.resolve();
    });
    const press = (id: string): void =>
      act(() => {
        (findAllHost(r.root, byTestId(id))[0].props.onPress as () => void)();
      });
    expect(queryHost(r.root, byTestId('background-task-modal'))).toBeNull();
    press('background-task-bar-open');
    expect(textOf(findAllHost(r.root, byTestId('background-task-modal-command'))[0])).toBe(
      'pnpm --filter @patch/web build',
    );
    press('background-task-modal-terminal');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/hosts/[daemonId]/terminal',
      params: {
        daemonId: 'd1',
        folder: 'foo',
        command: "tail -n 200 -f '/data/chats/c1/watch/t1.output'",
      },
    });
    expect(queryHost(r.root, byTestId('background-task-modal'))).toBeNull();
  });

  it('the modal can kill a running task', async () => {
    apiMocks.watchList.mockResolvedValue({ tasks: [task()] });
    setLiveCount(1);
    const r = renderRN(<BackgroundTaskBar chatId="c1" />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      (findAllHost(r.root, byTestId('background-task-bar-open'))[0].props.onPress as () => void)();
    });
    await act(async () => {
      (
        findAllHost(r.root, byTestId('background-task-modal-kill'))[0].props.onPress as () => void
      )();
    });
    expect(apiMocks.watchStop).toHaveBeenCalledWith('c1', 't1');
  });
});
