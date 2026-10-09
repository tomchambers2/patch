// spec/02 § Background task completions — what a running background task is
// costing the machine, for the surface's background task bar.
//
// There is no pid anywhere in the wire protocol or the host's own state, so
// the task's output file is the handle: every process in a backgrounded
// command's tree inherits it as both stdout and stderr, so whoever holds it
// open IS the task. These prove the three steps of that (resolve the file,
// find its holders, price them) and the one rule that governs the whole
// module: a task the host could not measure is ABSENT from the answer, never
// reported as zero.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import {
  resolveTaskOutputFiles,
  parseLsof,
  parsePs,
  measureBackgroundTasks,
  handleBackgroundTaskStatsRequest,
  defaultStatsProbeDeps,
  type StatsProbeDeps,
} from '../src/backgroundTaskStats.js';

const silent = pino({ level: 'silent' });

/** A tasks tree in the shape the agent layer lays down. */
function fixture(tasks: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'patch-bgstats-'));
  for (const [session, ids] of Object.entries(tasks)) {
    const dir = join(root, 'claude-1000', '-home-tom-projects-x', session, 'tasks');
    mkdirSync(dir, { recursive: true });
    for (const id of ids) writeFileSync(join(dir, `${id}.output`), '');
  }
  return root;
}

function fakeRun(byBin: Record<string, string>): StatsProbeDeps['run'] {
  return (bin) => Promise.resolve({ stdout: byBin[bin] ?? '', failed: false });
}

describe('resolveTaskOutputFiles', () => {
  it('finds a task output file without knowing its project or session', () => {
    const root = fixture({ '9a1710c0': ['baiw888mq'] });
    const found = resolveTaskOutputFiles(['baiw888mq'], root);
    expect(found.get('baiw888mq')).toEqual([
      join(root, 'claude-1000', '-home-tom-projects-x', '9a1710c0', 'tasks', 'baiw888mq.output'),
    ]);
  });

  it('omits an id with no file — there is nothing to measure, and nothing is invented', () => {
    const root = fixture({ '9a1710c0': ['baiw888mq'] });
    const found = resolveTaskOutputFiles(['baiw888mq', 'bnothing'], root);
    expect(found.has('bnothing')).toBe(false);
    expect(found.size).toBe(1);
  });

  it('collects the same id from every session that has one', () => {
    const root = fixture({ '9a1710c0': ['baiw888mq'], '4685c749': ['baiw888mq'] });
    expect(resolveTaskOutputFiles(['baiw888mq'], root).get('baiw888mq')).toHaveLength(2);
  });

  it('drops an id that is not a bare token rather than escaping it into a path', () => {
    const root = fixture({ '9a1710c0': ['baiw888mq'] });
    const found = resolveTaskOutputFiles(['../../../etc/passwd', 'a b', ''], root);
    expect(found.size).toBe(0);
  });

  it('is empty, not a throw, when the tasks root does not exist at all', () => {
    expect(resolveTaskOutputFiles(['baiw888mq'], join(tmpdir(), 'no-such-root-xyz')).size).toBe(0);
  });
});

describe('parseLsof', () => {
  // Captured verbatim from `lsof -F pn -- <output file>` against a real
  // backgrounded command: one pid line, then one name line per descriptor,
  // because the process holds the file as BOTH stdout and stderr.
  const REAL = 'p3003560\nn/tmp/probe.output\nn/tmp/probe.output\n';

  it('reads pid → path, counting a process that holds the file twice once', () => {
    const byPath = parseLsof(REAL);
    expect([...(byPath.get('/tmp/probe.output') ?? [])]).toEqual([3003560]);
  });

  it('attributes each path to every pid holding it', () => {
    const out = parseLsof(
      'p100\nn/tmp/a.output\nn/tmp/a.output\np101\nn/tmp/a.output\np102\nn/tmp/b.output\n',
    );
    expect([...(out.get('/tmp/a.output') ?? [])].sort()).toEqual([100, 101]);
    expect([...(out.get('/tmp/b.output') ?? [])]).toEqual([102]);
  });

  it('ignores a name line before any pid, and a malformed pid', () => {
    expect(parseLsof('n/tmp/orphan.output\npnotanumber\nn/tmp/x.output\n').size).toBe(0);
  });
});

