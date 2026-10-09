// Per-job logs.
//
//   <dataDir>/runs/<jobId>.jsonl       — every fire (success/failure)
//   <dataDir>/webhooks/<jobId>.jsonl   — every inbound webhook (sig/filter)
//
// Atomic-ish appends: we open with `appendFileSync` which calls write(2)
// once with O_APPEND semantics. For small JSONL lines (<4KiB) this is
// atomic on POSIX. We don't fsync each line — runs.jsonl is observability,
// not transactional state. The job DEFINITION (which is transactional) is
// fsync'd in store.ts.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { JobRunStatus } from '@patch/wire/jobs';

/**
 * Canonical jobId format. JobStore.create generates `j_<ulid>` (Crockford
 * base32 ULID, 26 chars). We assert this on every leaf-level filesystem
 * touch so a path-traversal jobId can NEVER write outside the dataDir.
 *
 * NO FALLBACK: validators throw `InvalidJobIdError` rather than silently
 * coercing.
 */
export const JOB_ID_REGEX = /^j_[0-9A-HJKMNP-TV-Z]{26}$/;

export class InvalidJobIdError extends Error {
  constructor(jobId: string) {
    super(`invalid jobId format: ${jobId}`);
    this.name = 'InvalidJobIdError';
  }
}

export function assertValidJobId(jobId: string): void {
  if (!JOB_ID_REGEX.test(jobId)) throw new InvalidJobIdError(jobId);
}

/**
 * How many bytes off the end of a .jsonl are read to find its last entry.
 * Every real run entry is a few hundred bytes and the largest ever written is
 * ~4.5KB, so this window holds the last line many times over.
 */
export const JSONL_TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * The tail window held no complete line — the file's last entry is longer than
 * the window. NO FALLBACK: reporting "never fired" for a job that has fired,
 * or silently widening the read to slurp a pathological file, both hide this.
 */
export class JsonlTailWindowError extends Error {
  constructor(path: string, windowBytes: number) {
    super(`no complete JSONL line in the last ${windowBytes} bytes of ${path}`);
    this.name = 'JsonlTailWindowError';
  }
}

export interface RunLogEntry {
  ts: number;
  jobId: string;
  /**
   * `chat-error` is written AFTER an `ok`, for the same fire: the spawn landed
   * (so the job did its part) but the chat it created then failed. Without it
   * a job whose every chat dies on its first turn reads as an unbroken run of
   * successes - which is exactly how nine app-update fires were lost to a
   * usage limit on 2026-08-26 without anything noticing for two days.
   *
   * `queued` / `slot-timeout` belong to the concurrency gate (spec/08 §
   * Concurrency). A fire held behind the limit is recorded twice — `queued`
   * when it queues and its real outcome when it finally dispatches — so a
   * job's history shows the wait rather than an unexplained gap. The
   * concurrency queue is unbounded: a fire waits, it is never refused.
   *
   * `gate-held` / `gate-error` belong to the job's GATE (spec/08 § Gate) and are
   * the two ways a gate stops a fire. They are deliberately different statuses,
   * because they are different facts and only one of them is news: `gate-held`
   * is the gate working — most fires of a watcher are held, and the row carries
   * the reason it gave. `gate-error` is the gate BROKEN, and has to stand out
   * from the hundreds of holds around it, because a gate that silently stopped
   * deciding looks exactly like a quiet week. A fire the gate let through writes
   * no row of its own — it writes the ordinary one its action produces, carrying
   * the gate's reason as that row's output, so one fire stays one row.
   */
  status: JobRunStatus;
  trigger: 'cron' | 'webhook' | 'todoist' | 'recurrence' | 'manual';
  payloadDigest?: string;
  error?: string;
  /**
   * Where the fire went. `chatId` is present only once the host has confirmed
   * a chat (spec/08 ## Execution model step 6) — a fire that never landed must
   * not carry one. `daemonId` names the host on every folder-addressed fire,
   * so `dispatch-error` / `buffered` say WHICH machine (spec/08 ## Logs).
   */
  action?: {
    type: 'spawn' | 'message' | 'continue' | 'script';
    chatId?: string;
    daemonId?: string;
    folder?: string;
    /**
     * A command's exit code and output tail, from the two places a job runs one:
     * a `script` ACTION (spec/08 § Action), which has no chat to open and read,
     * so its runs ARE its record; and a GATE (spec/08 § Gate), where they are
     * the verdict and its reason. Absent otherwise — except `output`, which a
     * gated fire that RAN also carries, holding what its gate said.
     */
    exitCode?: number | null;
    output?: string;
  };
}

export interface WebhookLogEntry {
  ts: number;
  jobId: string;
  signature: 'ok' | 'fail' | 'none';
  /**
   * The verification scheme. Generic webhooks carry their HMAC scheme; the
   * first-class Todoist (`todoist`) ingress path carries its own pseudo-scheme
   * so the firehose log distinguishes the source.
   * Spec/08 line 154: webhooks.jsonl logs every webhook/todoist hit.
   */
  scheme: 'none' | 'hmac-sha256' | 'github' | 'stripe' | 'todoist';
  filter: 'pass' | 'reject' | 'error' | 'n/a';
  status: number;
  error?: string;
}

