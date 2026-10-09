// spec/08 § Action — `script`: a job that runs a command on a host instead of
// starting a chat. What matters here is that the fire goes out as an exec
// request, that its result settles the run, and that the run entry claims a chat
// only when the command SAID it started one (`SCRIPT_CHAT_MARKER`) — the server
// opens none itself, so there is otherwise nothing to claim.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });
const JOB_ID = 'j_00000000000000000000000099';

function scriptJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    name: 'photo tick',
    enabled: true,
    trigger: { type: 'cron', expression: '*/5 * * * *' },
    filter: null,
    action: {
      type: 'script',
      daemonId: 'd1',
      folder: '/work',
      command: 'scripts/tick.sh',
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function runs(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, 'runs', `${JOB_ID}.jsonl`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('script action', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-script-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires as a job.exec_request carrying the command and the default timeout', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fire1',
    });
    const result = disp.dispatch(scriptJob(), { firedAt: '2026-01-01' }, 'cron');
    expect(result.status).toBe('sent');
    const sent = link.sent.find((s) => s.event.type === 'job.exec_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'job.exec_request') {
      expect(sent.event.command).toBe('scripts/tick.sh');
      expect(sent.event.folder).toBe('/work');
      expect(sent.event.daemonId).toBe('d1');
      expect(sent.event.jobId).toBe(JOB_ID);
      expect(sent.event.timeoutMs).toBe(60_000);
    }
    // No chat is spawned anywhere in this path — that is the point of it.
    expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
    disp.close();
  });

  it('a result event settles the run with the exit code and output, and no chatId', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fire1',
    });
    disp.dispatch(scriptJob(), {}, 'cron');
    link.emit({
      type: 'job.exec_result',
      jobId: JOB_ID,
      fireId: 'fire1',
      ok: true,
      exitCode: 0,
      durationMs: 12,
      stdout: '0 new\n',
      stderr: '',
    });
    const entries = runs(dir);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { status: string; action: Record<string, unknown> };
    expect(entry.status).toBe('ok');
    expect(entry.action['type']).toBe('script');
    expect(entry.action['exitCode']).toBe(0);
    // Verbatim: the host already trimmed and capped the tail (see jobExec).
    expect(entry.action['output']).toBe('0 new\n');
    expect(entry.action['chatId']).toBeUndefined();
    disp.close();
  });

  it('a failing command is a dispatch-error carrying stderr, not a silent ok', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fire1',
    });
    disp.dispatch(scriptJob(), {}, 'cron');
    link.emit({
      type: 'job.exec_result',
      jobId: JOB_ID,
      fireId: 'fire1',
      ok: false,
      exitCode: 2,
      durationMs: 9,
      stdout: '',
      stderr: 'no watermark yet',
      error: 'command failed: Command failed',
    });
    const entry = runs(dir)[0] as {
      status: string;
      error: string;
      action: Record<string, unknown>;
    };
    expect(entry.status).toBe('dispatch-error');
    expect(entry.error).toContain('command failed');
    expect(entry.action['exitCode']).toBe(2);
    expect(entry.action['output']).toBe('no watermark yet');
    disp.close();
  });

  it('frees its concurrency slot on the result, so the next tick is not blocked', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: (() => {
        let n = 0;
        return () => `fire${++n}`;
      })(),
    });
    const job = scriptJob({ concurrency: 1 });
    disp.dispatch(job, {}, 'cron');
    expect(disp.counts(JOB_ID).inFlight).toBe(1);
    link.emit({
      type: 'job.exec_result',
      jobId: JOB_ID,
      fireId: 'fire1',
      ok: true,
      exitCode: 0,
      durationMs: 5,
      stdout: '',
      stderr: '',
    });
    expect(disp.counts(JOB_ID).inFlight).toBe(0);
    const second = disp.dispatch(job, {}, 'cron');
    expect(second.status).toBe('sent');
    disp.close();
  });

  // A gate that finds work spawns the chat itself through the CLI, so no
  // `chat.spawned` ever reaches the server and the job's own history had no
  // record of the fires that SPENT money — the expensive half of the job was
  // invisible from the job page. Printing the id is how the command says so.
  describe('the chat a gate announces on stdout', () => {
    function settle(stdout: string, ok = true): Record<string, unknown> {
      const link = new InProcessDaemonLink();
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fire1',
      });
      disp.dispatch(scriptJob(), {}, 'cron');
      link.emit({
        type: 'job.exec_result',
        jobId: JOB_ID,
        fireId: 'fire1',
        ok,
        exitCode: ok ? 0 : 1,
        durationMs: 12,
        stdout,
        stderr: '',
        ...(ok ? {} : { error: 'command failed' }),
      });
      disp.close();
      const entry = runs(dir)[0] as { action: Record<string, unknown> };
      return entry.action;
    }

    it('lands on the run entry so the row links into it', () => {
      const action = settle('4 waiting\npatch:chat 01M2ABCDEF\n4 new -> spawned\n');
      expect(action['chatId']).toBe('01M2ABCDEF');
      // The tail is kept whole — the marker is part of what the command said.
      expect(action['output']).toContain('patch:chat 01M2ABCDEF');
    });

    it('a fire that spawned and THEN failed still links its chat', () => {
      // The chat exists and is probably where the failure is explained, so the
      // link matters most here. Hence it is not gated on `ok`.
      const action = settle('patch:chat 01M2BROKE\nspawned, then fell over\n', false);
      expect(action['chatId']).toBe('01M2BROKE');
    });

    it('a held fire claims no chat', () => {
      const action = settle('not due (next wake in 420s) — holding\n');
      expect(action['chatId']).toBeUndefined();
    });
  });
});
