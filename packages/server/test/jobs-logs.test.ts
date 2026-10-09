// Unit coverage for jobs/logs.ts — per-job runs.jsonl / webhooks.jsonl,
// jobId validation, and digestPayload. Most of this is exercised indirectly
// by cron/webhooks/todoist/routes tests already, but this file owns direct,
// exhaustive coverage of every branch (valid/invalid jobId, malformed lines,
// missing files, both string and object payload digesting).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JobLogs,
  InvalidJobIdError,
  assertValidJobId,
  digestPayload,
  JOB_ID_REGEX,
  JSONL_TAIL_WINDOW_BYTES,
  JsonlTailWindowError,
} from '../src/jobs/logs.js';

const VALID_ID = 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('JOB_ID_REGEX / assertValidJobId', () => {
  it('accepts a well-formed j_<ulid> id', () => {
    expect(JOB_ID_REGEX.test(VALID_ID)).toBe(true);
    expect(() => assertValidJobId(VALID_ID)).not.toThrow();
  });

  it('throws InvalidJobIdError on a malformed id', () => {
    expect(() => assertValidJobId('not-a-job-id')).toThrow(InvalidJobIdError);
    try {
      assertValidJobId('../../etc/passwd');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidJobIdError);
      expect((err as Error).message).toContain('invalid jobId format');
      expect((err as Error).name).toBe('InvalidJobIdError');
    }
  });
});

