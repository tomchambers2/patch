// BackgroundTaskBar — this chat's still-running `patch_watch` tasks, above the
// transcript (spec/15 § Chat detail; background-task reliability overhaul
// part 3). Mirrors packages/web/src/components/BackgroundTaskBar.tsx. Tapping
// a task's description opens a modal with everything about it — full
// description, command, status — plus Kill and "Terminal", which opens the
// host terminal in the chat's folder already tailing the task's output file
// (the phone's version of web's terminal-tab click-through).
//
// The bar's existence is gated on the chat's LIVE `chat.state.backgroundTasks`
// count (chatStore's `ChatRow.backgroundTasks`), which the host updates the
// instant a watch starts or is killed (chatRunner.ts's `emitState` calls in
// `startWatch`/`stopWatch`) — so nothing is polled for a chat with nothing
// running, and the bar never waits on the poll to appear.

import React, { useEffect, useState, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import type { WatchTaskRow } from '@patch/wire';
import { api } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import {
  backgroundBarTitle,
  formatElapsed,
  runningWatchTasks,
  sortWatchTasks,
  watchTailCommand,
} from '../lib/backgroundTasks';
import { terminalRoute } from '../lib/hostFiles';
import { BarDetailSheet } from './chatBars/BarDetailSheet';
import { space, radii, useTheme, textMin, fonts } from '../lib/theme';

/** How often the list is re-polled while the bar is on screen. */
const LIST_POLL_MS = 3_000;
/** How often running rows recompute their elapsed-time clock. */
const CLOCK_TICK_MS = 1_000;
/** How long a command preview shows before it needs a tap to see the rest. */
const COMMAND_PREVIEW_LEN = 40;

function useWatchTasks(chatId: string, enabled: boolean): WatchTaskRow[] {
  const [tasks, setTasks] = useState<WatchTaskRow[]>([]);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      return;
    }
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const res = await api.watchList(chatId);
        if (live) setTasks(res.tasks);
      } catch {
        // A failed poll keeps the last-known rows — the live count, not this
        // list, is what decides whether the bar exists at all.
      }
    };
    void load();
    const timer = setInterval(() => void load(), LIST_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [chatId, enabled]);

  return tasks;
}

