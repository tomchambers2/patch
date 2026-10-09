// BackgroundTaskBar — this chat's still-running `patch_watch` tasks, above the
// transcript (spec/14 § Main chat panel — Background task bar).
//
// A watched command keeps running after the turn that launched it ends, so a
// chat can read as idle with work still in flight. This is the standing
// readout: ONE BAR PER TASK, newest first, each spinning while it runs. The
// stack folds back to a single summary line on demand, and the fold persists
// (uiStore). Nothing to show when nothing of this chat's is running.
//
// Data comes from `GET /api/chats/:id/watch` (real fields off the host's
// persisted watch record: command, description, status, startedAt), not
// scraped from the transcript — the old Bash/Task `run_in_background`
// mechanism this replaced could never support a kill button (no real pid to
// signal), which is exactly why patch_watch exists (sdkBackend.ts's
// `canUseTool` deny).
//
// Unlike the old bar, the user can act on a row here: a kill button (X) ends
// the task outright (Tom's call — the prior "the agent owns the task, no kill
// control" decision from spec/14-design-web.md is reversed). Each running row
// also carries its own elapsed clock and a command preview that expands to
// the full string on click.
//
// A task that has ENDED is not in the stack, does not turn and is not
// counted: a bar that keeps a finished task reads as work that is stuck,
// which is the one thing this readout must never say by accident. The Show
// all checkbox on the title row brings the ends back as struck-through rows
// under the running ones.

import { useEffect, useRef, useState, type JSX } from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, X } from 'lucide-react';
import type { WatchTaskRow } from '@patch/wire';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import {
  backgroundBarTitle,
  formatElapsed,
  runningWatchTasks,
  sortWatchTasks,
  watchTailCommand,
} from '../lib/backgroundTasks.js';

/**
 * The turning glyph. It carries a class rather than lucide's own
 * `lucide-loader`, because the animation is this bar's and not every loader
 * icon in the app.
 *
 * A smooth ring rather than a spoked wheel: spokes make every frame of the
 * rotation legible, so the glyph strobes instead of turning, and a strobe over
 * the transcript pulls the eye off what it is sitting above.
 */
function Spinner(): JSX.Element {
  return <LoaderCircle className="background-task-bar-spinner" size={16} aria-hidden />;
}

/** How long a command preview shows before it needs a click to see the rest. */
const COMMAND_PREVIEW_LEN = 48;

/**
 * How often the list is re-polled while the bar is on screen. Gated on the
 * chat's own LIVE running count (`chat.state.backgroundTasks`, updated the
 * instant a watch starts or is killed — chatRunner.ts's `emitState` calls in
 * `startWatch`/`stopWatch`), so nothing is polled for a chat with nothing
 * running: the live count is the source of truth for whether the bar exists
 * at all, and this poll only refines what is drawn inside it.
 */
const LIST_POLL_MS = 3_000;

/** How often running rows recompute their elapsed-time clock. */
const CLOCK_TICK_MS = 1_000;

/**
 * A row's command, clipped to a preview that expands to the full string on
 * click. Its own click target — expanding must not also fire a task row's
 * open-terminal click.
 */
function CommandPreview({
  command,
  expanded,
  onToggle,
}: {
  command: string;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const text =
    expanded || command.length <= COMMAND_PREVIEW_LEN
      ? command
      : `${command.slice(0, COMMAND_PREVIEW_LEN)}…`;
  return (
    <span
      className="background-task-bar-command"
      data-testid="background-task-bar-command"
      role="button"
      tabIndex={0}
      title="Show full command"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      {text}
    </span>
  );
}

function useWatchTasks(chatId: string, enabled: boolean): WatchTaskRow[] {
  const [tasks, setTasks] = useState<WatchTaskRow[]>([]);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      return;
    }
    let live = true;
    const load = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const res = await api.watchList(chatId);
        if (live) setTasks(res.tasks);
      } catch {
        // A failed poll keeps the last-known rows rather than blanking the
        // bar out from under a task that is, for all the caller knows, still
        // running fine — the live count (not this list) is what decides
        // whether the bar exists at all.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), LIST_POLL_MS);
    const onVisibility = (): void => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chatId, enabled]);

  return tasks;
}

