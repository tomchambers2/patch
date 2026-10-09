// spec/08 § Gate — a shell command that decides whether a fire proceeds.
//
// `filter` asks a question of the trigger's payload; a gate asks one of the
// world. It replaced a `script` action that both decided AND spawned (shelling
// out to `patch chats spawn`), which meant none of the job's own machinery
// reached the chat it made: no `chat.spawned`, so no chat on the run row, no
// concurrency slot, no `startArchived`. A gate gives the decision to the script
// and the work back to the job.
//
// What matters here: the gate runs FIRST and alone; `run` dispatches the real
// action; `hold` and `fault` are different statuses; and a gate that cannot be
// read is never guessed in either direction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '../src/jobs/types.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });
const JOB_ID = 'j_00000000000000000000000077';

/** A watcher shaped like foreman: a gate decides, a spawn does the work. */
function gatedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    name: 'Foreman',
    enabled: true,
    trigger: { type: 'cron', expression: '*/15 * * * *' },
    filter: null,
    gate: {
      daemonId: 'd1',
      folder: '/work',
      command: 'set -euo pipefail\necho "not due — holding"\nexit 1',
    },
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', skill: 'foreman' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function runs(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, 'runs', `${JOB_ID}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('job gate', () => {
  let dir: string;
  let link: InProcessDaemonLink;
  let disp: JobDispatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-gate-'));
    link = new InProcessDaemonLink();
    let n = 0;
    disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      // Distinct ids so the gate's fire and the chat the action spawns cannot be
      // confused for one another.
      idGenerator: () => `id${++n}`,
    });
  });

  afterEach(() => {
    disp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Answer the gate's outstanding command. */
  function answer(opts: { exitCode: number | null; stdout?: string; stderr?: string }): void {
    const sent = link.sent.find((s) => s.event.type === 'job.exec_request');
    if (!sent || sent.event.type !== 'job.exec_request') throw new Error('no gate fire was sent');
    link.emit({
      type: 'job.exec_result',
      jobId: JOB_ID,
      fireId: sent.event.fireId,
      ok: opts.exitCode === 0,
      exitCode: opts.exitCode,
      durationMs: 12,
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      ...(opts.exitCode === 0 ? {} : { error: `command exited ${String(opts.exitCode)}` }),
    });
  }

  it('asks the gate before anything else, and spawns nothing until it answers', () => {
    const result = disp.dispatch(gatedJob(), { firedAt: 'now' }, 'cron');
    // `gating`, not `sent`: nothing has been sent anywhere yet.
    expect(result.status).toBe('gating');
    const exec = link.sent.find((s) => s.event.type === 'job.exec_request');
    expect(exec).toBeDefined();
    if (exec && exec.event.type === 'job.exec_request') {
      expect(exec.event.command).toContain('not due');
      expect(exec.event.folder).toBe('/work');
      expect(exec.event.timeoutMs).toBe(60_000);
    }
    // The expensive half has not happened, and — the point of the whole
    // mechanism — nothing is left behind by a fire that may never run.
    expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
    expect(runs(dir)).toHaveLength(0);
  });

  it('exit 0 runs the action, and the gate’s words land on that ONE row', () => {
    disp.dispatch(gatedJob(), {}, 'cron');
    answer({ exitCode: 0, stdout: 'due (desktop 40s ago) -> run\n' });

    const spawn = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(spawn).toBeDefined();
    // Still nothing written: the fire settles when the host confirms the chat,
    // exactly as an ungated one does.
    expect(runs(dir)).toHaveLength(0);
    if (spawn && spawn.event.type === 'chat.spawn_request') {
      link.emit({
        type: 'chat.spawned',
        chatId: spawn.event.chatId,
        folder: '/work',
        daemonId: 'd1',
      });
    }
    const entries = runs(dir);
    // ONE row for one fire — the gate does not write a second.
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { status: string; action: Record<string, unknown> };
    expect(entry.status).toBe('ok');
    // And it carries a real chat, which is what the old spawn-it-yourself script
    // could never give the row. Third id out of the generator: the gate's fire,
    // then the action's fire, then the chat.
    expect(entry.action['chatId']).toBe('id3');
    expect(entry.action['output']).toBe('due (desktop 40s ago) -> run\n');
  });

  it('exit 1 with a reason is a hold: no action, and the reason is the record', () => {
    disp.dispatch(gatedJob(), {}, 'cron');
    answer({ exitCode: 1, stdout: 'not due (next wake in 420s) — holding\n' });

    expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
    const entry = runs(dir)[0] as {
      status: string;
      error?: string;
      action: Record<string, unknown>;
    };
    expect(entry.status).toBe('gate-held');
    expect(entry.action['exitCode']).toBe(1);
    expect(entry.action['output']).toContain('not due (next wake in 420s)');
    // A hold is the gate WORKING. Nothing about it is an error.
    expect(entry.error).toBeUndefined();
  });

  // The rule the whole mechanism rests on. 1 is also the code a half-written
  // gate dies with — curl that cannot connect, a failing `[ ]`, a traceback —
  // so a bare 1 must not read as "all quiet". Accidents print to stderr or
  // print nothing; deliberate holds print their reason.
  it('exit 1 with NOTHING to say is a fault, not a hold', () => {
    disp.dispatch(gatedJob(), {}, 'cron');
    answer({ exitCode: 1, stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 3422\n' });

    const entry = runs(dir)[0] as {
      status: string;
      error: string;
      action: Record<string, unknown>;
    };
    expect(entry.status).toBe('gate-error');
    expect(entry.error).toContain('printed no reason');
    // The stderr that explains it is kept, even though it is not a verdict.
    expect(entry.action['output']).toContain('Failed to connect');
    expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
  });

  it('any other exit code is a fault', () => {
    disp.dispatch(gatedJob(), {}, 'cron');
    answer({ exitCode: 2, stdout: 'observer unreachable\n' });
    const entry = runs(dir)[0] as { status: string; action: Record<string, unknown> };
    expect(entry.status).toBe('gate-error');
    expect(entry.action['exitCode']).toBe(2);
  });

  it('a killed gate is a fault — it never answered', () => {
    disp.dispatch(gatedJob(), {}, 'cron');
    // No exit code at all is what the host reports for a command it had to
    // kill on its timeout.
    answer({ exitCode: null, stdout: 'still deciding' });
    const entry = runs(dir)[0] as { status: string; error: string };
    expect(entry.status).toBe('gate-error');
    expect(entry.error).toBeTruthy();
  });

  it('an offline gate host is a fault, never a silent hold and never a run', () => {
    const offline = new InProcessDaemonLink();
    const d = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: offline,
      logger: silentLogger,
      idGenerator: () => 'id1',
      // A host the link has never heard of is offline.
    });
    const result = d.dispatch(
      gatedJob({ gate: { daemonId: 'ghost', folder: '/work', command: 'true' } }),
      {},
      'cron',
    );
    expect(result.status).toBe('rejected');
    const entry = runs(dir)[0] as { status: string; error: string };
    expect(entry.status).toBe('gate-error');
    expect(entry.error).toContain('ghost');
    expect(entry.error).toContain('offline');
    expect(offline.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(false);
    d.close();
  });

  it('a gate composes with a `continue` action, not just `spawn`', () => {
    // The reason a gate is a sibling of `filter` rather than part of the action:
    // it has to work for all of them.
    disp.dispatch(
      gatedJob({ action: { type: 'continue', daemonId: 'd1', folder: '/work', skill: 'foreman' } }),
      {},
      'cron',
    );
    answer({ exitCode: 0, stdout: 'due -> run\n' });
    const spawned = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(spawned).toBeDefined();
    if (spawned && spawned.event.type === 'chat.spawn_request') {
      // `continue` owns one durable chat with a deterministic id.
      expect(spawned.event.chatId).toBe(`jobchat-${JOB_ID}`);
    }
  });

  it('an ungated job is untouched — no gate fire, straight to the action', () => {
    const job = gatedJob();
    delete job.gate;
    const result = disp.dispatch(job, {}, 'cron');
    expect(result.status).toBe('sent');
    expect(link.sent.some((s) => s.event.type === 'job.exec_request')).toBe(false);
    expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(true);
  });

  // spec/08 § A passing gate's stdout is the action's input. The gate has
  // already looked at the world; handing what it found to the agent is what
  // stops the model paying to rediscover it.
  describe("the gate's stdout is the action's input", () => {
    /** The prompt the host was actually asked to open the chat with. */
    function spawnedPrompt(): string {
      const spawn = link.sent.find((s) => s.event.type === 'chat.spawn_request');
      if (!spawn || spawn.event.type !== 'chat.spawn_request') throw new Error('nothing spawned');
      return spawn.event.prompt ?? '';
    }

    it('renders {{gate.stdout}} and {{gate.verdict}} beside the trigger payload', () => {
      const job = gatedJob({
        action: {
          type: 'spawn',
          daemonId: 'd1',
          folder: '/work',
          prompt: 'At {{payload.firedAt}} the gate said:\n{{gate.stdout}}\n---\n{{gate.verdict}}',
        },
      });
      disp.dispatch(job, { payload: { firedAt: '2026-09-13T08:00:00Z' } }, 'cron');
      answer({
        exitCode: 0,
        stdout: '11 new since 07:12\nScrewfix £61.40 is over its threshold\n',
      });

      const prompt = spawnedPrompt();
      expect(prompt).toContain('At 2026-09-13T08:00:00Z');
      expect(prompt).toContain('11 new since 07:12');
      // The verdict is the LAST line, the same convention the run row headlines
      // by — so a gate gets a summary field for free without a second channel.
      expect(prompt).toContain('---\nScrewfix £61.40 is over its threshold');
    });

    it('feeds stdout only — a gate’s accidents go to stderr and stay there', () => {
      const job = gatedJob({
        action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: '[{{gate.stdout}}]' },
      });
      disp.dispatch(job, {}, 'cron');
      answer({
        exitCode: 0,
        stdout: 'there is work\n',
        stderr: 'Traceback (most recent call last): KeyError: totals',
      });
      // A traceback read as a briefing is worse than no briefing: it is a
      // confidently wrong agent.
      expect(spawnedPrompt()).toContain(`${DEFAULT_JOB_AUTONOMY_PROMPT}\n\n[there is work]`);
    });

    it('a skill-only action is handed the gate inside its JSON, with no template written', () => {
      disp.dispatch(gatedJob(), { payload: { firedAt: 'now' } }, 'cron');
      answer({ exitCode: 0, stdout: 'due (desktop 40s ago) — starting the coach\n' });

      const prompt = spawnedPrompt();
      expect(prompt.startsWith('/foreman')).toBe(true);
      const body = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
        payload: { firedAt: string };
        gate: { stdout: string; verdict: string };
      };
      expect(body.payload.firedAt).toBe('now');
      expect(body.gate.verdict).toBe('due (desktop 40s ago) — starting the coach');
    });

    it('an UNGATED job’s view gains nothing — no empty gate to read as a real one', () => {
      const job = gatedJob();
      delete job.gate;
      disp.dispatch(job, { payload: { firedAt: 'now' } }, 'cron');
      const prompt = spawnedPrompt();
      const body = JSON.parse(prompt.slice(prompt.indexOf('{'))) as Record<string, unknown>;
      // Not `gate: {stdout: ''}`: a job with no gate must serialise exactly as
      // it did before gates could speak, or every ungated skill job silently
      // changes shape.
      expect('gate' in body).toBe(false);
    });
  });

  it('a held fire leaves no slot held, so the limit is not consumed by holding', () => {
    // A gate runs before the concurrency machinery and takes nothing from it:
    // holding 287 times a day must not look like a job that is busy.
    disp.dispatch(gatedJob({ concurrency: 1 }), {}, 'cron');
    answer({ exitCode: 1, stdout: 'holding\n' });
    expect(disp.queue(JOB_ID).inFlight).toHaveLength(0);
    expect(disp.queue(JOB_ID).queued).toHaveLength(0);
  });
});
