// `patch.watch_list.request` / `patch.watch_stop.request` handlers — the
// surface-facing counterpart to the agent-facing `patch_watch_list` /
// `patch_watch_stop` MCP tools (mcp.ts), for the Background task bar (spec/14
// § Main chat panel — Background task bar). Same server→host→server
// round-trip `patch.background_task_stats.*` uses (backgroundTaskStats.ts):
// the server has no filesystem access to the host's persisted watch
// records, so it asks over the daemon-link and waits for the matching
// response.
//
// Thin wrappers over `Daemon.listWatch`/`Daemon.stopWatch` (chatRunner.ts),
// which are themselves thin wrappers over `WatchScheduler` (watch.ts) — no
// logic of its own beyond the wire shape and the "does this host know this
// chat" check every RPC in this family does.

import type { Logger } from 'pino';
import type {
  PatchWatchListRequestEvent,
  PatchWatchStopRequestEvent,
  WatchTaskRow,
  WireEvent,
} from '@patch/wire';
import type { WatchRecord } from './watch.js';

export interface WatchRequestsDeps {
  hasChat(chatId: string): boolean;
  listWatch(chatId: string): WatchRecord[];
  stopWatch(chatId: string, taskId: string): boolean;
}

/** `WatchRecord` (daemon-internal: also carries chatId/cwd/pid) → the wire row a surface gets. */
function toWireRow(rec: WatchRecord): WatchTaskRow {
  return {
    taskId: rec.taskId,
    description: rec.description,
    command: rec.command,
    outputFile: rec.outputFile,
    status: rec.status,
    startedAt: rec.startedAt,
    ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
    ...(rec.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
    ...(rec.signal !== undefined ? { signal: rec.signal } : {}),
  };
}

export function handleWatchListRequest(
  event: PatchWatchListRequestEvent,
  deps: WatchRequestsDeps,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  if (!deps.hasChat(event.chatId)) {
    sender({
      type: 'patch.watch_list.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'chat_not_found', message: `chat not found: ${event.chatId}` },
    });
    return;
  }
  try {
    const tasks = deps.listWatch(event.chatId).map(toWireRow);
    sender({ type: 'patch.watch_list.response', requestId: event.requestId, ok: true, tasks });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId },
      'patch.watch_list.request: listWatch failed',
    );
    sender({
      type: 'patch.watch_list.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: (err as Error).message },
    });
  }
}

export function handleWatchStopRequest(
  event: PatchWatchStopRequestEvent,
  deps: WatchRequestsDeps,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  if (!deps.hasChat(event.chatId)) {
    sender({
      type: 'patch.watch_stop.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'chat_not_found', message: `chat not found: ${event.chatId}` },
    });
    return;
  }
  try {
    const stopped = deps.stopWatch(event.chatId, event.taskId);
    sender({ type: 'patch.watch_stop.response', requestId: event.requestId, ok: true, stopped });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, taskId: event.taskId },
      'patch.watch_stop.request: stopWatch failed',
    );
    sender({
      type: 'patch.watch_stop.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: (err as Error).message },
    });
  }
}
