// Run window — spec/08 § Run window. A job with a window holds a fire that
// arrives outside it and releases it when the window opens: "arrives late at
// night, runs in the morning".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { inRunWindow, JobCreateBody, JobPatchBody, RunWindow } from '@patch/wire/jobs';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });
const JOB_ID = 'j_00000000000000000000000077';
const at = (h: number, m = 0, day = 7): number => Date.UTC(2026, 9, day, h, m);

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    name: 'night',
    enabled: true,
    trigger: { type: 'todoist' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    window: { start: '07:00', end: '09:00', timezone: 'UTC' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function spawns(link: InProcessDaemonLink): number {
  return link.sent.filter((s) => s.event.type === 'chat.spawn_request').length;
}

describe('inRunWindow', () => {
  const w = (start: string, end: string, timezone = 'UTC'): RunWindow => ({ start, end, timezone });
  it('start is inclusive, end exclusive', () => {
    expect(inRunWindow(w('07:00', '09:00'), at(7, 0))).toBe(true);
    expect(inRunWindow(w('07:00', '09:00'), at(8, 59))).toBe(true);
    expect(inRunWindow(w('07:00', '09:00'), at(9, 0))).toBe(false);
    expect(inRunWindow(w('07:00', '09:00'), at(6, 59))).toBe(false);
  });
  it('an end before the start wraps midnight', () => {
    const night = w('22:00', '06:00');
    expect(inRunWindow(night, at(23, 0))).toBe(true);
    expect(inRunWindow(night, at(5, 59))).toBe(true);
    expect(inRunWindow(night, at(6, 0))).toBe(false);
    expect(inRunWindow(night, at(12, 0))).toBe(false);
  });
  it('reads the wall clock in the window zone, DST included', () => {
    // 23:30 UTC on 7 Oct 2026 is 00:30 BST on the 8th.
    expect(inRunWindow(w('00:00', '01:00', 'Europe/London'), at(23, 30))).toBe(true);
    // 23:30 UTC in January is 23:30 GMT.
    expect(inRunWindow(w('00:00', '01:00', 'Europe/London'), Date.UTC(2027, 0, 7, 23, 30))).toBe(
      false,
    );
  });
});

describe('RunWindow schema', () => {
  it('refuses a bad time, a bad zone, and start === end', () => {
    expect(RunWindow.safeParse({ start: '7:00', end: '09:00', timezone: 'UTC' }).success).toBe(
      false,
    );
    expect(RunWindow.safeParse({ start: '07:00', end: '24:00', timezone: 'UTC' }).success).toBe(
      false,
    );
    expect(
      RunWindow.safeParse({ start: '07:00', end: '09:00', timezone: 'Mars/Base' }).success,
    ).toBe(false);
    expect(RunWindow.safeParse({ start: '07:00', end: '07:00', timezone: 'UTC' }).success).toBe(
      false,
    );
    expect(RunWindow.safeParse({ start: '07:00', end: '09:00' }).success).toBe(false);
  });
  it('is accepted on create, and null clears it on patch', () => {
    const window = { start: '07:00', end: '09:00', timezone: 'UTC' };
    const create = JobCreateBody.safeParse({
      name: 'x',
      trigger: { type: 'todoist' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/w', prompt: 'p' },
      window,
    });
    expect(create.success).toBe(true);
    expect(JobPatchBody.safeParse({ window: null }).success).toBe(true);
  });
});

describe('dispatcher run window', () => {
  let dir: string;
  let now: number;
  let link: InProcessDaemonLink;
  let stored: Map<string, Job>;
  let disp: JobDispatcher;
  const build = (): JobDispatcher =>
    new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
      nowMs: () => now,
      jobs: { expireOneOff: () => null, get: (id) => stored.get(id) ?? null },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-window-'));
    now = at(23);
    link = new InProcessDaemonLink();
    stored = new Map([[JOB_ID, makeJob()]]);
    disp = build();
  });
  afterEach(() => {
    disp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inside the window a fire goes straight out', () => {
    now = at(8);
    expect(disp.dispatch(makeJob(), {}, 'todoist').status).toBe('sent');
    expect(spawns(link)).toBe(1);
    expect(existsSync(join(dir, 'held'))).toBe(false);
  });

  it('outside the window a fire is held, then runs when the window opens', () => {
    expect(disp.dispatch(makeJob(), { n: 1 }, 'todoist').status).toBe('queued');
    expect(spawns(link)).toBe(0);
    expect(disp.heldCount(JOB_ID)).toBe(1);

    now = at(6, 59, 8);
    expect(disp.releaseHeld()).toEqual({ released: 0 });
    expect(spawns(link)).toBe(0);

    now = at(7, 0, 8);
    expect(disp.releaseHeld()).toEqual({ released: 1 });
    expect(spawns(link)).toBe(1);
    expect(disp.heldCount(JOB_ID)).toBe(0);
    expect(readdirSync(join(dir, 'held'))).toEqual([]);
  });

  it('releases held fires in arrival order', () => {
    disp.dispatch(makeJob(), { n: 1 }, 'todoist');
    now += 1000;
    disp.dispatch(makeJob(), { n: 2 }, 'todoist');
    now = at(7, 0, 8);
    disp.releaseHeld();
    const prompts = link.sent.map((s) => JSON.stringify(s.event));
    expect(prompts).toHaveLength(2);
  });

  it('a held fire survives a restart', () => {
    disp.dispatch(makeJob(), {}, 'todoist');
    disp.close();
    disp = build();
    expect(disp.heldCount(JOB_ID)).toBe(1);
    now = at(7, 30, 8);
    disp.releaseHeld();
    expect(spawns(link)).toBe(1);
  });

  it('a manual run ignores the window', () => {
    expect(disp.dispatch(makeJob(), {}, 'manual').status).toBe('sent');
    expect(spawns(link)).toBe(1);
  });

  it('a window removed while held releases on the next check', () => {
    disp.dispatch(makeJob(), {}, 'todoist');
    stored.set(JOB_ID, makeJob({ window: undefined }));
    disp.releaseHeld();
    expect(spawns(link)).toBe(1);
  });

  it('a job deleted or disabled while held drops its held fires, loudly', () => {
    disp.dispatch(makeJob(), {}, 'todoist');
    stored.delete(JOB_ID);
    now = at(7, 30, 8);
    expect(disp.releaseHeld()).toEqual({ released: 0 });
    expect(spawns(link)).toBe(0);
    expect(disp.heldCount(JOB_ID)).toBe(0);
  });

  it('holds a fire that has a gate too — the window comes first', () => {
    const job = makeJob({ gate: { command: 'true', daemonId: 'd1' } as Job['gate'] });
    expect(disp.dispatch(job, {}, 'todoist').status).toBe('queued');
    expect(link.sent).toHaveLength(0);
  });
});