export function BackgroundTaskBar({ chatId }: { chatId: string }): JSX.Element | null {
  const liveCount = useChatStore((s) => s.chats[chatId]?.backgroundTasks ?? 0);
  const collapsed = useUiStore((s) => s.backgroundTasksCollapsed);
  const setCollapsed = useUiStore((s) => s.setBackgroundTasksCollapsed);
  const showAll = useUiStore((s) => s.backgroundTasksShowAll);
  const setShowAll = useUiStore((s) => s.setBackgroundTasksShowAll);
  const queuePending = useTerminalStore((s) => s.queuePending);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState<Set<string>>(new Set());

  const [now, setNow] = useState(() => Date.now());

  // The bar exists at all only while the chat has something running — the
  // live count is authoritative and moves the instant a watch starts or is
  // killed, unlike the polled list below (which only refines what is drawn).
  const hasWork = liveCount > 0;
  const tasks = useWatchTasks(chatId, hasWork);

  const anyRunning = tasks.some((t) => t.status === 'running');
  const ticking = anyRunning && !collapsed;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);

  /**
   * Show what a task is doing: a terminal tab for this chat (spec/14 § Panes
   * and tabs), tailed on the watch's own output file — named exactly by its
   * record, never guessed.
   */
  function showTask(task: WatchTaskRow): void {
    queuePending(chatId, { kind: 'command', text: watchTailCommand(task.outputFile) });
    useLayoutStore.getState().openTab({ kind: 'terminal', chatId });
  }

  async function killTask(task: WatchTaskRow): Promise<void> {
    setKilling((prev) => new Set(prev).add(task.taskId));
    try {
      await api.watchStop(chatId, task.taskId);
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(task.taskId);
        return next;
      });
      // The host's own `emitState` already moved the live count; this just
      // refreshes the row list (status/endedAt) without waiting out the poll.
      try {
        const res = await api.watchList(chatId);
        setTasksOverride(res.tasks);
      } catch {
        // Next poll tick will catch up.
      }
    }
  }

  // A ref-backed override lets `killTask` push a fresh list immediately
  // without re-deriving `useWatchTasks`'s own effect.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [override, setOverride] = useState<WatchTaskRow[] | null>(null);
  function setTasksOverride(next: WatchTaskRow[]): void {
    setOverride(next);
  }
  const effectiveTasks = override ?? tasks;
  useEffect(() => {
    setOverride(null);
  }, [tasks]);

  function toggleExpanded(taskId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  if (!hasWork) return null;

  const shown = showAll ? sortWatchTasks(effectiveTasks) : runningWatchTasks(effectiveTasks);
  const summary = backgroundBarTitle(liveCount);

  return (
    <div
      className="background-task-bar"
      data-testid="background-task-bar"
      data-collapsed={collapsed ? 'true' : 'false'}
      role="status"
    >
      <div className="background-task-bar-rows">
        <span className="background-task-bar-row background-task-bar-title">
          {collapsed ? <Spinner /> : null}
          <span className="background-task-bar-count" data-testid="background-task-bar-count">
            {summary}
          </span>
          {collapsed ? null : (
            <label className="background-task-bar-all">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                data-testid="background-task-bar-show-all"
              />
              Show all
            </label>
          )}
        </span>
        {collapsed
          ? null
          : shown.map((task) => {
              const ended = task.status !== 'running';
              const isExpanded = expanded.has(task.taskId);
              const label = ended
                ? `Show what "${task.description}" did in the terminal`
                : `Show what "${task.description}" is doing in the terminal`;
              return (
                <button
                  key={task.taskId}
                  type="button"
                  className="background-task-bar-row"
                  data-testid="background-task-bar-task"
                  data-ended={ended ? 'true' : 'false'}
                  aria-label={label}
                  title={label}
                  onClick={() => showTask(task)}
                >
                  {ended ? (
                    <span className="background-task-bar-nospinner" aria-hidden />
                  ) : (
                    <Spinner />
                  )}
                  <span
                    className="background-task-bar-description"
                    data-testid="background-task-bar-description"
                  >
                    {task.description}
                  </span>
                  {ended ? null : (
                    <span
                      className="background-task-bar-elapsed"
                      data-testid="background-task-bar-elapsed"
                    >
                      {formatElapsed(task.startedAt, now)}
                    </span>
                  )}
                  <CommandPreview
                    command={task.command}
                    expanded={isExpanded}
                    onToggle={() => toggleExpanded(task.taskId)}
                  />
                  {ended ? null : (
                    // A plain span, not a nested `<button>`: this row IS a
                    // button (spec/14 — "every task row is a real button"),
                    // and interactive content inside interactive content is
                    // invalid HTML that browsers silently reparent out of the
                    // row, breaking the layout this bar depends on.
                    <span
                      className="background-task-bar-kill"
                      data-testid="background-task-bar-kill"
                      role="button"
                      tabIndex={0}
                      aria-label={`Kill "${task.description}"`}
                      title={`Kill "${task.description}"`}
                      aria-disabled={killing.has(task.taskId)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (killing.has(task.taskId)) return;
                        void killTask(task);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (killing.has(task.taskId)) return;
                        void killTask(task);
                      }}
                    >
                      <X size={14} aria-hidden />
                    </span>
                  )}
                </button>
              );
            })}
      </div>
      <button
        type="button"
        className="background-task-bar-toggle"
        data-testid="background-task-bar-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${summary}` : `Collapse ${summary}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
      </button>
    </div>
  );
}
