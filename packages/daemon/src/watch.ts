// Durable background-execution primitive (`patch_watch`), replacing native
// `Bash`/`Agent` `run_in_background` (see sdkBackend.ts's `canUseTool` deny for
// those — this module is what an agent is pointed at instead).
//
// Why this exists (backgroundTaskStats.ts has the full story): a native
// backgrounded Bash/Agent call is spawned INSIDE the SDK's own process tree.
// The host never gets a pid for it — only an inherited output file it can
// `lsof` for, indirectly. That means the host can never truly kill one, and
// can never re-discover it across a restart. `patch_watch` fixes both by
// making the HOST itself the one that calls `spawn()`: it holds a real
// pid/pgid from the moment the process exists, so it can kill the whole
// group outright and can re-attach to a still-alive pid after its own
// restart (the persisted record is all either needs).
//
// Durability mirrors wake.ts's `WakeScheduler` (spec/02 § Self-wake): one
// record per task, persisted to disk with an atomic tmp-write + rename,
// before this function returns to its caller. The difference is the
// COMPLETION signal — a wake fires at a known instant, so a per-record
// `setTimeout` is exact; a watched process ends whenever it ends, so instead
// this runs ONE resident poll (`setInterval`, owned by the host process —
// same tier of code as `WakeScheduler`'s timers) that checks every persisted
// RUNNING record's liveness and delivers completion the moment it notices one
// has gone. That poll is deliberately the ONLY thing that ever calls
// `deliver()`: never a bash loop, never a `nohup`+watcher script spawned
// inside the watched command's own tree — that shape would just move today's
// bug (a background completion nobody outside the tree can observe) rather
// than fix it.

