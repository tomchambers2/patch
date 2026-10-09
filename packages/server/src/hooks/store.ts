// File-backed hook store at `<dataDir>/hooks/*.json` — same shape as
// `../jobs/store.ts` (atomic fsync'd writes, in-memory cache, chokidar
// watcher for external/CLI/version-controlled edits), scoped down to hooks'
// simpler CRUD (no cron registration, no concurrency, no one-off expiry).

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
  Hook,
  type HookCreateBody,
  type HookPatchBody,
  type HooksChangeEvent,
  type HooksInterface,
} from './types.js';
import { assertValidHookBody } from './validate.js';

export const HOOK_ID_REGEX = /^hook_[0-9A-HJKMNP-TV-Z]{26}$/;

export class InvalidHookIdError extends Error {
  constructor(readonly hookId: string) {
    super(`invalid hook id: ${hookId}`);
    this.name = 'InvalidHookIdError';
  }
}

function assertValidHookId(hookId: string): void {
  if (!HOOK_ID_REGEX.test(hookId)) throw new InvalidHookIdError(hookId);
}

export interface HookStoreOptions {
  dataDir: string;
  logger: Logger;
  nowMs?: () => number;
  idGenerator?: () => string;
  /** Disable the filesystem watcher (tests). */
  watch?: boolean;
}

export class HookStore implements HooksInterface {
  private readonly hooksDir: string;
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly idGenerator: () => string;
  private readonly cache = new Map<string, Hook>();
  private readonly handlers = new Set<(e: HooksChangeEvent) => void>();
  private watcher: FSWatcher | null = null;
  private readonly recentSelfWrites = new Map<string, number>();
  private static readonly SELF_WRITE_COALESCE_MS = 500;
  readonly watcherReady: Promise<void>;
  private watcherReadyResolve: (() => void) | null = null;

  constructor(opts: HookStoreOptions) {
    this.hooksDir = join(opts.dataDir, 'hooks');
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.idGenerator = opts.idGenerator ?? ((): string => ulid());
    if (!existsSync(this.hooksDir)) mkdirSync(this.hooksDir, { recursive: true });
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
    for (const name of readdirSync(this.hooksDir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.hooksDir, name);
      const raw = readFileSync(path, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this.logger.error({ path, err: (err as Error).message }, 'hook: malformed JSON, skipping');
        continue;
      }
      const result = Hook.safeParse(parsed);
      if (!result.success) {
        this.logger.error(
          { path, issues: result.error.issues },
          'hook: schema rejection, skipping',
        );
        continue;
      }
      this.cache.set(result.data.id, result.data);
    }
    this.logger.info({ count: this.cache.size }, 'hook-store: loaded');
  }

  private startWatcher(): void {
    this.watcher = chokidar.watch(this.hooksDir, {
      ignoreInitial: true,
      depth: 0,
      usePolling: true,
      interval: 50,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
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
      this.logger.error({ err: (err as Error).message }, 'hook-store: watcher error');
    });
  }

  private handleFsEvent(path: string, kind: 'add' | 'change' | 'unlink'): void {
    if (!path.endsWith('.json')) return;
    const deadline = this.recentSelfWrites.get(path);
    if (deadline !== undefined) {
      if (this.nowMs() <= deadline) {
        this.recentSelfWrites.delete(path);
        return;
      }
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
        'hook-store: read failed during fs event',
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.error(
        { path, err: (err as Error).message },
        'hook-store: malformed JSON on fs event, ignoring',
      );
      return;
    }
    const result = Hook.safeParse(parsed);
    if (!result.success) {
      this.logger.error(
        { path, issues: result.error.issues },
        'hook-store: schema rejection on fs event, ignoring',
      );
      return;
    }
    const hook = result.data;
    const existed = this.cache.has(hook.id);
    this.cache.set(hook.id, hook);
    this.emit(existed ? { type: 'updated', hook } : { type: 'created', hook });
  }

  private writeAtomic(hook: Hook): void {
    assertValidHookId(hook.id);
    const path = join(this.hooksDir, `${hook.id}.json`);
    this.recentSelfWrites.set(path, this.nowMs() + HookStore.SELF_WRITE_COALESCE_MS);
    const tmp = `${path}.tmp-${process.pid}-${this.nowMs()}`;
    writeFileSync(tmp, JSON.stringify(hook, null, 2), 'utf8');
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  private emit(event: HooksChangeEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        this.logger.error(
          { err: (err as Error).message, type: event.type },
          'hook-store: change handler threw',
        );
      }
    }
  }

  list(): Hook[] {
    return [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Hook | null {
    return this.cache.get(id) ?? null;
  }

  create(body: HookCreateBody): Hook {
    assertValidHookBody(body);
    const now = this.nowMs();
    const hook: Hook = {
      id: `hook_${this.idGenerator()}`,
      name: body.name,
      enabled: body.enabled ?? true,
      when: body.when,
      kind: body.kind,
      ...(body.script !== undefined ? { script: body.script } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      gate: body.gate ?? {},
      timeoutMs: body.timeoutMs ?? 15_000,
      createdAt: now,
      updatedAt: now,
    };
    this.writeAtomic(hook);
    this.cache.set(hook.id, hook);
    this.emit({ type: 'created', hook });
    return hook;
  }

  patch(id: string, body: HookPatchBody): Hook {
    const existing = this.cache.get(id);
    if (!existing) throw new Error(`hook not found: ${id}`);
    assertValidHookBody(body, {
      kind: existing.kind,
      hasScript: existing.script !== undefined,
      hasPrompt: existing.prompt !== undefined,
    });
    const next: Hook = {
      ...existing,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.when !== undefined ? { when: body.when } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.gate !== undefined ? { gate: body.gate } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      updatedAt: this.nowMs(),
    };
    if (body.script === null) delete next.script;
    else if (body.script !== undefined) next.script = body.script;
    if (body.prompt === null) delete next.prompt;
    else if (body.prompt !== undefined) next.prompt = body.prompt;
    this.writeAtomic(next);
    this.cache.set(id, next);
    this.emit({ type: 'updated', hook: next });
    return next;
  }

  delete(id: string): boolean {
    if (!this.cache.has(id)) return false;
    const path = join(this.hooksDir, `${id}.json`);
    if (existsSync(path)) rmSync(path);
    this.cache.delete(id);
    this.emit({ type: 'deleted', id });
    return true;
  }

  enable(id: string): Hook {
    return this.patch(id, { enabled: true });
  }

  disable(id: string): Hook {
    return this.patch(id, { enabled: false });
  }

  onChange(handler: (e: HooksChangeEvent) => void): () => void {
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
