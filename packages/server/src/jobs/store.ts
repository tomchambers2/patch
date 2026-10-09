// File-backed job store at `<dataDir>/jobs/*.json`.
//
// Atomic writes (temp + fsync + rename), in-memory cache, chokidar watcher
// for external edits (CLI, version control, the cross-chat tool's
// `patch_job_*` flows that hop through this same interface).
//
// This is the canonical owner of job state for the server; cron scheduler,
// webhook ingress, and REST routes all consume the same store.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import {
  Job,
  type JobCreateBody,
  type JobPatchBody,
  type JobsChangeEvent,
  type JobsInterface,
} from './types.js';
import { assertValidJobId } from './logs.js';
import { assertValidJobBody, assertValidQueueing } from './validate.js';

export interface JobStoreOptions {
  /** Root data dir; jobs land in `<dataDir>/jobs/`. */
  dataDir: string;
  logger: Logger;
  /** Override clock; tests inject deterministic time. */
  nowMs?: () => number;
  /** Override id generator; tests inject deterministic ids. */
  idGenerator?: () => string;
  /** Disable filesystem watcher (tests). */
  watch?: boolean;
}

export class JobStore implements JobsInterface {
  private readonly jobsDir: string;
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly idGenerator: () => string;
  private readonly cache = new Map<string, Job>();
  private readonly handlers = new Set<(e: JobsChangeEvent) => void>();
  private watcher: FSWatcher | null = null;
  /**
   * Self-write coalescing window (group 10 MAJOR M5). Every time the store
   * writes a file via `writeAtomic` we record the path with a deadline; the
   * chokidar 'add'/'change' callback within the window is suppressed so the
   * cron scheduler doesn't double-register. External edits past the deadline
   * still fire normally.
   */
  private readonly recentSelfWrites = new Map<string, number>();
  private static readonly SELF_WRITE_COALESCE_MS = 500;
  /** Resolves when the chokidar watcher has finished its initial scan.
   * Tests `await store.watcherReady` before mutating files. */
  readonly watcherReady: Promise<void>;
  private watcherReadyResolve: (() => void) | null = null;

  constructor(opts: JobStoreOptions) {
    this.jobsDir = join(opts.dataDir, 'jobs');
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.idGenerator = opts.idGenerator ?? ((): string => ulid());
    if (!existsSync(this.jobsDir)) mkdirSync(this.jobsDir, { recursive: true });
    this.loadAll();
    this.watcherReady = new Promise<void>((resolve) => {
      this.watcherReadyResolve = resolve;
    });
    if (opts.watch !== false) {
      this.startWatcher();
    } else {
      this.watcherReadyResolve?.();
      this.watcherReadyResolve = null;
    }
  }

  private loadAll(): void {
    for (const name of readdirSync(this.jobsDir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.jobsDir, name);
      const raw = readFileSync(path, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this.logger.error({ path, err: (err as Error).message }, 'job: malformed JSON, skipping');
        continue;
      }
      const result = Job.safeParse(parsed);
      if (!result.success) {
        this.logger.error({ path, issues: result.error.issues }, 'job: schema rejection, skipping');
        continue;
      }
      this.cache.set(result.data.id, result.data);
    }
    this.logger.info({ count: this.cache.size }, 'job-store: loaded');
  }

  private startWatcher(): void {
    // Watch the directory itself (depth 1). Polling is more reliable than
    // FSEvents on macOS in test/CI environments where filesystem
    // notifications can be lossy or delayed.
    this.watcher = chokidar.watch(this.jobsDir, {
      ignoreInitial: true,
      depth: 0,
      usePolling: true,
      interval: 50,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      // Security M1: refuse symlinks. /data/jobs is container-internal but
      // a stray symlink could redirect a watcher event toward /etc.
      followSymlinks: false,
    });
    this.watcher.on('add', (path) => this.handleFsEvent(path, 'add'));
    this.watcher.on('change', (path) => this.handleFsEvent(path, 'change'));
    this.watcher.on('unlink', (path) => this.handleFsEvent(path, 'unlink'));
    this.watcher.on('ready', () => {
      this.watcherReadyResolve?.();
      this.watcherReadyResolve = null;
    });
    this.watcher.on('error', (err) => {
      this.logger.error({ err: (err as Error).message }, 'job-store: watcher error');
    });
  }