/** `status` values that are a genuine failure — a job that stopped producing,
 * not an expected non-fire (spec/06 § Sweep — "a job run failed" is one of
 * the gate's changed conditions; `filter-rejected`/`buffered`/`queued`/
 * `slot-timeout`/`gate-held` are all the job declining to fire, not failing). */
const FAILURE_STATUSES: ReadonlySet<JobRunStatus> = new Set([
  'filter-error',
  'dispatch-error',
  'chat-error',
  'gate-error',
]);

export function isJobRunFailure(status: JobRunStatus): boolean {
  return FAILURE_STATUSES.has(status);
}

export class JobLogs {
  private readonly runsDir: string;
  private readonly webhooksDir: string;
  private readonly onRun: ((entry: RunLogEntry) => void) | undefined;

  constructor(dataDir: string, opts: { onRun?: (entry: RunLogEntry) => void } = {}) {
    this.runsDir = join(dataDir, 'runs');
    this.webhooksDir = join(dataDir, 'webhooks');
    this.onRun = opts.onRun;
    if (!existsSync(this.runsDir)) mkdirSync(this.runsDir, { recursive: true });
    if (!existsSync(this.webhooksDir)) mkdirSync(this.webhooksDir, { recursive: true });
  }

  appendRun(entry: RunLogEntry): void {
    assertValidJobId(entry.jobId);
    const path = join(this.runsDir, `${entry.jobId}.jsonl`);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    // spec/06 § Sweep — a job failure both changes the gate AND wakes a
    // sweep early. Fired after the write, so a listener that reads the log
    // back never races the append.
    this.onRun?.(entry);
  }

  appendWebhook(entry: WebhookLogEntry): void {
    assertValidJobId(entry.jobId);
    const path = join(this.webhooksDir, `${entry.jobId}.jsonl`);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /**
   * Read the last `limit` lines of a job's runs.jsonl. Returns newest-first.
   * Throws InvalidJobIdError on malformed jobId (NO FALLBACK).
   */
  readRuns(jobId: string, limit = 50): RunLogEntry[] {
    assertValidJobId(jobId);
    return readJsonlTail<RunLogEntry>(join(this.runsDir, `${jobId}.jsonl`), limit);
  }

  /**
   * The most recent run of a job, or null if it has never fired. Reads only the
   * tail of runs.jsonl rather than the whole file, so the jobs list can carry a
   * last-fired per row without re-reading megabytes of history every poll.
   * Throws InvalidJobIdError on a malformed jobId, and JsonlTailWindowError if
   * the last entry does not fit the read window (NO FALLBACK).
   */
  readLatestRun(jobId: string): RunLogEntry | null {
    assertValidJobId(jobId);
    return readJsonlLastEntry<RunLogEntry>(join(this.runsDir, `${jobId}.jsonl`));
  }

  readWebhooks(jobId: string, limit = 50): WebhookLogEntry[] {
    assertValidJobId(jobId);
    return readJsonlTail<WebhookLogEntry>(join(this.webhooksDir, `${jobId}.jsonl`), limit);
  }
}

export function digestPayload(payload: unknown): string {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function readJsonlTail<T>(path: string, limit: number): T[] {
  if (!existsSync(path)) return [];
  // Synchronous read is fine: runs.jsonl is bounded by per-job append cadence
  // and these endpoints are JWT-authed + rate-limited (max 50/200 lines).
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(Math.max(0, lines.length - limit));
  const out: T[] = [];
  // Newest-first.
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    // Defensive noUncheckedIndexedAccess guard: i is always within
    // [0, tail.length) here, so `line` can never actually be undefined.
    /* v8 ignore next */
    if (line === undefined) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed lines — observability log, not transactional state.
    }
  }
  return out;
}

/**
 * The last parseable entry of a .jsonl, read from a bounded tail window.
 *
 * A missing or empty file means the log has nothing in it — null, not an error.
 * A line that does not parse is not an entry, so the scan walks backwards past
 * it exactly as `readJsonlTail` skips one; a file whose every line is garbage
 * therefore holds no entries and reads as null. What is NOT tolerated is the
 * window itself coming up empty: that means the last entry is longer than the
 * window and the true answer is unknown, so it throws rather than under-report.
 */
function readJsonlLastEntry<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const tail = readTailWindow(path);
  if (tail === null) return null;
  const lines = tail.text.split('\n');
  // A window that starts mid-file opens on the back half of whatever line
  // straddles its edge; that fragment is not a line and must not be parsed.
  if (tail.windowed) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    /* v8 ignore next -- noUncheckedIndexedAccess guard: i is always in range. */
    if (line === undefined) continue;
    // The trailing newline every append writes leaves a final empty element.
    if (line.length === 0) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      // Not an entry. Keep walking back, same as readJsonlTail.
    }
  }
  if (tail.windowed) throw new JsonlTailWindowError(path, JSONL_TAIL_WINDOW_BYTES);
  return null;
}

/**
 * The last `JSONL_TAIL_WINDOW_BYTES` of a file, and whether that was less than
 * all of it. null when the file is empty.
 */
function readTailWindow(path: string): { text: string; windowed: boolean } | null {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const length = Math.min(size, JSONL_TAIL_WINDOW_BYTES);
    const start = size - length;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return { text: buf.toString('utf8'), windowed: start > 0 };
  } finally {
    closeSync(fd);
  }
}
