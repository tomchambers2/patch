// `patch_watch`'s durable background-execution primitive (watch.ts). No prior
// coverage existed for `WatchScheduler` itself — only its wire shape via
// mcp-tools.test.ts's `listTools` gate — so the two guarantees the host's
// own commit message claims (survives a restart; delivers completion from
// OUTSIDE the watched process's own tree) were asserted but never verified.
// These run against the REAL `spawn`/process table (same choice
// backgroundTaskStats.test.ts makes for the same reason: a mocked child
// process can't prove a real pid/pgid was actually held, signalled, or
// re-discovered).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { WatchScheduler } from '../src/watch.js';

const silent = pino({ level: 'silent' });

function makeDeps(overrides: Partial<Parameters<typeof mkScheduler>[0]> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'patch-watch-')));
  const delivered: { chatId: string; message: string }[] = [];
  // Every chat `dirForChat` has ever been asked about — the resident poll's
  // `allChatIds()` needs to see a chat to scan it, and this test never wants
  // to hand-maintain that list alongside every `start()` call.
  const seenChatIds = new Set<string>();
  return {
    home,
    delivered,
    deliver: (chatId: string, message: string) => {
      delivered.push({ chatId, message });
    },
    dirForChat: (chatId: string) => {
      seenChatIds.add(chatId);
      const dir = join(home, chatId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    allChatIds: () => [...seenChatIds],
    now: () => Date.now(),
    logger: silent,
    pollMs: 25,
    ...overrides,
  };
}

function mkScheduler(deps: ReturnType<typeof makeDeps>): WatchScheduler {
  return new WatchScheduler(deps);
}

async function flushUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('WatchScheduler.start', () => {
  it('spawns a real detached process and persists a running record with a real pid', () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      const rec = scheduler.start({
        chatId: 'c1',
        command: 'sleep 5',
        description: 'a slow sleep',
        cwd: deps.home,
      });
      expect(rec.status).toBe('running');
      expect(rec.pid).toBeGreaterThan(0);
      expect(scheduler.list('c1')).toEqual([rec]);
    } finally {
      scheduler.stop('c1', scheduler.list('c1')[0]!.taskId);
      scheduler.dispose();
    }
  });

  it("writes the command's combined stdout+stderr to the output file", async () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      const rec = scheduler.start({
        chatId: 'c1',
        command: 'echo hello-watch; echo to-stderr 1>&2',
        description: 'echo test',
        cwd: deps.home,
      });
      await flushUntil(() => scheduler.list('c1')[0]?.status !== 'running');
      const out = scheduler.output('c1', rec.taskId);
      expect(out).toContain('hello-watch');
      expect(out).toContain('to-stderr');
    } finally {
      scheduler.dispose();
    }
  });
});

describe('WatchScheduler resident poll — completion delivered from OUTSIDE the watched process', () => {
  it('notices a real process exit and delivers a [watch]-prefixed completion into its chat', async () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      const rec = scheduler.start({
        chatId: 'c-complete',
        command: 'sleep 0.05',
        description: 'quick sleep',
        cwd: deps.home,
      });
      // The poll is resident on the scheduler, not inside the watched command's
      // own tree — nothing in this test calls `deliver` directly.
      await flushUntil(() => deps.delivered.length > 0);
      expect(deps.delivered[0]!.chatId).toBe('c-complete');
      expect(deps.delivered[0]!.message).toMatch(/^\[watch\]/);
      expect(deps.delivered[0]!.message).toMatch(/finished/);
      const after = scheduler.list('c-complete').find((r) => r.taskId === rec.taskId);
      expect(after?.status).toBe('exited');
      expect(after?.exitCode).toBe(0);
      expect(after?.endedAt).toBeDefined();
    } finally {
      scheduler.dispose();
    }
  });

  it('reports a nonzero exit as failed, not exited, and says so in the delivered message', async () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      scheduler.start({
        chatId: 'c-fail',
        command: 'exit 3',
        description: 'a failing command',
        cwd: deps.home,
      });
      await flushUntil(() => deps.delivered.length > 0);
      expect(deps.delivered[0]!.message).toMatch(/exit 3/);
      expect(scheduler.list('c-fail')[0]?.status).toBe('failed');
      expect(scheduler.list('c-fail')[0]?.exitCode).toBe(3);
    } finally {
      scheduler.dispose();
    }
  });
});