  private handleFsEvent(path: string, kind: 'add' | 'change' | 'unlink'): void {
    if (!path.endsWith('.json')) return;
    // Suppress events for files we just wrote ourselves. M5 fix: without
    // this, JobStore.create -> writeAtomic -> emit('created') AND chokidar
    // -> handleFsEvent -> emit('updated') BOTH fire, so CronScheduler
    // registers twice.
    const deadline = this.recentSelfWrites.get(path);
    if (deadline !== undefined) {
      if (this.nowMs() <= deadline) {
        // Self-write within the window — drop and forget the marker.
        this.recentSelfWrites.delete(path);
        return;
      }
      // Window expired; fall through and treat as external.
      this.recentSelfWrites.delete(path);
    }
    if (kind === 'unlink') {
      const id = path
        .split('/')
        .pop()
        ?.replace(/\.json$/, '');
      if (!id) return;
      const had = this.cache.delete(id);
      if (had) this.emit({ type: 'deleted', id });
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      this.logger.warn(
        { path, err: (err as Error).message },
        'job-store: read failed during fs event',
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.error(
        { path, err: (err as Error).message },
        'job-store: malformed JSON on fs event, ignoring',
      );
      return;
    }
    const result = Job.safeParse(parsed);
    if (!result.success) {
      this.logger.error(
        { path, issues: result.error.issues },
        'job-store: schema rejection on fs event, ignoring',
      );
      return;
    }
    const job = result.data;
    const existed = this.cache.has(job.id);
    this.cache.set(job.id, job);
    this.emit(existed ? { type: 'updated', job } : { type: 'created', job });
  }

  private writeAtomic(job: Job): void {
    // Defense-in-depth: id is server-generated as `j_<ulid>` so this should
    // never throw, but assert anyway so a future bug can't open a traversal.
    assertValidJobId(job.id);
    const path = join(this.jobsDir, `${job.id}.json`);
    // Mark this path as a self-write so the chokidar callback within the
    // coalescing window can be suppressed. See M5 / handleFsEvent.
    this.recentSelfWrites.set(path, this.nowMs() + JobStore.SELF_WRITE_COALESCE_MS);
    const tmp = `${path}.tmp-${process.pid}-${this.nowMs()}`;
    const body = JSON.stringify(job, null, 2);
    writeFileSync(tmp, body, 'utf8');
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  private emit(event: JobsChangeEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        this.logger.error(
          { err: (err as Error).message, type: event.type },
          'job-store: change handler threw',
        );
      }
    }
  }