import { type ChildProcess, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';

/** A background task, persisted at `<chatDir>/watch/<taskId>.json`. */
export const WatchRecord = z
  .object({
    chatId: z.string().min(1),
    taskId: z.string().min(1),
    /** One-line human description, as given to `patch_watch`. */
    description: z.string().min(1),
    /** The literal command string that was run (a future kill-button UI's command preview). */
    command: z.string().min(1),
    cwd: z.string().min(1),
    /** Where combined stdout+stderr is written. */
    outputFile: z.string().min(1),
    /** The detached process-group leader's pid (== its pgid). */
    pid: z.number().int(),
    startedAt: z.number().int(),
    status: z.enum(['running', 'exited', 'stopped', 'failed']),
    /** Set once the task leaves `running`. Undefined = unknown (e.g. a
     *  restart re-attached to the pid and only ever observed it vanish). */
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    endedAt: z.number().int().optional(),
  })
  .strict();
export type WatchRecord = z.infer<typeof WatchRecord>;

export interface WatchSchedulerDeps {
  /** Deliver the (prefixed) completion message into the chat as a new turn. */
  deliver(chatId: string, message: string): void | Promise<void>;
  /** The chat's on-disk dir (where `watch/` lives) — mirrors wake.ts's dep. */
  dirForChat(chatId: string): string;
  /** Every chatId known on disk — scanned each poll tick. */
  allChatIds(): string[];
  now(): number;
  logger: Logger;
  /** Injectable so tests never spawn a real process. */
  spawnFn?: typeof spawn;
  generateTaskId?(): string;
  /** Injectable liveness probe for a bare pid (no live handle held). */
  isAlive?(pid: number): boolean;
  /** How often the resident poll runs. Default 3000ms. */
  pollMs?: number;
  setIntervalFn?(cb: () => void, ms: number): ReturnType<typeof setInterval>;
  clearIntervalFn?(t: ReturnType<typeof setInterval>): void;
}

const WATCH_DIR = 'watch';
/** Metadata tag on the delivered turn — data not directive, like wake.ts's `[wake]`. */
export const WATCH_PREFIX = '[watch]';
const DEFAULT_POLL_MS = 3_000;

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0: no-op, but throws ESRCH if the pid is gone (or EPERM for a
    // pid that exists but isn't ours — same-user watched processes never hit
    // that branch, so "throws" reliably means "gone" here).
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WatchScheduler {
  private readonly liveHandles = new Map<string, ChildProcess>();
  private readonly spawnFn: typeof spawn;
  private readonly isAliveFn: (pid: number) => boolean;
  private readonly generateTaskId: () => string;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (t: ReturnType<typeof setInterval>) => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: WatchSchedulerDeps) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.isAliveFn = deps.isAlive ?? defaultIsAlive;
    this.generateTaskId = deps.generateTaskId ?? (() => randomUUID());
    this.setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((t) => clearInterval(t));
    // Resident from construction: unlike wake's per-record timers, there is
    // nothing to "arm" — the tick discovers state fresh from disk every time,
    // so a host restart needs no explicit re-load step at all.
    this.timer = this.setIntervalFn(() => void this.tick(), deps.pollMs ?? DEFAULT_POLL_MS);
  }

  private dirFor(chatId: string): string {
    return join(this.deps.dirForChat(chatId), WATCH_DIR);
  }

  private filePath(chatId: string, taskId: string): string {
    return join(this.dirFor(chatId), `${taskId}.json`);
  }

  private writeRecord(rec: WatchRecord): void {
    const dir = this.dirFor(rec.chatId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = this.filePath(rec.chatId, rec.taskId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), 'utf8');
    renameSync(tmp, path); // atomic — a crash mid-write can't corrupt the record
  }

  private readOne(chatId: string, taskId: string): WatchRecord | null {
    const path = this.filePath(chatId, taskId);
    if (!existsSync(path)) return null;
    try {
      return WatchRecord.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (err) {
      this.deps.logger.warn({ chatId, taskId, err }, 'watch: corrupt record, dropping');
      return null;
    }
  }

  /**
   * Spawn `command` as a detached process group and persist its record
   * BEFORE returning — mirrors wake.ts's "persisted before armed". `cwd` is
   * resolved by the caller (Daemon.startWatch defaults it to the chat's own
   * folder); this class has no opinion about it.
   */
  start(opts: { chatId: string; command: string; description: string; cwd: string }): WatchRecord {
    const taskId = this.generateTaskId();
    const dir = this.dirFor(opts.chatId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const outputFile = join(dir, `${taskId}.output`);
    const fd = openSync(outputFile, 'a');
    let child: ChildProcess;
    try {
      child = this.spawnFn('/bin/sh', ['-c', opts.command], {
        cwd: opts.cwd,
        // Own process group, exactly like terminal.ts's shell sessions: lets
        // us signal the whole job tree later without ever aiming a signal at
        // the host itself.
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      // The child dup'd the fd during spawn; our copy is no longer needed.
      closeSync(fd);
    }
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`patch_watch: failed to spawn command: ${opts.command}`);
    }
    // Errors after spawn (e.g. the shell itself failing to exec) surface as an
    // ordinary non-zero exit the poll picks up — but an emitted 'error' with
    // no listener would crash the host, so this is required, not optional.
    child.on('error', (err) => {
      this.deps.logger.warn({ chatId: opts.chatId, taskId, err }, 'watch: process error');
    });
    const rec: WatchRecord = {
      chatId: opts.chatId,
      taskId,
      description: opts.description,
      command: opts.command,
      cwd: opts.cwd,
      outputFile,
      pid,
      startedAt: this.deps.now(),
      status: 'running',
    };
    this.writeRecord(rec);
    this.liveHandles.set(taskId, child);
    return rec;
  }

  /** Every watch this chat has running or recently ended. */
  list(chatId: string): WatchRecord[] {
    const dir = this.dirFor(chatId);
    if (!existsSync(dir)) return [];
    const records: WatchRecord[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -'.json'.length);
      const rec = this.readOne(chatId, taskId);
      if (rec) records.push(rec);
    }
    records.sort((a, b) => b.startedAt - a.startedAt);
    return records;
  }

  /**
   * How many of this chat's watches are still running — the sidebar's
   * `chat.state.backgroundTasks` count (spec/02 § Background task completions,
   * spec/14 § Status badges). Reads straight off the persisted records rather
   * than a running in-memory fold: a watch's `running` status IS the count, so
   * there is nothing to derive and nothing that can drift from it, and it
   * answers correctly immediately after a restart re-attaches (unlike the old
   * Bash/Task-launch fold, which was in-memory only and always read zero after
   * one).
   */
  count(chatId: string): number {
    let n = 0;
    for (const rec of this.list(chatId)) if (rec.status === 'running') n += 1;
    return n;
  }

  /** The task's combined stdout+stderr, optionally just the last `tail` lines. */
  output(chatId: string, taskId: string, tail?: number): string {
    const rec = this.readOne(chatId, taskId);
    if (!rec) throw new Error(`patch_watch_output: no such task ${taskId}`);
    const content = existsSync(rec.outputFile) ? readFileSync(rec.outputFile, 'utf8') : '';
    if (tail === undefined) return content;
    const lines = content.split('\n');
    // A trailing '' from the final newline shouldn't count as a "line".
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-tail).join('\n');
  }

  /**
   * Stop a running task: SIGKILL the whole process group outright (mirrors
   * terminal.ts's `end()` — no SIGTERM grace period, deliberately: a watched
   * command is an unattended batch job, not an interactive one that might
   * want to flush state on a clean shutdown, and a host that might itself
   * restart moments later has no window to wait in anyway). Marks the record
   * `stopped` immediately and does NOT call `deliver` — the caller already
   * knows synchronously that it stopped the task; `deliver` is reserved for
   * completions the poller notices on its own.
   */
  stop(chatId: string, taskId: string): boolean {
    const rec = this.readOne(chatId, taskId);
    if (!rec || rec.status !== 'running') return false;
    try {
      process.kill(-rec.pid, 'SIGKILL'); // negative pid = the whole process group
    } catch {
      // Group already gone — nothing to signal.
    }
    this.writeRecord({ ...rec, status: 'stopped', endedAt: this.deps.now() });
    this.liveHandles.delete(taskId);
    return true;
  }

  /**
   * Boot: nothing to arm (see the class comment) — this only logs how many
   * in-flight tasks this host is resuming, for observability parity with
   * `WakeScheduler.loadAll()`.
   */
  loadAll(): void {
    let running = 0;
    for (const chatId of this.deps.allChatIds()) {
      for (const rec of this.list(chatId)) {
        if (rec.status === 'running') running++;
      }
    }
    if (running > 0) {
      this.deps.logger.info(
        { running },
        'watch: resuming in-flight background tasks after restart',
      );
    }
  }

  /** The resident poll: notice every RUNNING record whose process has ended. */
  private async tick(): Promise<void> {
    for (const chatId of this.deps.allChatIds()) {
      for (const rec of this.list(chatId)) {
        if (rec.status !== 'running') continue;
        const handle = this.liveHandles.get(rec.taskId);
        if (handle) {
          // Node tracks a spawned child's exit internally regardless of
          // whether an 'exit' listener is attached, so this read is exact —
          // real exit code/signal — without this tick relying on that event
          // ever having fired (the poll is still what NOTICES it).
          if (handle.exitCode !== null || handle.signalCode !== null) {
            this.liveHandles.delete(rec.taskId);
            await this.complete(rec, handle.exitCode, handle.signalCode);
          }
          continue;
        }
        // Re-attached after a restart: no handle, just the bare pid.
        if (!this.isAliveFn(rec.pid)) {
          await this.complete(rec, null, null);
        }
      }
    }
  }

  private async complete(
    rec: WatchRecord,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    // A nonzero exit is a failure; a signal kill or an unknown (restart-lost)
    // status is still just "it stopped running" rather than a reported error.
    const status = exitCode !== null && exitCode !== 0 ? 'failed' : 'exited';
    const updated: WatchRecord = {
      ...rec,
      status,
      exitCode,
      signal,
      endedAt: this.deps.now(),
    };
    this.writeRecord(updated);
    const summary =
      exitCode === 0
        ? 'finished'
        : exitCode !== null
          ? `finished (exit ${exitCode})`
          : signal
            ? `finished (killed by ${signal})`
            : 'finished (exit status unknown — the host restarted while it was running)';
    try {
      await this.deps.deliver(
        rec.chatId,
        `${WATCH_PREFIX} "${rec.description}" ${summary}. Command: ${rec.command}. ` +
          `Call patch_watch_output("${rec.taskId}") to read its output.`,
      );
    } catch (err) {
      this.deps.logger.error(
        { chatId: rec.chatId, taskId: rec.taskId, err },
        'watch: delivery failed',
      );
    }
  }

  /** Stop the resident poll (host shutdown). Persisted records are untouched. */
  dispose(): void {
    this.clearIntervalFn(this.timer);
  }
}
