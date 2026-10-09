// `patch.watch_list.request` / `patch.watch_stop.request` — the surface-facing
// RPC pair behind the Background task bar (spec/14 § Main chat panel —
// Background task bar). Unlike `handleBackgroundTaskStatsRequest`'s own
// process-table probing, this is a thin wrapper: the interesting behaviour is
// the wire shape (WatchRecord → WatchTaskRow) and the chat_not_found gate
// every RPC in this family shares.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import type { WatchRecord } from '../src/watch.js';
import {
  handleWatchListRequest,
  handleWatchStopRequest,
  type WatchRequestsDeps,
} from '../src/watchRequests.js';

const silent = pino({ level: 'silent' });

const RUNNING: WatchRecord = {
  chatId: 'c1',
  taskId: 't1',
  description: 'run the test suite',
  command: 'pnpm test',
  cwd: '/tmp/c1',
  outputFile: '/tmp/c1/watch/t1.output',
  pid: 4242,
  startedAt: 1_700_000_000_000,
  status: 'running',
};

function deps(overrides: Partial<WatchRequestsDeps> = {}): WatchRequestsDeps {
  return {
    hasChat: () => true,
    listWatch: () => [RUNNING],
    stopWatch: () => true,
    ...overrides,
  };
}

describe('handleWatchListRequest', () => {
  const request = {
    type: 'patch.watch_list.request' as const,
    requestId: 'r1',
    chatId: 'c1',
  };

  it('answers with every watch, stripped to the wire shape', () => {
    const sent: WireEvent[] = [];
    handleWatchListRequest(request, deps(), (e) => sent.push(e), silent);
    expect(sent).toEqual([
      {
        type: 'patch.watch_list.response',
        requestId: 'r1',
        ok: true,
        tasks: [
          {
            taskId: 't1',
            description: 'run the test suite',
            command: 'pnpm test',
            outputFile: '/tmp/c1/watch/t1.output',
            status: 'running',
            startedAt: 1_700_000_000_000,
          },
        ],
      },
    ]);
  });

  it('carries endedAt/exitCode/signal through for an ended task', () => {
    const ended: WatchRecord = {
      ...RUNNING,
      status: 'failed',
      endedAt: 1_700_000_100_000,
      exitCode: 1,
      signal: null,
    };
    const sent: WireEvent[] = [];
    handleWatchListRequest(
      request,
      deps({ listWatch: () => [ended] }),
      (e) => sent.push(e),
      silent,
    );
    expect(sent[0]).toMatchObject({
      ok: true,
      tasks: [{ status: 'failed', endedAt: 1_700_000_100_000, exitCode: 1, signal: null }],
    });
  });

  it('answers ok with an empty list when the chat has never watched anything', () => {
    const sent: WireEvent[] = [];
    handleWatchListRequest(request, deps({ listWatch: () => [] }), (e) => sent.push(e), silent);
    expect(sent[0]).toEqual({
      type: 'patch.watch_list.response',
      requestId: 'r1',
      ok: true,
      tasks: [],
    });
  });

  it('refuses a chat this host does not have', () => {
    const sent: WireEvent[] = [];
    handleWatchListRequest(request, deps({ hasChat: () => false }), (e) => sent.push(e), silent);
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
  });

  it('reports a thrown failure as internal rather than crashing the host', () => {
    const sent: WireEvent[] = [];
    handleWatchListRequest(
      request,
      deps({
        listWatch: () => {
          throw new Error('disk read failed');
        },
      }),
      (e) => sent.push(e),
      silent,
    );
    expect(sent[0]).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'disk read failed' },
    });
  });
});

describe('handleWatchStopRequest', () => {
  const request = {
    type: 'patch.watch_stop.request' as const,
    requestId: 'r2',
    chatId: 'c1',
    taskId: 't1',
  };

  it('kills the task and answers stopped: true', () => {
    const sent: WireEvent[] = [];
    handleWatchStopRequest(request, deps({ stopWatch: () => true }), (e) => sent.push(e), silent);
    expect(sent).toEqual([
      { type: 'patch.watch_stop.response', requestId: 'r2', ok: true, stopped: true },
    ]);
  });

  it('is idempotent: stopping an already-ended task answers stopped: false, not an error', () => {
    const sent: WireEvent[] = [];
    handleWatchStopRequest(request, deps({ stopWatch: () => false }), (e) => sent.push(e), silent);
    expect(sent[0]).toEqual({
      type: 'patch.watch_stop.response',
      requestId: 'r2',
      ok: true,
      stopped: false,
    });
  });

  it('refuses a chat this host does not have', () => {
    const sent: WireEvent[] = [];
    handleWatchStopRequest(request, deps({ hasChat: () => false }), (e) => sent.push(e), silent);
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
  });

  it('reports a thrown failure as internal', () => {
    const sent: WireEvent[] = [];
    handleWatchStopRequest(
      request,
      deps({
        stopWatch: () => {
          throw new Error('kill failed');
        },
      }),
      (e) => sent.push(e),
      silent,
    );
    expect(sent[0]).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'kill failed' },
    });
  });
});