  list(): Job[] {
    return [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Job | null {
    return this.cache.get(id) ?? null;
  }

  create(body: JobCreateBody): Job {
    // Semantic gate (cron / JSONata) — the SINGLE source of truth shared by
    // every CRUD surface (REST, host UDS, RPC bridge). Throws on bad input.
    assertValidJobBody(body);
    assertValidQueueing(body);
    const now = this.nowMs();
    const job: Job = {
      id: `j_${this.idGenerator()}`,
      name: body.name,
      enabled: body.enabled ?? true,
      trigger: body.trigger,
      filter: body.filter ?? null,
      action: body.action,
      ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
      ...(body.queueing !== undefined ? { queueing: body.queueing } : {}),
      ...(body.window !== undefined && body.window !== null ? { window: body.window } : {}),
      ...(body.oneOff !== undefined ? { oneOff: body.oneOff } : {}),
      ...(body.group !== undefined ? { group: body.group } : {}),
      // `null` means "use the default" same as omitted, since a brand-new
      // job has no stored override to clear either way (spec/08 § Autonomy
      // prompt).
      ...(body.autonomyPrompt !== undefined && body.autonomyPrompt !== null
        ? { autonomyPrompt: body.autonomyPrompt }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.writeAtomic(job);
    this.cache.set(job.id, job);
    this.emit({ type: 'created', job });
    return job;
  }

  patch(id: string, body: JobPatchBody): Job {
    const next = this.merge(id, body);
    this.writeAtomic(next);
    this.cache.set(id, next);
    this.emit({ type: 'updated', job: next });
    return next;
  }

  /**
   * What the job would be with `body` applied — validated exactly as `patch`
   * validates it, but never written, cached or emitted. Lets the editor's Run
   * now fire the draft on screen rather than the saved copy (spec/08 § Manual
   * run).
   */
  preview(id: string, body: JobPatchBody): Job {
    return this.merge(id, body);
  }

  private merge(id: string, body: JobPatchBody): Job {
    const existing = this.cache.get(id);
    if (!existing) throw new Error(`job not found: ${id}`);
    assertValidJobBody(body);
    const next: Job = {
      ...existing,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
      ...(body.filter !== undefined ? { filter: body.filter } : {}),
      ...(body.action !== undefined ? { action: body.action } : {}),
      ...(body.oneOff !== undefined ? { oneOff: body.oneOff } : {}),
      // Put away / brought back (spec/08 § Archived jobs). Written on its own
      // — it never touches `enabled`, so un-archiving restores the job exactly
      // as it was rather than guessing whether it should now run.
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      // Free-text organisational label (spec/08 § Groups). An omitted key
      // leaves the job's current group alone; `''` clears it — ordinary
      // string-field semantics, no separate null-to-clear convention.
      ...(body.group !== undefined ? { group: body.group } : {}),
      ...(body.autonomyPrompt !== undefined && body.autonomyPrompt !== null
        ? { autonomyPrompt: body.autonomyPrompt }
        : {}),
      updatedAt: this.nowMs(),
    };
    // `null` is the explicit "remove the limit" instruction (spec/08
    // § Concurrency); omitting the key leaves whatever the job already has.
    if (body.concurrency === null) delete next.concurrency;
    else if (body.concurrency !== undefined) next.concurrency = body.concurrency;
    // Same convention for the queueing mode (spec/08 § Queueing).
    if (body.queueing === null) delete next.queueing;
    else if (body.queueing !== undefined) next.queueing = body.queueing;
    assertValidQueueing(next);
    // Same convention for the run window (spec/08 § Run window).
    if (body.window === null) delete next.window;
    else if (body.window !== undefined) next.window = body.window;
    // `null` is the explicit "back to default" instruction (spec/08
    // § Autonomy prompt); omitting the key leaves whatever override the job
    // already has.
    if (body.autonomyPrompt === null) delete next.autonomyPrompt;
    // An enabled job is never expired (spec/08 § One-off jobs): enabling is
    // exactly how a retired one-off is re-armed, so the stamp comes off here
    // rather than leaving a job that reads "retired" while firing again.
    if (body.enabled === true) delete next.expiredAt;
    return next;
  }

  delete(id: string): boolean {
    if (!this.cache.has(id)) return false;
    const path = join(this.jobsDir, `${id}.json`);
    if (existsSync(path)) rmSync(path);
    this.cache.delete(id);
    this.emit({ type: 'deleted', id });
    return true;
  }

  enable(id: string): Job {
    return this.patch(id, { enabled: true });
  }

  disable(id: string): Job {
    return this.patch(id, { enabled: false });
  }

  /**
   * Retire a one-off job (spec/08 § One-off jobs). The ONLY write path for
   * `expiredAt`, which is why it is not reachable through `patch()` — the
   * patch body has no such field and its `.strict()` refuses one.
   *
   * Returns null, changing nothing, when there is nothing to retire: no such
   * job, not a one-off, or already carrying a stamp. That last case is what
   * makes a second fire settling `ok` harmless.
   */
  expireOneOff(id: string, at: number): Job | null {
    const existing = this.cache.get(id);
    if (!existing) return null;
    if (existing.oneOff !== true) return null;
    if (existing.expiredAt !== undefined) return null;
    const next: Job = { ...existing, enabled: false, expiredAt: at, updatedAt: this.nowMs() };
    this.writeAtomic(next);
    this.cache.set(id, next);
    this.emit({ type: 'updated', job: next });
    return next;
  }

  onChange(handler: (e: JobsChangeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
