// Renders a live chat: status strip + scrolling event log + input prompt.
// Per spec/13-design-terminal.md — same shape as Claude Code, plus the
// patch status strip.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { WireEvent } from '@patch/wire';
import type { ConnectionState, PatchWsClient } from '../transport/ws.js';
import { StatusStrip } from './StatusStrip.js';

/** One-line summary of a tool's args, Claude-Code style: `[Read src/x.ts]`. */
function summariseToolArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return String(args);
  const a = args as Record<string, unknown>;
  // Prefer the conventional path-ish field so a call reads like native output.
  for (const k of ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url']) {
    const v = a[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const keys = Object.keys(a);
  return keys.length > 0 ? keys.join(',') : '';
}

/** Truncate a tool result to a single short line for the stream. */
function summariseResult(result: unknown): string {
  const text =
    typeof result === 'string' ? result : result === undefined ? '' : JSON.stringify(result);
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

/** A permission prompt awaiting the user's approve/deny. */
interface PendingPermission {
  requestId: string;
  tool: string;
  args: unknown;
  description?: string;
}

export interface ChatViewProps {
  ws: PatchWsClient;
  chatId: string;
  folder?: string;
  /** When true, suppress the StatusStrip render (per --no-status). */
  hideStatus?: boolean;
  onExit: () => void;
}

interface DisplayLine {
  key: string;
  text: string;
  dim?: boolean;
}

/** Per-chat input history — lives module-level so navigation persists across remounts. */
const HISTORY: Map<string, string[]> = new Map();
const HISTORY_LIMIT = 50;
const CTRL_C_WINDOW_MS = 2_000;

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [state, setState] = useState<ConnectionState>(props.ws.getState());
  const [phoneActive, setPhoneActive] = useState(false);
  const [input, setInput] = useState('');
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [hint, setHint] = useState<string>('');
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const ctrlCAtRef = useRef<number>(0);

  useEffect(() => {
    const offState = props.ws.onState(setState);
    const offMsg = props.ws.on('chat.message', (e) => {
      if (e.chatId !== props.chatId) return;
      setLines((ls) => [...ls, { key: `m-${e.seq}`, text: `${e.role}: ${e.content}` }]);
    });
    const offTool = props.ws.on('chat.tool_call', (e) => {
      if (e.chatId !== props.chatId) return;
      // Native-Claude-Code shape: `[Read src/layout.ts]`.
      const summary = summariseToolArgs(e.args);
      const text = summary.length > 0 ? `[${e.tool}  ${summary}]` : `[${e.tool}]`;
      setLines((ls) => [...ls, { key: `t-${e.seq}`, text, dim: true }]);
    });
    const offToolResult = props.ws.on('chat.tool_result', (e) => {
      if (e.chatId !== props.chatId) return;
      const summary = summariseResult(e.result);
      const prefix = e.isError ? `[${e.tool} ✗]` : `[${e.tool} ✓]`;
      const text = summary.length > 0 ? `${prefix} ${summary}` : prefix;
      setLines((ls) => [...ls, { key: `tr-${e.seq}`, text, dim: true }]);
    });
    const offPerm = props.ws.on('chat.permission_request', (e) => {
      if (e.chatId !== props.chatId) return;
      const summary = summariseToolArgs(e.request.args);
      const head = summary.length > 0 ? `${e.request.tool}  ${summary}` : e.request.tool;
      setLines((ls) => [...ls, { key: `p-${e.seq}`, text: `⚠ permission requested: ${head}` }]);
      // If a proposed diff was attached, render it inline like native output.
      const diff = e.request.proposedDiff;
      if (typeof diff === 'string' && diff.length > 0) {
        setLines((ls) => [
          ...ls,
          ...diff
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l, i) => ({ key: `pd-${e.seq}-${i}`, text: l, dim: true })),
        ]);
      }
      setPendingPermission({
        requestId: e.requestId,
        tool: e.request.tool,
        args: e.request.args,
        ...(e.request.description !== undefined ? { description: e.request.description } : {}),
      });
    });
    const offFg = props.ws.on('surface.foregrounded', () => setPhoneActive(true));
    const offBg = props.ws.on('surface.backgrounded', () => setPhoneActive(false));
    // Render the existing stream on mount, AFTER the per-type listeners above
    // are registered so a fast replay response can't race ahead of them. The
    // spawn path renders live because this surface drives the turn; the
    // attach/resume/browse paths join a chat that is already (or has already
    // been) producing output, so we must track the chat and request a replay —
    // otherwise the event pane stays empty until the next live event.
    // attachChat is idempotent and also ensures any reconnect re-replays it.
    props.ws.attachChat(props.chatId);
    return (): void => {
      offState();
      offMsg();
      offTool();
      offToolResult();
      offPerm();
      offFg();
      offBg();
    };
  }, [props.ws, props.chatId]);

  function resolvePermission(approve: boolean): void {
    const p = pendingPermission;
    if (!p) return;
    try {
      props.ws.send({
        type: 'chat.permission_response',
        chatId: props.chatId,
        requestId: p.requestId,
        approve,
      });
    } catch {
      // ignore — surface the decision locally regardless.
    }
    setLines((ls) => [
      ...ls,
      { key: `pr-${p.requestId}`, text: approve ? '✔ approved' : '✘ denied', dim: true },
    ]);
    setPendingPermission(null);
  }

  function pushHistory(value: string): void {
    if (value.length === 0) return;
    const arr = HISTORY.get(props.chatId) ?? [];
    arr.push(value);
    while (arr.length > HISTORY_LIMIT) arr.shift();
    HISTORY.set(props.chatId, arr);
  }

  function submit(): void {
    if (input.length === 0) return;
    try {
      props.ws.sendInput(props.chatId, input);
    } catch {
      setLines((ls) => [...ls, { key: `e-${Date.now()}`, text: '(send failed)', dim: true }]);
    }
    pushHistory(input);
    setInput('');
    setHistoryIdx(null);
  }

  useInput((char, key) => {
    // A permission prompt takes precedence: approve/deny it before anything
    // else (mirrors native Claude Code's blocking permission affordance).
    if (pendingPermission) {
      if (char === 'a' || char === 'y') {
        resolvePermission(true);
        return;
      }
      if (char === 'd' || char === 'n' || key.escape) {
        resolvePermission(false);
        return;
      }
      return;
    }

    if (phoneActive) {
      setPhoneActive(false);
      try {
        props.ws.send({ type: 'surface.foregrounded' });
      } catch {
        // ignore
      }
      return;
    }

    // Ctrl+C: first press cancels generation / shows hint; second within
    // 2s exits. Any other keystroke resets the counter.
    if (key.ctrl && char === 'c') {
      const now = Date.now();
      if (ctrlCAtRef.current && now - ctrlCAtRef.current < CTRL_C_WINDOW_MS) {
        props.onExit();
        return;
      }
      ctrlCAtRef.current = now;
      setHint('Press Ctrl+C again to exit');
      return;
    }
    // Reset Ctrl+C window on any other keystroke.
    if (ctrlCAtRef.current !== 0) {
      ctrlCAtRef.current = 0;
      setHint('');
    }

    // Shift+Enter → newline. Plain Enter → submit.
    if (key.return) {
      if (key.shift) {
        setInput((s) => s + '\n');
        return;
      }
      submit();
      return;
    }

    if (key.upArrow) {
      const arr = HISTORY.get(props.chatId) ?? [];
      if (arr.length === 0) return;
      const next = historyIdx === null ? arr.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      const v = arr[next];
      if (v !== undefined) setInput(v);
      return;
    }
    if (key.downArrow) {
      const arr = HISTORY.get(props.chatId) ?? [];
      if (historyIdx === null) return;
      const next = historyIdx + 1;
      if (next >= arr.length) {
        setHistoryIdx(null);
        setInput('');
        return;
      }
      setHistoryIdx(next);
      const v = arr[next];
      if (v !== undefined) setInput(v);
      return;
    }

    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  return (
    <Box flexDirection="column">
      {props.hideStatus ? null : (
        <StatusStrip
          state={state}
          chatId={props.chatId}
          {...(props.folder !== undefined ? { folder: props.folder } : {})}
          phoneActive={phoneActive}
        />
      )}
      <Box flexDirection="column" marginTop={1}>
        {lines.slice(-30).map((l) => (
          <Text key={l.key} dimColor={l.dim ?? false}>
            {l.text}
          </Text>
        ))}
      </Box>
      {pendingPermission ? (
        <Box marginTop={1}>
          <Text>{`Allow ${pendingPermission.tool}? [a]pprove / [d]eny`}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text>{'> '}</Text>
          <Text>{input}</Text>
        </Box>
      )}
      {hint.length > 0 ? (
        <Box>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// Test helper — clear the per-chat history (vitests).
export function _resetChatHistory(): void {
  HISTORY.clear();
}

// Re-export for tests.
export type { WireEvent };