describe('parsePs', () => {
  it('reads the headerless three-column form both hosts emit', () => {
    // Real `ps -o pid=,%cpu=,rss=` output: right-aligned pid, rss in KiB.
    const table = parsePs('      1  0.0  8740\n3003560 12.5 348320\n');
    expect(table.get(1)).toEqual({ cpu: 0, rssBytes: 8740 * 1024 });
    expect(table.get(3003560)).toEqual({ cpu: 12.5, rssBytes: 348320 * 1024 });
  });

  it('skips anything that is not a row — a pid that died has none', () => {
    expect(parsePs('\nsome warning\n  2 1.0 100\n').size).toBe(1);
  });
});

describe('measureBackgroundTasks', () => {
  it('sums the whole process tree of a task, over distinct pids', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const file = join(
      root,
      'claude-1000',
      '-home-tom-projects-x',
      's1',
      'tasks',
      'baiw888mq.output',
    );
    const stats = await measureBackgroundTasks(['baiw888mq'], {
      tasksRoot: root,
      // The wrapper holds the file as stdout AND stderr, so it appears twice.
      run: fakeRun({
        lsof: `p100\nn${file}\nn${file}\np101\nn${file}\n`,
        ps: '100 10.0 100000\n101 88.5 250000\n',
      }),
    });
    expect(stats).toEqual([
      { taskId: 'baiw888mq', cpuPercent: 98.5, rssBytes: 350000 * 1024, processes: 2 },
    ]);
  });

  it('omits a task whose file no process holds — a finished command, not a zero', async () => {
    const root = fixture({ s1: ['bdead0001'] });
    const stats = await measureBackgroundTasks(['bdead0001'], {
      tasksRoot: root,
      run: fakeRun({ lsof: '', ps: '' }),
    });
    expect(stats).toEqual([]);
  });

  it('omits a backgrounded sub-agent, which has no process of its own', async () => {
    // Its `.output` exists (it links the sub-agent's transcript) but nothing
    // holds it open. Reporting it as `0% · 0 B` would claim it costs nothing.
    const root = fixture({ s1: ['bkvn61the', 'baiw888mq'] });
    const file = join(
      root,
      'claude-1000',
      '-home-tom-projects-x',
      's1',
      'tasks',
      'baiw888mq.output',
    );
    const stats = await measureBackgroundTasks(['bkvn61the', 'baiw888mq'], {
      tasksRoot: root,
      run: fakeRun({ lsof: `p100\nn${file}\n`, ps: '100 5.0 1024\n' }),
    });
    expect(stats.map((s) => s.taskId)).toEqual(['baiw888mq']);
  });

  it('omits a task whose pid died between the lsof and the ps', async () => {
    const root = fixture({ s1: ['braced001'] });
    const file = join(
      root,
      'claude-1000',
      '-home-tom-projects-x',
      's1',
      'tasks',
      'braced001.output',
    );
    const stats = await measureBackgroundTasks(['braced001'], {
      tasksRoot: root,
      run: fakeRun({ lsof: `p100\nn${file}\n`, ps: '' }),
    });
    expect(stats).toEqual([]);
  });

  it('does not scan the process table at all when no id resolves to a file', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const bins: string[] = [];
    const stats = await measureBackgroundTasks(['bnothing'], {
      tasksRoot: root,
      run: (bin) => {
        bins.push(bin);
        return Promise.resolve({ stdout: '', failed: false });
      },
    });
    expect(stats).toEqual([]);
    expect(bins).toEqual([]);
  });

  it('throws when the host has no process table to read', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const enoent = Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
    await expect(
      measureBackgroundTasks(['baiw888mq'], {
        tasksRoot: root,
        run: () => Promise.reject(enoent),
      }),
    ).rejects.toThrow('ENOENT');
  });
});

