// TaskBar — the agent's task list above the transcript (spec/02 § Task list).
// Mobile port of web's TaskBar (packages/web/src/components/TaskBar.tsx): same
// data, same route, same editing. Collapsed it is one line — the item in
// progress (or the next pending one) and `done/total`. Expanded, every item is
// the user's to change, because the list is what the host fires the agent's
// next turn from: the status dot cycles pending → in progress → done, the text
// is tap-to-edit, × deletes, and a trailing field adds one. Every edit sends
// the WHOLE list, optimistically, reverting with a toast on failure.

import React, { useState, type ReactElement } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Plus,
  X,
} from 'lucide-react-native';
import type { TodoItem } from '@patch/wire';
import type { ChatRow } from '../../stores/types';
import { NEXT_TODO_STATUS, TODO_STATUS_LABEL, todoSummary, writeTodos } from '../../lib/chatMeta';
import { space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';
import { InlineEditText } from './InlineEditText';

function StatusIcon({ status, color }: { status: TodoItem['status']; color: string }) {
  if (status === 'completed') return <CircleCheck size={16} color={color} />;
  if (status === 'in_progress') return <CircleDot size={16} color={color} />;
  return <Circle size={16} color={color} />;
}

export function TaskBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const [open, setOpen] = useState(false);
  const [newTask, setNewTask] = useState('');
  const todos = row.todos;
  if (todos.length === 0) return null;

  const { head, done } = todoSummary(todos);
  const commit = (next: TodoItem[]): void => void writeTodos(row.chatId, next);

  const addTask = (): void => {
    const text = newTask.trim();
    if (text === '') return;
    setNewTask('');
    commit([...todos, { text, status: 'pending' }]);
  };

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <BarShell testID="task-bar">
      <Pressable
        testID="task-bar-summary"
        accessibilityRole="button"
        accessibilityLabel={open ? 'Collapse task list' : 'Expand task list'}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
      >
        <Chevron size={14} color={colors.ink2} />
        <Text
          testID="task-bar-head"
          numberOfLines={1}
          style={{ flex: 1, color: colors.ink2, fontSize: textMin }}
        >
          {head ?? 'All tasks done'}
        </Text>
        <Text testID="task-bar-count" style={{ color: colors.ink3, fontSize: textMin }}>
          {done}/{todos.length}
        </Text>
      </Pressable>
      {open ? (
        <View testID="task-bar-list" style={{ paddingTop: space.xs }}>
          {todos.map((t, i) => {
            const struck = t.status === 'completed';
            return (
              <View
                key={`${i}-${t.text}`}
                testID="task-row"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  paddingVertical: space.xs,
                }}
              >
                <Pressable
                  testID="task-status-btn"
                  accessibilityRole="button"
                  accessibilityLabel={`Task ${TODO_STATUS_LABEL[t.status]}, mark ${
                    TODO_STATUS_LABEL[NEXT_TODO_STATUS[t.status]]
                  }`}
                  onPress={() =>
                    commit(
                      todos.map((x, j) =>
                        j === i ? { ...x, status: NEXT_TODO_STATUS[x.status] } : x,
                      ),
                    )
                  }
                  hitSlop={8}
                >
                  <StatusIcon
                    status={t.status}
                    color={t.status === 'in_progress' ? colors.leaf : colors.ink3}
                  />
                </Pressable>
                <InlineEditText
                  testID="task-text"
                  editLabel="Edit task"
                  value={t.text}
                  onCommit={(text) => commit(todos.map((x, j) => (j === i ? { ...x, text } : x)))}
                  textStyle={{
                    color: struck ? colors.ink3 : colors.ink,
                    fontSize: textMin,
                    textDecorationLine: struck ? 'line-through' : 'none',
                  }}
                />
                <Pressable
                  testID="task-delete-btn"
                  accessibilityRole="button"
                  accessibilityLabel="Delete task"
                  onPress={() => commit(todos.filter((_, j) => j !== i))}
                  hitSlop={8}
                >
                  <X size={14} color={colors.ink3} />
                </Pressable>
              </View>
            );
          })}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              paddingVertical: space.xs,
            }}
          >
            <Plus size={16} color={colors.ink3} />
            <TextInput
              testID="task-add-input"
              accessibilityLabel="Add task"
              placeholder="Add task"
              placeholderTextColor={colors.ink3}
              value={newTask}
              onChangeText={setNewTask}
              onSubmitEditing={addTask}
              returnKeyType="done"
              style={{ flex: 1, padding: 0, color: colors.ink, fontSize: textMin }}
            />
          </View>
        </View>
      ) : null}
    </BarShell>
  );
}
