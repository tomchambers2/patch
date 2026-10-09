// Group 10 BLOCKER B.8: server-side daemon-link bridge for patch.jobs.*.
//
// Verifies a daemon-issued `patch.jobs.request` round-trips through the
// server's JobsInterface and produces a `patch.jobs.response` on the link.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

describe('jobs RPC bridge', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-jobs-bridge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('create via daemon-link RPC writes the file on the SERVER', async () => {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    try {
      // Host-side: emit a patch.jobs.request as if from RemoteJobsStore.
      const request: WireEvent = {
        type: 'patch.jobs.request',
        requestId: 'r-1',
        op: 'create',
        body: {
          name: 'morning bus',
          trigger: { type: 'cron', expression: '0 7 * * 1-5' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'check' },
        },
      };
      link.emit(request);
      // Server should have replied via link.send.
      const reply = link.sent.find(
        (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-1',
      );
      expect(reply).toBeDefined();
      if (!reply || reply.event.type !== 'patch.jobs.response') throw new Error('unreachable');
      expect(reply.event.ok).toBe(true);
      const result = reply.event.result as { id: string };
      expect(result.id).toMatch(/^j_/);
      // The job persisted on the server filesystem.
      expect(existsSync(join(dir, 'jobs', `${result.id}.json`))).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('not_found maps to error response', async () => {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    try {
      link.emit({
        type: 'patch.jobs.request',
        requestId: 'r-2',
        op: 'get',
        jobId: 'j_01H0000000000000000000000Z',
      });
      const reply = link.sent.find(
        (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-2',
      );
      expect(reply).toBeDefined();
      if (!reply || reply.event.type !== 'patch.jobs.response') throw new Error('unreachable');
      expect(reply.event.ok).toBe(true);
      // get returns null for unknown id, not an error.
      expect(reply.event.result).toBeNull();
    } finally {
      await built.app.close();
    }
  });

  // Issue #23: the agent-facing UDS surface (RemoteJobsStore -> this bridge)
  // MUST reject bad cron / JSONata at create time exactly like REST does. The
  // single semantic gate is JobStore.assertValidJobBody, so both surfaces stay
  // consistent and a bad-cron job is never silently persisted.
  it('rejects invalid cron expression with invalid_input (no persist)', async () => {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    try {
      link.emit({
        type: 'patch.jobs.request',
        requestId: 'r-cron',
        op: 'create',
        body: {
          name: 'bad cron',
          trigger: { type: 'cron', expression: 'not a cron' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        },
      });
      const reply = link.sent.find(
        (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-cron',
      );
      if (!reply || reply.event.type !== 'patch.jobs.response') throw new Error('unreachable');
      expect(reply.event.ok).toBe(false);
      expect(reply.event.error?.code).toBe('invalid_input');
      expect(reply.event.error?.message).toContain('invalid cron');
      // Nothing persisted on the server.
      expect(built.jobs.list()).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('rejects invalid JSONata filter with invalid_input (no persist)', async () => {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    try {
      link.emit({
        type: 'patch.jobs.request',
        requestId: 'r-jsonata',
        op: 'create',
        body: {
          name: 'bad filter',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          filter: 'payload.x = = bad',
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        },
      });
      const reply = link.sent.find(
        (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-jsonata',
      );
      if (!reply || reply.event.type !== 'patch.jobs.response') throw new Error('unreachable');
      expect(reply.event.ok).toBe(false);
      expect(reply.event.error?.code).toBe('invalid_input');
      expect(reply.event.error?.message).toContain('invalid JSONata');
      expect(built.jobs.list()).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('invalid_input on malformed body', async () => {
    const registry = Registry.load(dir);
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    try {
      link.emit({
        type: 'patch.jobs.request',
        requestId: 'r-3',
        op: 'create',
        body: { name: '' /* missing trigger + action */ },
      });
      const reply = link.sent.find(
        (s) => s.event.type === 'patch.jobs.response' && s.event.requestId === 'r-3',
      );
      expect(reply).toBeDefined();
      if (!reply || reply.event.type !== 'patch.jobs.response') throw new Error('unreachable');
      expect(reply.event.ok).toBe(false);
      expect(reply.event.error?.code).toBe('invalid_input');
    } finally {
      await built.app.close();
    }
  });
});
