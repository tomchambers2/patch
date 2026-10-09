// spec/08 § Gate — the schema, and the rule that reads a gate's verdict.
//
// The verdict mapping is the load-bearing part. A gate is the thing standing
// between a watcher and spending money, so "I could not tell what it decided"
// must never resolve to either answer on its own.

import { describe, test, expect } from 'vitest';
import {
  GATE_DEFAULT_TIMEOUT_MS,
  Job,
  JobCreateBody,
  JobGate,
  JobPatchBody,
  gateVerdict,
} from '../src/jobs.js';

const GATE = { daemonId: 'd1', folder: '/work', command: 'exit 1' };

describe('JobGate', () => {
  test('needs a host, a folder and a command', () => {
    expect(JobGate.safeParse(GATE).success).toBe(true);
    for (const missing of ['daemonId', 'folder', 'command'] as const) {
      const partial: Record<string, unknown> = { ...GATE };
      delete partial[missing];
      expect(JobGate.safeParse(partial).success).toBe(false);
    }
  });

  test('is strict — a misspelled key fails the gate rather than being ignored', () => {
    expect(JobGate.safeParse({ ...GATE, timeout: 5000 }).success).toBe(false);
  });

  test('a timeout is bounded at both ends, and optional', () => {
    expect(JobGate.safeParse({ ...GATE, timeoutMs: 1000 }).success).toBe(true);
    expect(JobGate.safeParse({ ...GATE, timeoutMs: 600_000 }).success).toBe(true);
    expect(JobGate.safeParse({ ...GATE, timeoutMs: 999 }).success).toBe(false);
    expect(JobGate.safeParse({ ...GATE, timeoutMs: 600_001 }).success).toBe(false);
  });
});

describe('gate on a job', () => {
  const base = {
    id: 'j_1',
    name: 'watcher',
    enabled: true,
    trigger: { type: 'cron' as const, expression: '*/5 * * * *' },
    filter: null,
    action: { type: 'spawn' as const, daemonId: 'd1', folder: '/work', skill: 'foreman' },
    createdAt: 1,
    updatedAt: 1,
  };

  // Every job written before gates existed has no `gate` key at all, and `Job`
  // is strict and travels the daemon-link: absent has to stay legal forever.
  test('absent is legal — an ungated job is the normal job', () => {
    expect(Job.safeParse(base).success).toBe(true);
  });

  test('a gate parses, and so does an explicit null', () => {
    expect(Job.safeParse({ ...base, gate: GATE }).success).toBe(true);
    expect(Job.safeParse({ ...base, gate: null }).success).toBe(true);
  });

  // `null` is the only way a client can say "remove the gate": on a PATCH an
  // omitted key leaves the stored value alone, so an untick that omitted it
  // would silently not save.
  test('both write bodies take a gate, and take null to clear one', () => {
    const create = { name: 'w', trigger: base.trigger, action: base.action };
    expect(JobCreateBody.safeParse({ ...create, gate: GATE }).success).toBe(true);
    expect(JobCreateBody.safeParse({ ...create, gate: null }).success).toBe(true);
    expect(JobPatchBody.safeParse({ gate: GATE }).success).toBe(true);
    expect(JobPatchBody.safeParse({ gate: null }).success).toBe(true);
    expect(JobPatchBody.safeParse({}).success).toBe(true);
  });

  test('a malformed gate is refused on the way in, not stored and tripped over later', () => {
    expect(JobPatchBody.safeParse({ gate: { command: 'true' } }).success).toBe(false);
  });
});

describe('gateVerdict', () => {
  test('0 runs the action', () => {
    expect(gateVerdict(0, '')).toBe('run');
    expect(gateVerdict(0, 'due -> run\n')).toBe('run');
  });

  test('1 with a reason holds', () => {
    expect(gateVerdict(1, 'not due (next wake in 420s) — holding\n')).toBe('hold');
  });

  // The rule the whole mechanism rests on. 1 is also the code a half-written
  // gate dies with — curl that cannot connect, a failing `[ ]`, a traceback —
  // and a bare 1 reading as "all quiet" is how a gate that broke on Tuesday
  // becomes a quiet week. Accidents print to stderr or print nothing.
  test('1 with nothing to say is a FAULT, not a hold', () => {
    expect(gateVerdict(1, '')).toBe('fault');
    expect(gateVerdict(1, '   \n\n')).toBe('fault');
  });

  test('any other code is a fault', () => {
    for (const code of [2, 3, 7, 126, 127, 255]) {
      expect(gateVerdict(code, 'whatever it said')).toBe('fault');
    }
  });

  test('no code at all — killed, or never started — is a fault', () => {
    expect(gateVerdict(null, '')).toBe('fault');
    expect(gateVerdict(null, 'half a thought')).toBe('fault');
  });

  test('a gate is meant to be quick, so its default timeout is a minute', () => {
    expect(GATE_DEFAULT_TIMEOUT_MS).toBe(60_000);
  });
});
