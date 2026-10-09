// Host-side jobs interface re-export + bridge.
//
// Group 10 BLOCKER B.8: the canonical schema lives in `@patch/wire/jobs`
// and the SERVER is the canonical owner of `/data/jobs/*.json`. The
// host's `patch_job_*` MCP tools must NOT mutate a local in-memory
// store — they must round-trip to the server.
//
// `RemoteJobsStore` implements `AsyncJobsInterface` by sending
// `patch.jobs.request` events upstream over the daemon-link and awaiting
// a `patch.jobs.response`. NO FALLBACK: if the link is offline the call
// rejects with a typed error so the MCP tool surfaces a clear failure to
// the calling agent.
//
// `MemoryJobsStore` is retained as a test helper (cross-chat-tools tests
// and jobs-interface.test.ts use it). It is NOT used in production paths.

import { randomUUID } from 'node:crypto';
import {
  JobCreateBody as JobCreateBodySchema,
  JobPatchBody as JobPatchBodySchema,
  type AsyncJobsInterface,
  type Job,
  type JobCreateBody,
  type JobPatchBody,
} from '@patch/wire/jobs';
import { PatchJobsResponseEvent, type PatchJobsOp, type WireEvent } from '@patch/wire';

export {
  CronTrigger,
  WebhookScheme,
  WebhookTrigger,
  TodoistTrigger,
  JobTrigger,
  SpawnAction,
  MessageAction,
  JobAction,
  Job as JobSchema,
  JobCreateBody as JobCreateBodySchema,
  JobPatchBody as JobPatchBodySchema,
} from '@patch/wire/jobs';

export type {
  Job,
  JobCreateBody,
  JobPatchBody,
  JobsInterface,
  AsyncJobsInterface,
} from '@patch/wire/jobs';

// Back-compat aliases — earlier code imported these names.
export const JobCreate = JobCreateBodySchema;
export const JobUpdate = JobPatchBodySchema;
export type JobCreate = JobCreateBody;
export type JobUpdate = JobPatchBody;

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export class JobsLinkOfflineError extends Error {
  constructor() {
    super('jobs: daemon-link is offline; refusing to buffer mutation (NO FALLBACK)');
    this.name = 'JobsLinkOfflineError';
  }
}

export class JobsInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsInvalidInputError';
  }
}

// ---------------------------------------------------------------------------
// RemoteJobsStore — production host implementation.

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RemoteJobsStoreOptions {
  /** Push a wire event upstream to the server (host's existing `emit`). */
  emit: (event: WireEvent) => void;
  /** Returns true when the daemon-link is currently authenticated. */
  isLinkOnline: () => boolean;
  /** Per-request timeout. Tests shorten. Default 10_000ms. */
  requestTimeoutMs?: number;
  /** Test hook: deterministic requestId. */
  idGen?: () => string;
}

export class RemoteJobsStore implements AsyncJobsInterface {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly emit: (event: WireEvent) => void;
  private readonly isLinkOnline: () => boolean;
  private readonly timeoutMs: number;
  private readonly idGen: () => string;

  constructor(opts: RemoteJobsStoreOptions) {
    this.emit = opts.emit;
    this.isLinkOnline = opts.isLinkOnline;
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.idGen = opts.idGen ?? ((): string => randomUUID());
  }

  /**
   * Feed a `patch.jobs.response` from the upstream WS into the matching
   * pending request. Host's `handleServerEvent` routes responses here.
   */
  handleResponse(event: WireEvent): boolean {
    if (event.type !== 'patch.jobs.response') return false;
    const parsed = PatchJobsResponseEvent.safeParse(event);
    if (!parsed.success) return false;
    const pending = this.pending.get(parsed.data.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.requestId);
    if (parsed.data.ok) {
      pending.resolve(parsed.data.result);
    } else {
      const err = new Error(parsed.data.error?.message ?? 'jobs response error') as Error & {
        code?: string;
      };
      const code = parsed.data.error?.code;
      err.code = code;
      err.name =
        code === 'not_found'
          ? 'JobNotFoundError'
          : code === 'invalid_input'
            ? 'JobInvalidInputError'
            : 'JobsResponseError';
      pending.reject(err);
    }
    return true;
  }

