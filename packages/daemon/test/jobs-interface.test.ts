import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  MemoryJobsStore,
  JobNotFoundError,
  JobsInvalidInputError,
  JobsLinkOfflineError,
  RemoteJobsStore,
} from '../src/jobs-interface.js';

const baseBody = (
  overrides: Partial<{ name: string; folder: string }> = {},
): {
  name: string;
  trigger: { type: 'cron'; expression: string };
  action: { type: 'spawn'; folder: string };
} => ({
  name: overrides.name ?? 'test',
  trigger: { type: 'cron', expression: '* * * * *' },
  action: { type: 'spawn', daemonId: 'd1', folder: overrides.folder ?? '/x' },
});

describe('MemoryJobsStore', () => {
  it('create returns a job with id, defaults enabled=true', () => {
    const store = new MemoryJobsStore({ now: () => 1700000000000 });
    const job = store.create({
      trigger: { type: 'cron', expression: '0 9 * * 1-5' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/work/x' },
      name: 'morning',
    });
    expect(job.id).toBeDefined();
    expect(job.enabled).toBe(true);
    expect(job.name).toBe('morning');
    expect(job.createdAt).toBe(1700000000000);
  });

  it('list returns jobs ordered by createdAt', () => {
    let t = 1;
    const store = new MemoryJobsStore({ now: () => t });
    const a = store.create(baseBody({ name: 'a' }));
    t = 2;
    const b = store.create(baseBody({ name: 'b', folder: '/y' }));
    const list = store.list();
    expect(list.map((j) => j.id)).toEqual([a.id, b.id]);
  });

  it('patch merges patch fields', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    const updated = store.patch(job.id, { name: 'renamed', enabled: false });
    expect(updated.name).toBe('renamed');
    expect(updated.enabled).toBe(false);
  });

  it('patch merges trigger/action/filter fields when provided', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    const updated = store.patch(job.id, {
      trigger: { type: 'cron', expression: '0 0 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/newfolder' },
      filter: 'true',
    });
    expect(updated.trigger).toEqual({ type: 'cron', expression: '0 0 * * *' });
    expect(updated.action).toEqual({ type: 'spawn', daemonId: 'd1', folder: '/newfolder' });
    expect(updated.filter).toBe('true');
  });

  it('patch on missing id throws JobNotFoundError', () => {
    const store = new MemoryJobsStore();
    expect(() => store.patch('nope', { enabled: false })).toThrow(JobNotFoundError);
  });

  it('delete removes and returns boolean', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    expect(store.delete(job.id)).toBe(true);
    // Repeat delete is a no-op on the canonical interface.
    expect(store.delete(job.id)).toBe(false);
  });

  it('enable/disable flips enabled flag', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    expect(store.disable(job.id).enabled).toBe(false);
    expect(store.enable(job.id).enabled).toBe(true);
  });

  it('get returns the job or null when missing', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    expect(store.get(job.id)).toEqual(job);
    expect(store.get('nope')).toBeNull();
  });

  it('update is a back-compat shim for patch', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    const updated = store.update(job.id, { name: 'via-update' });
    expect(updated.name).toBe('via-update');
  });

  it('setEnabled is a back-compat shim for patch({ enabled })', () => {
    const store = new MemoryJobsStore();
    const job = store.create(baseBody());
    expect(store.setEnabled(job.id, false).enabled).toBe(false);
    expect(store.setEnabled(job.id, true).enabled).toBe(true);
  });
});

describe('JobsInvalidInputError', () => {
  it('carries the message and a distinct name', () => {
    const err = new JobsInvalidInputError('bad cron expression');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('JobsInvalidInputError');
    expect(err.message).toBe('bad cron expression');
  });
});

