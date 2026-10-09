// Unit-level coverage for jobs/rpc-bridge.ts's `handle()` — every op branch
// (list/get/create/patch/delete/enable/disable/runs/webhooks), the
// missing-jobId / invalid-body / not-found error paths, the unknown-op
// exhaustiveness fallback, and the JobValidationError-vs-internal-error
// catch split. Uses `attachJobsRpcBridge` directly (no HTTP, no buildAll) —
// jobs-rpc-bridge.test.ts already covers the happy-path "create over the
// daemon-link end to end" scenario via buildAll; this file is the exhaustive
// branch sweep for the same source file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { attachJobsRpcBridge } from '../src/jobs/rpc-bridge.js';
import { JobStore } from '../src/jobs/store.js';
import { JobLogs } from '../src/jobs/logs.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import type { JobsInterface } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

function findResponse(link: InProcessDaemonLink, requestId: string) {
  const reply = link.sent.find(
    (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === requestId,
  );
  if (!reply || reply.event.type !== 'patch.jobs.response') {
    throw new Error(`no patch.jobs.response for requestId=${requestId}`);
  }
  return reply.event;
}

describe('attachJobsRpcBridge — every op branch', () => {
  let dir: string;
  let jobs: JobStore;
  let logs: JobLogs;
  let link: InProcessDaemonLink;
  let unsub: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-rpc-bridge-'));
    jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    logs = new JobLogs(dir);
    link = new InProcessDaemonLink();
    unsub = attachJobsRpcBridge({ link, jobs, logs, logger: silentLogger });
  });

  afterEach(async () => {
    unsub();
    await jobs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-"patch.jobs.request" events entirely (no response sent)', () => {
    link.emit({ type: 'chat.input', chatId: 'c1', message: 'hi', localId: 'x' });
    expect(link.sent).toHaveLength(0);
  });

  it('unsub() detaches the handler — no further responses after calling it', () => {
    unsub();
    link.emit({ type: 'patch.jobs.request', requestId: 'r-detached', op: 'list' });
    expect(link.sent).toHaveLength(0);
  });

  it('op=list returns every job', () => {
    const job = jobs.create({
      name: 'listed',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({ type: 'patch.jobs.request', requestId: 'r-list', op: 'list' });
    const resp = findResponse(link, 'r-list');
    expect(resp.ok).toBe(true);
    expect((resp.result as Array<{ id: string }>).map((j) => j.id)).toEqual([job.id]);
  });

  it('op=get with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-get-missing', op: 'get' });
    const resp = findResponse(link, 'r-get-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
    expect(resp.error?.message).toMatch(/missing jobId/);
  });

  it('op=get with an unknown jobId -> ok:true, result:null', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-get-unknown',
      op: 'get',
      jobId: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    const resp = findResponse(link, 'r-get-unknown');
    expect(resp.ok).toBe(true);
    expect(resp.result).toBeNull();
  });

  it('op=get with a known jobId -> the job', () => {
    const job = jobs.create({
      name: 'gettable',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({ type: 'patch.jobs.request', requestId: 'r-get-known', op: 'get', jobId: job.id });
    const resp = findResponse(link, 'r-get-known');
    expect(resp.ok).toBe(true);
    expect((resp.result as { id: string }).id).toBe(job.id);
  });

  it('op=create with a malformed body -> invalid_input, nothing persisted', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-create-bad',
      op: 'create',
      body: { name: '' },
    });
    const resp = findResponse(link, 'r-create-bad');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
    expect(jobs.list()).toHaveLength(0);
  });

  it('op=create with a valid body -> ok, persisted', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-create-ok',
      op: 'create',
      body: {
        name: 'created-via-rpc',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      },
    });
    const resp = findResponse(link, 'r-create-ok');
    expect(resp.ok).toBe(true);
    expect(jobs.list()).toHaveLength(1);
  });

  it('op=patch with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-patch-missing', op: 'patch', body: {} });
    const resp = findResponse(link, 'r-patch-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
    expect(resp.error?.message).toMatch(/missing jobId/);
  });

  it('op=patch with a malformed body -> invalid_input', () => {
    const job = jobs.create({
      name: 'patch-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-patch-bad-body',
      op: 'patch',
      jobId: job.id,
      body: { trigger: { type: 'cron' } /* missing expression */ },
    });
    const resp = findResponse(link, 'r-patch-bad-body');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=patch with an unknown jobId -> not_found', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-patch-404',
      op: 'patch',
      jobId: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      body: { name: 'x' },
    });
    const resp = findResponse(link, 'r-patch-404');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('not_found');
    expect(resp.error?.message).toMatch(/job not found/);
  });

  it('op=patch with a valid body on a known job -> ok, applied', () => {
    const job = jobs.create({
      name: 'patch-target-2',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-patch-ok',
      op: 'patch',
      jobId: job.id,
      body: { name: 'renamed-via-rpc' },
    });
    const resp = findResponse(link, 'r-patch-ok');
    expect(resp.ok).toBe(true);
    expect((resp.result as { name: string }).name).toBe('renamed-via-rpc');
  });

  it('op=patch surfaces a JobValidationError (bad cron) as invalid_input, not internal', () => {
    const job = jobs.create({
      name: 'patch-bad-cron',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-patch-bad-cron',
      op: 'patch',
      jobId: job.id,
      body: { trigger: { type: 'cron', expression: 'not a real cron' } },
    });
    const resp = findResponse(link, 'r-patch-bad-cron');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
    expect(resp.error?.message).toMatch(/invalid cron/);
  });

  it('op=delete with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-delete-missing', op: 'delete' });
    const resp = findResponse(link, 'r-delete-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=delete with an unknown jobId -> not_found', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-delete-404',
      op: 'delete',
      jobId: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    const resp = findResponse(link, 'r-delete-404');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('not_found');
  });

  it('op=delete on a known jobId -> ok:true, gone from the store', () => {
    const job = jobs.create({
      name: 'delete-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-delete-ok',
      op: 'delete',
      jobId: job.id,
    });
    const resp = findResponse(link, 'r-delete-ok');
    expect(resp.ok).toBe(true);
    expect(resp.result).toBe(true);
    expect(jobs.get(job.id)).toBeNull();
  });

  it('op=enable with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-enable-missing', op: 'enable' });
    const resp = findResponse(link, 'r-enable-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=enable with an unknown jobId -> not_found', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-enable-404',
      op: 'enable',
      jobId: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    const resp = findResponse(link, 'r-enable-404');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('not_found');
  });

  it('op=enable on a known jobId -> ok, enabled:true', () => {
    const job = jobs.create({
      name: 'enable-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      enabled: false,
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-enable-ok',
      op: 'enable',
      jobId: job.id,
    });
    const resp = findResponse(link, 'r-enable-ok');
    expect(resp.ok).toBe(true);
    expect((resp.result as { enabled: boolean }).enabled).toBe(true);
  });

  it('op=disable with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-disable-missing', op: 'disable' });
    const resp = findResponse(link, 'r-disable-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=disable with an unknown jobId -> not_found', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-disable-404',
      op: 'disable',
      jobId: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    const resp = findResponse(link, 'r-disable-404');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('not_found');
  });

  it('op=disable on a known jobId -> ok, enabled:false', () => {
    const job = jobs.create({
      name: 'disable-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-disable-ok',
      op: 'disable',
      jobId: job.id,
    });
    const resp = findResponse(link, 'r-disable-ok');
    expect(resp.ok).toBe(true);
    expect((resp.result as { enabled: boolean }).enabled).toBe(false);
  });

  it('op=runs with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-runs-missing', op: 'runs' });
    const resp = findResponse(link, 'r-runs-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
    expect(resp.error?.message).toMatch(/invalid jobId/);
  });

  it('op=runs with a malformed jobId (fails JOB_ID_REGEX) -> invalid_input', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-runs-bad-id',
      op: 'runs',
      jobId: '../traversal',
    });
    const resp = findResponse(link, 'r-runs-bad-id');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=runs with a valid jobId -> the run log entries, honoring a custom limit', () => {
    const job = jobs.create({
      name: 'runs-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    logs.appendRun({ ts: 1, jobId: job.id, status: 'ok', trigger: 'cron' });
    logs.appendRun({ ts: 2, jobId: job.id, status: 'ok', trigger: 'cron' });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-runs-ok',
      op: 'runs',
      jobId: job.id,
      limit: 1,
    });
    const resp = findResponse(link, 'r-runs-ok');
    expect(resp.ok).toBe(true);
    expect(resp.result).toHaveLength(1);
  });

  it('op=runs without a limit defaults to 50', () => {
    const job = jobs.create({
      name: 'runs-default-limit',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    logs.appendRun({ ts: 1, jobId: job.id, status: 'ok', trigger: 'cron' });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-runs-default',
      op: 'runs',
      jobId: job.id,
    });
    const resp = findResponse(link, 'r-runs-default');
    expect(resp.ok).toBe(true);
    expect(resp.result).toHaveLength(1);
  });

  it('op=webhooks with no jobId -> invalid_input', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-webhooks-missing', op: 'webhooks' });
    const resp = findResponse(link, 'r-webhooks-missing');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=webhooks with a malformed jobId -> invalid_input', () => {
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-webhooks-bad-id',
      op: 'webhooks',
      jobId: '../traversal',
    });
    const resp = findResponse(link, 'r-webhooks-bad-id');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
  });

  it('op=webhooks with a valid jobId -> the webhook log entries, honoring a custom limit', () => {
    const job = jobs.create({
      name: 'webhooks-target',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    logs.appendWebhook({
      ts: 1,
      jobId: job.id,
      signature: 'ok',
      scheme: 'github',
      filter: 'pass',
      status: 200,
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-webhooks-ok',
      op: 'webhooks',
      jobId: job.id,
      limit: 10,
    });
    const resp = findResponse(link, 'r-webhooks-ok');
    expect(resp.ok).toBe(true);
    expect(resp.result).toHaveLength(1);
  });

  it('op=webhooks without a limit defaults to 50', () => {
    const job = jobs.create({
      name: 'webhooks-default-limit',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
    });
    logs.appendWebhook({
      ts: 1,
      jobId: job.id,
      signature: 'ok',
      scheme: 'github',
      filter: 'pass',
      status: 200,
    });
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-webhooks-default',
      op: 'webhooks',
      jobId: job.id,
    });
    const resp = findResponse(link, 'r-webhooks-default');
    expect(resp.ok).toBe(true);
    expect(resp.result).toHaveLength(1);
  });

  it('an unknown op falls through the exhaustiveness switch to invalid_input', () => {
    // Bypasses PatchJobsOp's type — simulates a future host sending an op
    // this server build doesn't know about yet (schema-side skew between
    // host and server versions).
    link.emit({
      type: 'patch.jobs.request',
      requestId: 'r-unknown-op',
      op: 'time-travel',
    } as unknown as WireEvent);
    const resp = findResponse(link, 'r-unknown-op');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('invalid_input');
    expect(resp.error?.message).toMatch(/unknown op: time-travel/);
  });

  it('a non-JobValidationError thrown by the underlying JobsInterface is reported as an internal error', () => {
    const throwingJobs: JobsInterface = {
      list: () => {
        throw new Error('boom: unexpected internal failure');
      },
      get: () => null,
      create: (body) => jobs.create(body),
      patch: (id, body) => jobs.patch(id, body),
      delete: (id) => jobs.delete(id),
      enable: (id) => jobs.enable(id),
      disable: (id) => jobs.disable(id),
      onChange: (h) => jobs.onChange(h),
    };
    // A dedicated link/bridge — reusing the shared `link` from beforeEach
    // would double-answer the same requestId (the real, non-throwing bridge
    // is still attached to it too).
    const throwingLink = new InProcessDaemonLink();
    const throwingUnsub = attachJobsRpcBridge({
      link: throwingLink,
      jobs: throwingJobs,
      logs,
      logger: silentLogger,
    });
    try {
      throwingLink.emit({ type: 'patch.jobs.request', requestId: 'r-internal', op: 'list' });
      const resp = findResponse(throwingLink, 'r-internal');
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe('internal');
      expect(resp.error?.message).toMatch(/boom: unexpected internal failure/);
    } finally {
      throwingUnsub();
    }
  });

  // TA3-14a. `patch.jobs.response` carries neither `daemonId` nor `chatId`, so
  // the routing `send()` fell through to `routeOf()`'s last resort — the
  // account's HOME machine. Every request originating anywhere else was
  // answered to the wrong host and hung until the caller's 10s timeout. The
  // reply must be addressed to the requester.
  it('replies to the REQUESTING machine, not the account home machine', () => {
    // The link's own (home) machine is `d1`; the request comes from `d2`.
    expect(link.daemonId()).toBe('d1');
    link.emit({ type: 'patch.jobs.request', requestId: 'r-from-d2', op: 'list' }, 'd2');
    const reply = link.sent.find(
      (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-from-d2',
    );
    expect(reply?.daemonId).toBe('d2');
  });

  it('replies to each requester independently when two machines ask at once', () => {
    link.emit({ type: 'patch.jobs.request', requestId: 'r-a', op: 'list' }, 'host-a');
    link.emit({ type: 'patch.jobs.request', requestId: 'r-b', op: 'list' }, 'host-b');
    const byId = (id: string) =>
      link.sent.find((s) => s.event.type === 'patch.jobs.response' && s.event.requestId === id);
    expect(byId('r-a')?.daemonId).toBe('host-a');
    expect(byId('r-b')?.daemonId).toBe('host-b');
  });

  it('drops a request with no originating machine — a reply could not be routed', () => {
    link.setDaemonId(null);
    link.emit({ type: 'patch.jobs.request', requestId: 'r-orphan', op: 'list' }, undefined);
    expect(
      link.sent.filter(
        (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-orphan',
      ),
    ).toHaveLength(0);
  });
});