describe('WatchScheduler — survives a host restart', () => {
  it('a fresh scheduler re-attaches to a still-alive pid from disk with no live handle at all', async () => {
    const depsA = makeDeps();
    const schedulerA = mkScheduler(depsA);
    let rec;
    try {
      rec = schedulerA.start({
        chatId: 'c-restart',
        command: 'sleep 5',
        description: 'outlives the host',
        cwd: depsA.home,
      });
    } finally {
      // Simulate the host process dying: dispose the poll but leave the
      // child running (a real restart never gets to kill its children either).
      schedulerA.dispose();
    }

    // A brand-new scheduler, same dirs, holding NO live ChildProcess handle for
    // this task — exactly a fresh host's state after a restart.
    const depsB = makeDeps({
      home: depsA.home,
      dirForChat: depsA.dirForChat,
      allChatIds: () => ['c-restart'],
    });
    const schedulerB = mkScheduler(depsB);
    try {
      schedulerB.loadAll(); // logs only — nothing to arm, per the class comment
      expect(schedulerB.list('c-restart')[0]?.status).toBe('running');
      // Kill the process out from under B, the way the real one will end.
      process.kill(-rec.pid, 'SIGKILL');
      await flushUntil(() => depsB.delivered.length > 0);
      expect(depsB.delivered[0]!.message).toMatch(/^\[watch\]/);
      const after = schedulerB.list('c-restart')[0];
      // Re-attached via the bare-pid liveness probe, not a live handle: no exit
      // code/signal is knowable, which the record says honestly (null, not a
      // guessed number).
      expect(after?.status).toBe('exited');
      expect(after?.exitCode).toBeNull();
    } finally {
      schedulerB.dispose();
    }
  });
});

describe('WatchScheduler.stop', () => {
  it('kills the whole process group and marks the record stopped WITHOUT delivering', async () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      const rec = scheduler.start({
        chatId: 'c-stop',
        command: 'sleep 5',
        description: 'to be killed',
        cwd: deps.home,
      });
      const stopped = scheduler.stop('c-stop', rec.taskId);
      expect(stopped).toBe(true);
      expect(scheduler.list('c-stop')[0]?.status).toBe('stopped');
      // The caller already knows synchronously that it stopped the task — a
      // stop must not also announce a completion.
      await new Promise((r) => setTimeout(r, 80));
      expect(deps.delivered).toEqual([]);
    } finally {
      scheduler.dispose();
    }
  });

  it('is idempotent — stopping an already-ended task answers false, not an error', () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      const rec = scheduler.start({
        chatId: 'c-stop2',
        command: 'exit 0',
        description: 'short-lived',
        cwd: deps.home,
      });
      scheduler.stop('c-stop2', rec.taskId);
      expect(scheduler.stop('c-stop2', rec.taskId)).toBe(false);
    } finally {
      scheduler.dispose();
    }
  });

  it('answers false for a task id that was never started', () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      expect(scheduler.stop('c-nope', 'no-such-task')).toBe(false);
    } finally {
      scheduler.dispose();
    }
  });
});

describe('WatchScheduler.list / count', () => {
  it('scopes tasks per chat and is empty for a chat that never watched anything', () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      scheduler.start({ chatId: 'c-a', command: 'sleep 5', description: 'a', cwd: deps.home });
      expect(scheduler.list('c-a')).toHaveLength(1);
      expect(scheduler.list('c-b')).toEqual([]);
    } finally {
      scheduler.dispose();
    }
  });

  it('count() reflects only RUNNING tasks, immediately and after they end', async () => {
    const deps = makeDeps();
    const scheduler = mkScheduler(deps);
    try {
      scheduler.start({ chatId: 'c-count', command: 'sleep 5', description: 'a', cwd: deps.home });
      const rec2 = scheduler.start({
        chatId: 'c-count',
        command: 'sleep 0.05',
        description: 'b',
        cwd: deps.home,
      });
      expect(scheduler.count('c-count')).toBe(2);
      await flushUntil(
        () => scheduler.list('c-count').find((r) => r.taskId === rec2.taskId)?.status !== 'running',
      );
      expect(scheduler.count('c-count')).toBe(1);
    } finally {
      scheduler.dispose();
    }
  });
});