// RemoteJobsStore: the production host implementation, relaying every
// `patch_job_*` op over the daemon-link as a `patch.jobs.request` and
// resolving on the matching `patch.jobs.response` (Group 10 BLOCKER B.8).
// jobs-interface.test.ts exercises the FULL public API surface directly (in
// addition to remote-jobs-store.test.ts) so this file alone drives 100%
// coverage of jobs-interface.ts.
describe('RemoteJobsStore', () => {
  function harness(opts: { online?: boolean; requestTimeoutMs?: number } = {}) {
    const sent: WireEvent[] = [];
    let online = opts.online ?? true;
    let seq = 0;
    const store = new RemoteJobsStore({
      emit: (e) => sent.push(e),
      isLinkOnline: () => online,
      requestTimeoutMs: opts.requestTimeoutMs,
      idGen: () => `req-${++seq}`,
    });
    const respond = (requestId: string, result: unknown): void => {
      store.handleResponse({
        type: 'patch.jobs.response',
        requestId,
        ok: true,
        result,
      });
    };
    const respondError = (requestId: string, error: { code?: string; message: string }): void => {
      store.handleResponse({
        type: 'patch.jobs.response',
        requestId,
        ok: false,
        error,
      });
    };
    return {
      store,
      sent,
      respond,
      respondError,
      setOnline: (v: boolean) => {
        online = v;
      },
      lastRequestId: () => sent[sent.length - 1]?.['requestId'] as string,
    };
  }

  it('get: emits a get op and resolves with the response result', async () => {
    const h = harness();
    const promise = h.store.get('job-1');
    expect(h.sent[0]).toMatchObject({ type: 'patch.jobs.request', op: 'get', jobId: 'job-1' });
    h.respond(h.lastRequestId(), { id: 'job-1' });
    await expect(promise).resolves.toEqual({ id: 'job-1' });
  });

  it('patch: emits a patch op with jobId + body and resolves', async () => {
    const h = harness();
    const promise = h.store.patch('job-1', { name: 'renamed' });
    expect(h.sent[0]).toMatchObject({
      type: 'patch.jobs.request',
      op: 'patch',
      jobId: 'job-1',
      body: { name: 'renamed' },
    });
    h.respond(h.lastRequestId(), { id: 'job-1', name: 'renamed' });
    await expect(promise).resolves.toEqual({ id: 'job-1', name: 'renamed' });
  });

  it('delete: emits a delete op and resolves with a boolean', async () => {
    const h = harness();
    const promise = h.store.delete('job-1');
    expect(h.sent[0]).toMatchObject({ type: 'patch.jobs.request', op: 'delete', jobId: 'job-1' });
    h.respond(h.lastRequestId(), true);
    await expect(promise).resolves.toBe(true);
  });

  it('enable/disable: emit the matching op and resolve with the job', async () => {
    const h = harness();
    const enablePromise = h.store.enable('job-1');
    expect(h.sent[0]).toMatchObject({ type: 'patch.jobs.request', op: 'enable', jobId: 'job-1' });
    h.respond(h.lastRequestId(), { id: 'job-1', enabled: true });
    await expect(enablePromise).resolves.toEqual({ id: 'job-1', enabled: true });

    const disablePromise = h.store.disable('job-1');
    expect(h.sent[1]).toMatchObject({ type: 'patch.jobs.request', op: 'disable', jobId: 'job-1' });
    h.respond(h.lastRequestId(), { id: 'job-1', enabled: false });
    await expect(disablePromise).resolves.toEqual({ id: 'job-1', enabled: false });
  });

  it('runs: uses callWithLimit, omitting `limit` when not passed', async () => {
    const h = harness();
    const promise = h.store.runs('job-1');
    expect(h.sent[0]).toMatchObject({ type: 'patch.jobs.request', op: 'runs', jobId: 'job-1' });
    expect(h.sent[0]).not.toHaveProperty('limit');
    h.respond(h.lastRequestId(), [{ at: 1 }]);
    await expect(promise).resolves.toEqual([{ at: 1 }]);
  });

  it('runs: passes `limit` through when provided', async () => {
    const h = harness();
    const promise = h.store.runs('job-1', 5);
    expect(h.sent[0]).toMatchObject({
      type: 'patch.jobs.request',
      op: 'runs',
      jobId: 'job-1',
      limit: 5,
    });
    h.respond(h.lastRequestId(), []);
    await expect(promise).resolves.toEqual([]);
  });

  it('webhooks: uses callWithLimit with and without a limit', async () => {
    const h = harness();
    const promiseNoLimit = h.store.webhooks('job-1');
    expect(h.sent[0]).toMatchObject({ type: 'patch.jobs.request', op: 'webhooks', jobId: 'job-1' });
    expect(h.sent[0]).not.toHaveProperty('limit');
    h.respond(h.lastRequestId(), []);
    await expect(promiseNoLimit).resolves.toEqual([]);

    const promiseWithLimit = h.store.webhooks('job-1', 3);
    expect(h.sent[1]).toMatchObject({
      type: 'patch.jobs.request',
      op: 'webhooks',
      jobId: 'job-1',
      limit: 3,
    });
    h.respond(h.lastRequestId(), [{ id: 'w1' }]);
    await expect(promiseWithLimit).resolves.toEqual([{ id: 'w1' }]);
  });

  it('rejects every op with JobsLinkOfflineError when the link is offline (NO FALLBACK)', async () => {
    const h = harness({ online: false });
    await expect(h.store.list()).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(h.store.get('x')).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(
      h.store.create({
        name: 't',
        trigger: { type: 'cron', expression: '* * * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      }),
    ).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(h.store.patch('x', { name: 'n' })).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(h.store.delete('x')).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(h.store.enable('x')).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(h.store.disable('x')).rejects.toBeInstanceOf(JobsLinkOfflineError);
    // runs/webhooks go through the separate callWithLimit offline guard.
    await expect(h.store.runs('x')).rejects.toBeInstanceOf(JobsLinkOfflineError);
    await expect(h.store.webhooks('x')).rejects.toBeInstanceOf(JobsLinkOfflineError);
    expect(h.sent).toHaveLength(0);
  });

  it('handleResponse: ignores events that are not patch.jobs.response', () => {
    const h = harness();
    expect(h.store.handleResponse({ type: 'patch.jobs.request' } as unknown as WireEvent)).toBe(
      false,
    );
  });

  it('handleResponse: ignores a response that fails schema validation', () => {
    const h = harness();
    expect(
      h.store.handleResponse({
        type: 'patch.jobs.response',
        // Missing required fields (requestId/ok) — safeParse must fail.
      } as unknown as WireEvent),
    ).toBe(false);
  });

  it('handleResponse: ignores a well-formed response with no matching pending request', () => {
    const h = harness();
    expect(
      h.store.handleResponse({
        type: 'patch.jobs.response',
        requestId: 'unknown-req',
        ok: true,
        result: null,
      }),
    ).toBe(false);
  });

  it('handleResponse: a not_found error rejects as JobNotFoundError', async () => {
    const h = harness();
    const promise = h.store.get('missing-job');
    h.respondError(h.lastRequestId(), { code: 'not_found', message: 'job not found: missing-job' });
    await expect(promise).rejects.toMatchObject({ name: 'JobNotFoundError', code: 'not_found' });
  });

  it('handleResponse: an invalid_input error rejects as JobInvalidInputError', async () => {
    const h = harness();
    const promise = h.store.patch('job-1', { name: 'bad' });
    h.respondError(h.lastRequestId(), { code: 'invalid_input', message: 'bad cron' });
    await expect(promise).rejects.toMatchObject({
      name: 'JobInvalidInputError',
      code: 'invalid_input',
    });
  });

  it('handleResponse: an "internal" error code rejects as a generic JobsResponseError', async () => {
    const h = harness();
    const promise = h.store.get('job-1');
    h.respondError(h.lastRequestId(), { code: 'internal', message: 'huh' });
    await expect(promise).rejects.toMatchObject({ name: 'JobsResponseError', code: 'internal' });
  });

  it('handleResponse: an error with no message falls back to a default message', async () => {
    const h = harness();
    const promise = h.store.get('job-1');
    h.store.handleResponse({
      type: 'patch.jobs.response',
      requestId: h.lastRequestId(),
      ok: false,
    });
    await expect(promise).rejects.toMatchObject({ message: 'jobs response error' });
  });

  it('rejects with a timeout error when no response ever arrives', async () => {
    const h = harness({ requestTimeoutMs: 20 });
    await expect(h.store.get('job-1')).rejects.toThrow(/timed out/);
  });

  it('runs/webhooks (callWithLimit) also time out when no response arrives', async () => {
    const h = harness({ requestTimeoutMs: 20 });
    await expect(h.store.runs('job-1')).rejects.toThrow(/timed out/);
  });

  it('defaults requestTimeoutMs and idGen when not provided', async () => {
    const sent: WireEvent[] = [];
    const store = new RemoteJobsStore({ emit: (e) => sent.push(e), isLinkOnline: () => true });
    const promise = store.list();
    expect(sent).toHaveLength(1);
    const requestId = sent[0]?.['requestId'] as string;
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    store.handleResponse({ type: 'patch.jobs.response', requestId, ok: true, result: [] });
    await expect(promise).resolves.toEqual([]);
  });
});