describe('digestPayload', () => {
  it('digests a string payload directly (no re-stringify)', () => {
    const a = digestPayload('hello');
    const b = digestPayload('hello');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('digests a non-string payload via JSON.stringify', () => {
    const a = digestPayload({ x: 1 });
    const b = digestPayload({ x: 1 });
    const c = digestPayload({ x: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('JobLogs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-joblogs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates runs/ and webhooks/ dirs on construction, and is idempotent on a second instance', () => {
    const logs = new JobLogs(dir);
    expect(existsSync(join(dir, 'runs'))).toBe(true);
    expect(existsSync(join(dir, 'webhooks'))).toBe(true);
    // Second construction over the same dataDir must not throw even though
    // the dirs already exist (the `!existsSync` guards).
    expect(() => new JobLogs(dir)).not.toThrow();
    void logs;
  });

  it('appendRun + readRuns round-trip, newest-first, respecting limit', () => {
    const logs = new JobLogs(dir);
    logs.appendRun({ ts: 1, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    logs.appendRun({ ts: 2, jobId: VALID_ID, status: 'filter-rejected', trigger: 'cron' });
    logs.appendRun({
      ts: 3,
      jobId: VALID_ID,
      status: 'dispatch-error',
      trigger: 'webhook',
      error: 'boom',
    });
    const all = logs.readRuns(VALID_ID);
    expect(all.map((r) => r.ts)).toEqual([3, 2, 1]);
    const limited = logs.readRuns(VALID_ID, 2);
    expect(limited.map((r) => r.ts)).toEqual([3, 2]);
  });

  it('appendWebhook + readWebhooks round-trip', () => {
    const logs = new JobLogs(dir);
    logs.appendWebhook({
      ts: 1,
      jobId: VALID_ID,
      signature: 'ok',
      scheme: 'github',
      filter: 'pass',
      status: 200,
    });
    logs.appendWebhook({
      ts: 2,
      jobId: VALID_ID,
      signature: 'fail',
      scheme: 'github',
      filter: 'n/a',
      status: 401,
      error: 'bad sig',
    });
    const all = logs.readWebhooks(VALID_ID);
    expect(all.map((w) => w.ts)).toEqual([2, 1]);
    expect(all[0]?.error).toBe('bad sig');
  });

  it('readRuns / readWebhooks return [] when the log file does not exist yet', () => {
    const logs = new JobLogs(dir);
    expect(logs.readRuns(VALID_ID)).toEqual([]);
    expect(logs.readWebhooks(VALID_ID)).toEqual([]);
  });

  it('skips malformed JSONL lines when reading (observability log, not transactional state)', () => {
    const logs = new JobLogs(dir);
    logs.appendRun({ ts: 1, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    // Inject a malformed raw line directly onto the runs file.
    appendFileSync(join(dir, 'runs', `${VALID_ID}.jsonl`), 'not valid json\n', 'utf8');
    logs.appendRun({ ts: 2, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    const runs = logs.readRuns(VALID_ID);
    // The malformed line is skipped; only the two well-formed entries remain.
    expect(runs.map((r) => r.ts)).toEqual([2, 1]);
  });

  it('appendRun / appendWebhook / readRuns / readWebhooks all reject a malformed jobId', () => {
    const logs = new JobLogs(dir);
    const bad = 'not-a-job-id';
    expect(() => logs.appendRun({ ts: 1, jobId: bad, status: 'ok', trigger: 'cron' })).toThrow(
      InvalidJobIdError,
    );
    expect(() =>
      logs.appendWebhook({
        ts: 1,
        jobId: bad,
        signature: 'ok',
        scheme: 'github',
        filter: 'pass',
        status: 200,
      }),
    ).toThrow(InvalidJobIdError);
    expect(() => logs.readRuns(bad)).toThrow(InvalidJobIdError);
    expect(() => logs.readWebhooks(bad)).toThrow(InvalidJobIdError);
  });
});

// readLatestRun reads only the TAIL of a job's runs.jsonl — the jobs list
// carries a last-fired per row, and slurping every job's whole history on
// every poll is what it exists to avoid.
describe('JobLogs.readLatestRun', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-joblatest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runsPath = () => join(dir, 'runs', `${VALID_ID}.jsonl`);

  it('returns null when the job has never fired (no file at all)', () => {
    const logs = new JobLogs(dir);
    expect(logs.readLatestRun(VALID_ID)).toBeNull();
  });

  it('returns null for an empty file', () => {
    const logs = new JobLogs(dir);
    writeFileSync(runsPath(), '', 'utf8');
    expect(logs.readLatestRun(VALID_ID)).toBeNull();
  });

  it('returns the only entry when the job has fired once', () => {
    const logs = new JobLogs(dir);
    logs.appendRun({ ts: 7, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    expect(logs.readLatestRun(VALID_ID)?.ts).toBe(7);
  });

  it('returns the LAST entry of many, carrying its status and chatId', () => {
    const logs = new JobLogs(dir);
    logs.appendRun({ ts: 1, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    logs.appendRun({ ts: 2, jobId: VALID_ID, status: 'gate-held', trigger: 'cron' });
    logs.appendRun({
      ts: 3,
      jobId: VALID_ID,
      status: 'ok',
      trigger: 'cron',
      action: { type: 'spawn', chatId: 'c_last' },
    });
    const latest = logs.readLatestRun(VALID_ID);
    expect(latest?.ts).toBe(3);
    expect(latest?.status).toBe('ok');
    expect(latest?.action?.chatId).toBe('c_last');
  });

  it('returns the true last entry of a file far larger than the read window', () => {
    const logs = new JobLogs(dir);
    // ~400KB of history, six times the 64KB window.
    const filler = 'x'.repeat(300);
    for (let i = 1; i <= 1200; i++) {
      logs.appendRun({ ts: i, jobId: VALID_ID, status: 'ok', trigger: 'cron', error: filler });
    }
    expect(statSync(runsPath()).size).toBeGreaterThan(JSONL_TAIL_WINDOW_BYTES * 4);
    expect(logs.readLatestRun(VALID_ID)?.ts).toBe(1200);
  });

  it('never reads past the window: valid history outside it is not reached', () => {
    // A real entry at the head of the file, then more than a window's worth of
    // unparseable bytes. A whole-file read would find the head entry; a
    // windowed read cannot, and must say so rather than report "never fired".
    const logs = new JobLogs(dir);
    logs.appendRun({ ts: 1, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    const garbage = `${'not json'.repeat(20)}\n`;
    for (let i = 0; i < 2000; i++) appendFileSync(runsPath(), garbage, 'utf8');
    expect(statSync(runsPath()).size).toBeGreaterThan(JSONL_TAIL_WINDOW_BYTES * 2);
    expect(() => logs.readLatestRun(VALID_ID)).toThrow(JsonlTailWindowError);
  });

  it('throws when the whole file is ONE line longer than the read window', () => {
    const logs = new JobLogs(dir);
    logs.appendRun({
      ts: 1,
      jobId: VALID_ID,
      status: 'ok',
      trigger: 'cron',
      error: 'y'.repeat(JSONL_TAIL_WINDOW_BYTES * 2),
    });
    try {
      logs.readLatestRun(VALID_ID);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JsonlTailWindowError);
      expect((err as Error).name).toBe('JsonlTailWindowError');
      expect((err as Error).message).toContain(`${JSONL_TAIL_WINDOW_BYTES} bytes`);
    }
  });

  it('walks back past a malformed trailing line to the last real entry', () => {
    const logs = new JobLogs(dir);
    logs.appendRun({ ts: 1, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    logs.appendRun({ ts: 2, jobId: VALID_ID, status: 'ok', trigger: 'cron' });
    // A torn append: the last line is not JSON.
    appendFileSync(runsPath(), '{"ts":3,"jobId":"j_\n', 'utf8');
    expect(logs.readLatestRun(VALID_ID)?.ts).toBe(2);
  });

  it('reads a file with no trailing newline', () => {
    const logs = new JobLogs(dir);
    writeFileSync(
      runsPath(),
      `{"ts":1,"jobId":"${VALID_ID}","status":"ok","trigger":"cron"}`,
      'utf8',
    );
    expect(logs.readLatestRun(VALID_ID)?.ts).toBe(1);
  });

  it('returns null for a small file holding nothing parseable at all', () => {
    const logs = new JobLogs(dir);
    writeFileSync(runsPath(), 'garbage\nmore garbage\n', 'utf8');
    expect(logs.readLatestRun(VALID_ID)).toBeNull();
  });

  it('rejects a malformed jobId', () => {
    const logs = new JobLogs(dir);
    expect(() => logs.readLatestRun('not-a-job-id')).toThrow(InvalidJobIdError);
  });
});