describe('handleBackgroundTaskStatsRequest', () => {
  const request = {
    type: 'patch.background_task_stats.request' as const,
    requestId: 'r1',
    chatId: 'c1',
    taskIds: ['baiw888mq'],
  };

  it('answers with the measured tasks', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const file = join(
      root,
      'claude-1000',
      '-home-tom-projects-x',
      's1',
      'tasks',
      'baiw888mq.output',
    );
    const sent: WireEvent[] = [];
    await handleBackgroundTaskStatsRequest(
      request,
      () => true,
      (e) => sent.push(e),
      silent,
      {
        tasksRoot: root,
        run: fakeRun({ lsof: `p100\nn${file}\n`, ps: '100 42.0 204800\n' }),
      },
    );
    expect(sent).toEqual([
      {
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: true,
        stats: [{ taskId: 'baiw888mq', cpuPercent: 42, rssBytes: 204800 * 1024, processes: 1 }],
      },
    ]);
  });

  it('refuses a chat this host does not have', async () => {
    const sent: WireEvent[] = [];
    await handleBackgroundTaskStatsRequest(
      request,
      () => false,
      (e) => sent.push(e),
      silent,
      {
        tasksRoot: fixture({}),
        run: fakeRun({}),
      },
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
  });

  it('reports a host with no process table distinctly from an empty measurement', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const sent: WireEvent[] = [];
    await handleBackgroundTaskStatsRequest(
      request,
      () => true,
      (e) => sent.push(e),
      silent,
      {
        tasksRoot: root,
        run: () =>
          Promise.reject(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' })),
      },
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'no_process_table' } });
  });

  it('reports any other failure as internal', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const sent: WireEvent[] = [];
    await handleBackgroundTaskStatsRequest(
      request,
      () => true,
      (e) => sent.push(e),
      silent,
      {
        tasksRoot: root,
        run: () => Promise.reject(new Error('boom')),
      },
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal', message: 'boom' } });
  });

  it('answers ok with no stats when nothing could be measured', async () => {
    const root = fixture({ s1: ['baiw888mq'] });
    const sent: WireEvent[] = [];
    await handleBackgroundTaskStatsRequest(
      request,
      () => true,
      (e) => sent.push(e),
      silent,
      {
        tasksRoot: root,
        run: fakeRun({ lsof: '', ps: '' }),
      },
    );
    expect(sent[0]).toEqual({
      type: 'patch.background_task_stats.response',
      requestId: 'r1',
      ok: true,
      stats: [],
    });
  });
});

// The parsers above are fed captured output; this one runs the REAL `lsof` and
// `ps` this host ships, against a process this test started and a file it
// created, so a change in either tool's output shape fails here rather than in
// production. It is the same code path the host runs.
describe('measureBackgroundTasks against the real process table', () => {
  it('prices a live process that holds a task output file as its stdout', async () => {
    const root = fixture({ s1: ['breal0001'] });
    const file = join(
      root,
      'claude-1000',
      '-home-tom-projects-x',
      's1',
      'tasks',
      'breal0001.output',
    );
    const fd = openSync(file, 'a');
    // Exactly what the agent layer does: the child inherits the output file as
    // both its stdout and its stderr, which is what makes it findable.
    const child = spawn('sleep', ['30'], { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    try {
      const stats = await measureBackgroundTasks(['breal0001'], {
        ...defaultStatsProbeDeps,
        tasksRoot: root,
      });
      expect(stats).toHaveLength(1);
      expect(stats[0]!.taskId).toBe('breal0001');
      expect(stats[0]!.processes).toBeGreaterThanOrEqual(1);
      expect(stats[0]!.rssBytes).toBeGreaterThan(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);

  it('reports nothing for a task file no live process holds', async () => {
    const root = fixture({ s1: ['bstale001'] });
    expect(
      await measureBackgroundTasks(['bstale001'], { ...defaultStatsProbeDeps, tasksRoot: root }),
    ).toEqual([]);
  }, 20_000);
});
