// Group 10 BLOCKER B.8: RemoteJobsStore — relays patch.jobs.* over the
// daemon-link instead of mutating local state.

import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { RemoteJobsStore, JobsLinkOfflineError } from '../src/jobs-interface.js';

describe('RemoteJobsStore', () => {
  it('emits a patch.jobs.request and resolves on the matching response', async () => {
    const sent: WireEvent[] = [];
    let online = true;
    const store = new RemoteJobsStore({
      emit: (e) => sent.push(e),
      isLinkOnline: () => online,
      idGen: () => 'req-1',
    });
    const promise = store.list();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'patch.jobs.request', op: 'list', requestId: 'req-1' });
    store.handleResponse({
      type: 'patch.jobs.response',
      requestId: 'req-1',
      ok: true,
      result: [],
    });
    await expect(promise).resolves.toEqual([]);
    void online;
  });

  it('rejects with JobsLinkOfflineError when link is offline (NO FALLBACK)', async () => {
    const store = new RemoteJobsStore({
      emit: () => undefined,
      isLinkOnline: () => false,
    });
    await expect(
      store.create({
        name: 't',
        trigger: { type: 'cron', expression: '* * * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
      }),
    ).rejects.toBeInstanceOf(JobsLinkOfflineError);
  });

  it('routes a not_found error response back as a rejection', async () => {
    const sent: WireEvent[] = [];
    const store = new RemoteJobsStore({
      emit: (e) => sent.push(e),
      isLinkOnline: () => true,
      idGen: () => 'req-2',
    });
    const promise = store.get('j_missing');
    store.handleResponse({
      type: 'patch.jobs.response',
      requestId: 'req-2',
      ok: false,
      error: { code: 'not_found', message: 'job not found: j_missing' },
    });
    await expect(promise).rejects.toMatchObject({ name: 'JobNotFoundError' });
  });

  // Issue #23: an invalid_input response (bad cron / JSONata rejected by the
  // server's single semantic gate) must reject with a JobInvalidInputError so
  // the host UDS surfaces a 400 to the creating agent — never a silent 200.
  it('routes an invalid_input error response back as a JobInvalidInputError', async () => {
    const sent: WireEvent[] = [];
    const store = new RemoteJobsStore({
      emit: (e) => sent.push(e),
      isLinkOnline: () => true,
      idGen: () => 'req-inv',
    });
    const promise = store.create({
      name: 'bad',
      trigger: { type: 'cron', expression: 'not a cron' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x' },
    });
    store.handleResponse({
      type: 'patch.jobs.response',
      requestId: 'req-inv',
      ok: false,
      error: { code: 'invalid_input', message: 'invalid cron expression: not a cron' },
    });
    await expect(promise).rejects.toMatchObject({ name: 'JobInvalidInputError' });
  });

  it('times out when no response arrives', async () => {
    const store = new RemoteJobsStore({
      emit: () => undefined,
      isLinkOnline: () => true,
      requestTimeoutMs: 30,
    });
    await expect(store.list()).rejects.toThrow(/timed out/);
  });
});