export function BackgroundTaskBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const row = useChatStore((s) => s.chats[chatId]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const liveCount = useChatStore((s) => s.chats[chatId]?.backgroundTasks ?? 0);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [killing, setKilling] = useState<Set<string>>(new Set());

  const [now, setNow] = useState(() => Date.now());

  const hasWork = liveCount > 0;
  const tasks = useWatchTasks(chatId, hasWork);

  const anyRunning = tasks.some((t) => t.status === 'running');
  const ticking = anyRunning && !collapsed;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

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
    }
  }

  function toggleExpanded(taskId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  if (!hasWork) return null;

  const shown = showAll ? sortWatchTasks(tasks) : runningWatchTasks(tasks);
  const summary = backgroundBarTitle(liveCount);
  const detailTask = detailId === null ? undefined : tasks.find((t) => t.taskId === detailId);

  function commandPreview(key: string, command: string): ReactElement {
    const isExpanded = expanded.has(key);
    const text =
      isExpanded || command.length <= COMMAND_PREVIEW_LEN
        ? command
        : `${command.slice(0, COMMAND_PREVIEW_LEN)}…`;
    return (
      <Pressable
        testID="background-task-bar-command"
        onPress={() => toggleExpanded(key)}
        accessibilityRole="button"
        accessibilityLabel="Show the full command"
        style={{ flexShrink: 1 }}
      >
        <Text
          numberOfLines={isExpanded ? undefined : 1}
          style={{ color: colors.ink3, fontSize: textMin, fontFamily: fonts.mono }}
        >
          {text}
        </Text>
      </Pressable>
    );
  }

  return (
    <View
      testID="background-task-bar"
      accessibilityRole="summary"
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: colors.divider,
        borderWidth: 1,
        borderRadius: radii.sm,
        margin: space.sm,
        padding: space.sm,
        gap: space.xs,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
        {collapsed ? <ActivityIndicator size="small" color={colors.ink2} /> : null}
        <Text
          testID="background-task-bar-count"
          style={{ color: colors.ink2, fontFamily: fonts.bodyMedium, fontSize: textMin, flex: 1 }}
        >
          {summary}
        </Text>
        {collapsed ? null : (
          <Pressable
            testID="background-task-bar-show-all"
            onPress={() => setShowAll((v) => !v)}
            hitSlop={space.sm}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: showAll }}
            accessibilityLabel="Show all"
          >
            <Text style={{ color: colors.ink3, fontSize: textMin }}>
              {showAll ? '☑' : '☐'} Show all
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="background-task-bar-toggle"
          onPress={() => setCollapsed((v) => !v)}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel={collapsed ? `Expand ${summary}` : `Collapse ${summary}`}
        >
          {collapsed ? (
            <ChevronDown size={16} color={colors.ink3} />
          ) : (
            <ChevronUp size={16} color={colors.ink3} />
          )}
        </Pressable>
      </View>
      {collapsed
        ? null
        : shown.map((task) => {
            const ended = task.status !== 'running';
            return (
              <View
                key={task.taskId}
                testID="background-task-bar-task"
                accessibilityLabel={
                  ended ? `"${task.description}" — ended` : `"${task.description}" — running`
                }
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
              >
                {ended ? (
                  <View style={{ width: 14 }} />
                ) : (
                  <ActivityIndicator size="small" color={colors.ink2} />
                )}
                <Pressable
                  testID="background-task-bar-open"
                  accessibilityRole="button"
                  accessibilityLabel={`Show "${task.description}"`}
                  onPress={() => setDetailId(task.taskId)}
                  style={{ flexShrink: 1 }}
                >
                  <Text
                    testID="background-task-bar-description"
                    numberOfLines={1}
                    style={{
                      color: colors.ink3,
                      fontSize: textMin,
                      flexShrink: 1,
                      textDecorationLine: ended ? 'line-through' : 'none',
                      opacity: ended ? 0.7 : 1,
                    }}
                  >
                    {task.description}
                  </Text>
                </Pressable>
                {ended ? null : (
                  <Text
                    testID="background-task-bar-elapsed"
                    style={{ color: colors.ink3, fontSize: textMin }}
                  >
                    {formatElapsed(task.startedAt, now)}
                  </Text>
                )}
                {commandPreview(task.taskId, task.command)}
                {ended ? null : (
                  <Pressable
                    testID="background-task-bar-kill"
                    onPress={() => void killTask(task)}
                    disabled={killing.has(task.taskId)}
                    hitSlop={space.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Kill "${task.description}"`}
                  >
                    <X size={14} color={killing.has(task.taskId) ? colors.ink3 : colors.red} />
                  </Pressable>
                )}
              </View>
            );
          })}
      {detailTask ? (
        <BarDetailSheet
          testID="background-task-modal"
          title={detailTask.status === 'running' ? 'Running' : 'Ended'}
          onClose={() => setDetailId(null)}
        >
          <Text testID="background-task-modal-description" selectable style={{ color: colors.ink }}>
            {detailTask.description}
          </Text>
          <Text
            testID="background-task-modal-command"
            selectable
            style={{
              color: colors.ink2,
              fontFamily: fonts.mono,
              fontSize: textMin,
              marginTop: space.sm,
            }}
          >
            {detailTask.command}
          </Text>
          <View style={{ flexDirection: 'row', gap: space.lg, marginTop: space.md }}>
            {row ? (
              <Pressable
                testID="background-task-modal-terminal"
                accessibilityRole="button"
                accessibilityLabel="Open in terminal"
                onPress={() => {
                  setDetailId(null);
                  router.push(
                    terminalRoute(
                      row.daemonId,
                      row.folder === '' ? undefined : row.folder,
                      watchTailCommand(detailTask.outputFile),
                    ) as never,
                  );
                }}
              >
                <Text style={{ color: colors.ink, fontFamily: fonts.bodyMedium }}>Terminal</Text>
              </Pressable>
            ) : null}
            {detailTask.status === 'running' ? (
              <Pressable
                testID="background-task-modal-kill"
                accessibilityRole="button"
                accessibilityLabel={`Kill "${detailTask.description}"`}
                disabled={killing.has(detailTask.taskId)}
                onPress={() => void killTask(detailTask)}
              >
                <Text style={{ color: colors.red, fontFamily: fonts.bodyMedium }}>Kill</Text>
              </Pressable>
            ) : null}
          </View>
        </BarDetailSheet>
      ) : null}
    </View>
  );
}