  private call<T>(op: PatchJobsOp, payload: { jobId?: string; body?: unknown }): Promise<T> {
    if (!this.isLinkOnline()) {
      return Promise.reject(new JobsLinkOfflineError());
    }
    const requestId = this.idGen();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`jobs: ${op} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        resolve: (r) => resolve(r as T),
        reject,
        timer,
      });
      const event: WireEvent = {
        type: 'patch.jobs.request',
        requestId,
        op,
        ...(payload.jobId !== undefined ? { jobId: payload.jobId } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
      };
      this.emit(event);
    });
  }

  list(): Promise<Job[]> {
    return this.call<Job[]>('list', {});
  }
  get(id: string): Promise<Job | null> {
    return this.call<Job | null>('get', { jobId: id });
  }
  create(body: JobCreateBody): Promise<Job> {
    return this.call<Job>('create', { body });
  }
  patch(id: string, body: JobPatchBody): Promise<Job> {
    return this.call<Job>('patch', { jobId: id, body });
  }
  delete(id: string): Promise<boolean> {
    return this.call<boolean>('delete', { jobId: id });
  }
  enable(id: string): Promise<Job> {
    return this.call<Job>('enable', { jobId: id });
  }
  disable(id: string): Promise<Job> {
    return this.call<Job>('disable', { jobId: id });
  }
  runs(id: string, limit?: number): Promise<unknown[]> {
    return this.callWithLimit<unknown[]>('runs', id, limit);
  }
  webhooks(id: string, limit?: number): Promise<unknown[]> {
    return this.callWithLimit<unknown[]>('webhooks', id, limit);
  }

  private callWithLimit<T>(op: PatchJobsOp, jobId: string, limit?: number): Promise<T> {
    if (!this.isLinkOnline()) return Promise.reject(new JobsLinkOfflineError());
    const requestId = this.idGen();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`jobs: ${op} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        resolve: (r) => resolve(r as T),
        reject,
        timer,
      });
      const event: WireEvent = {
        type: 'patch.jobs.request',
        requestId,
        op,
        jobId,
        ...(limit !== undefined ? { limit } : {}),
      };
      this.emit(event);
    });
  }
}

// ---------------------------------------------------------------------------
// MemoryJobsStore — TEST-ONLY in-memory store. Production paths use
// `RemoteJobsStore` so jobs are persisted on the server. This stays so
// the host's MCP-tool tests can exercise the UDS surface without spinning
// up a server.

export class MemoryJobsStore implements AsyncJobsInterface {
  private readonly jobs = new Map<string, Job>();
  private readonly idGen: () => string;
  private readonly now: () => number;

  constructor(opts: { idGen?: () => string; now?: () => number } = {}) {
    let counter = 0;
    this.idGen = opts.idGen ?? ((): string => `j_${'0'.repeat(25)}${counter++ % 10}`);
    this.now = opts.now ?? ((): number => Date.now());
  }

  list(): Job[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  create(body: JobCreateBody): Job {
    const id = this.idGen();
    const t = this.now();
    const job: Job = {
      id,
      name: body.name,
      trigger: body.trigger,
      action: body.action,
      filter: body.filter ?? null,
      enabled: body.enabled ?? true,
      ...(body.group !== undefined ? { group: body.group } : {}),
      createdAt: t,
      updatedAt: t,
    };
    this.jobs.set(id, job);
    return job;
  }

  patch(id: string, body: JobPatchBody): Job {
    const cur = this.jobs.get(id);
    if (!cur) throw new JobNotFoundError(id);
    const next: Job = {
      ...cur,
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
      ...(body.action !== undefined ? { action: body.action } : {}),
      ...(body.filter !== undefined ? { filter: body.filter } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      ...(body.group !== undefined ? { group: body.group } : {}),
      updatedAt: this.now(),
    };
    this.jobs.set(id, next);
    return next;
  }

  delete(id: string): boolean {
    return this.jobs.delete(id);
  }

  enable(id: string): Job {
    return this.patch(id, { enabled: true });
  }

  disable(id: string): Job {
    return this.patch(id, { enabled: false });
  }

  // Back-compat shims for any caller still using the old names.
  update(id: string, body: JobPatchBody): Job {
    return this.patch(id, body);
  }
  setEnabled(id: string, enabled: boolean): Job {
    return this.patch(id, { enabled });
  }
}
