// Group 9B: JobStore CRUD + atomic write + chokidar reload.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Job, JobCreateBody } from '../src/jobs/types.js';

/**
 * How long a test may wait for chokidar to notice a file change.
 *
 * These are POLLS that exit the moment the watcher fires, so a generous
 * ceiling costs nothing when the box is idle — it only decides how starved
 * the machine may get before a real watcher looks like a broken one. 8s was
 * not enough: vitest runs this package's files in parallel, and on a loaded
 * box the watcher simply does not get scheduled in time. It failed a deploy
 * that way (deploy-2026-10-06T10-46-48) while passing alone every time.
 * inotify itself was fine — 253k watches available, 7 in use.
 */
const WATCH_DEADLINE_MS = 30_000;

const silentLogger = pino({ level: 'silent' });

// How long the chokidar-reload test waits for the watcher to report. Generous
// on purpose: it only has to be longer than the worst starvation the parallel
// suite inflicts on the OS watcher, and it costs nothing when the event arrives
// promptly (the test resolves on the event, it does not sleep).
const WATCH_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;

// Paths that the mocked fs.readFileSync should fail for — set per-test,
// cleared in afterEach. Everything else delegates to the real fs module.
// Lets us deterministically exercise the read-failure catch branch in
// handleFsEvent (a real race between chokidar's event and the file being
// removed/locked) without a racy real-world filesystem trick.
const failReadFileFor = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      if (failReadFileFor.has(path)) throw new Error(`mocked read failure: ${path}`);
      return actual.readFileSync(...args);
    },
  };
});

const { JobStore } = await import('../src/jobs/store.js');

function sampleBody(name = 'test'): JobCreateBody {
  return {
    name,
    trigger: { type: 'cron', expression: '*/5 * * * *' },
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'hi' },
  };
}

describe('JobStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-jobs-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, lists, gets, patches, and deletes jobs', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(store.list()).toEqual([]);
      const job = store.create(sampleBody('first'));
      expect(job.id).toMatch(/^j_/);
      expect(job.enabled).toBe(true);
      expect(store.list()).toHaveLength(1);
      expect(store.get(job.id)).toEqual(job);

      const patched = store.patch(job.id, { name: 'renamed', enabled: false });
      expect(patched.name).toBe('renamed');
      expect(patched.enabled).toBe(false);
      expect(patched.updatedAt).toBeGreaterThanOrEqual(job.createdAt);

      expect(store.delete(job.id)).toBe(true);
      expect(store.list()).toEqual([]);
      expect(store.delete(job.id)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('persists jobs atomically and reloads from disk', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    const job = store.create(sampleBody());
    await store.close();
    // Files should be valid JSON, not partial.
    const files = readdirSync(join(dir, 'jobs'));
    expect(files).toContain(`${job.id}.json`);
    const raw = readFileSync(join(dir, 'jobs', `${job.id}.json`), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ id: job.id, name: 'test' });

    const store2 = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const reloaded = store2.get(job.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.name).toBe('test');
    } finally {
      await store2.close();
    }
  });

  it('emits onChange events for create / update / delete', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const events: string[] = [];
      store.onChange((e) => events.push(e.type));
      const job = store.create(sampleBody());
      store.patch(job.id, { name: 'x' });
      store.delete(job.id);
      expect(events).toEqual(['created', 'updated', 'deleted']);
    } finally {
      await store.close();
    }
  });

  it(
    'chokidar reloads on external file write',
    async () => {
      const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
      await store.watcherReady;
      try {
        // Resolve the moment the external job is reported, rather than polling on
        // a fixed deadline. chokidar's latency is at the mercy of the OS watcher
        // and of whatever else is on the CPU — the suite runs every package's
        // tests in parallel — so a fixed deadline was really asserting "the
        // machine was not busy", and it duly timed out on a loaded box. Waiting
        // on the event itself means the only way to fail is the reload never
        // happening, which is the thing this test actually claims.
        let seen!: () => void;
        const reloaded = new Promise<void>((resolve) => {
          seen = resolve;
        });
        store.onChange((e) => {
          if ((e.type === 'created' || e.type === 'updated') && e.job.id === 'j_external_1') seen();
        });
        const externalJob: Job = {
          id: 'j_external_1',
          name: 'external',
          enabled: true,
          trigger: { type: 'cron', expression: '0 * * * *' },
          filter: null,
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
          createdAt: 1,
          updatedAt: 1,
        };
        writeFileSync(
          join(dir, 'jobs', 'j_external_1.json'),
          JSON.stringify(externalJob, null, 2),
          'utf8',
        );
        let bail: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reloaded,
            new Promise<never>((_, reject) => {
              bail = setTimeout(
                () => reject(new Error('chokidar never reported the externally written job')),
                WATCH_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (bail) clearTimeout(bail);
        }
        expect(store.get('j_external_1')?.name).toBe('external');
      } finally {
        await store.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it('rejects schema-invalid JSON files at load time and skips them', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    writeFileSync(join(dir, 'jobs', 'bad.json'), '{ "not": "a job" }', 'utf8');
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(store.list()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('skips a load-time file whose JSON is simply malformed (not just schema-invalid)', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    writeFileSync(join(dir, 'jobs', 'broken.json'), '{ this is not json', 'utf8');
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(store.list()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('patch() on an unknown id throws (not a JobValidationError — a plain not-found error)', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(() => store.patch('j_does_not_exist', { name: 'x' })).toThrow(/job not found/);
    } finally {
      await store.close();
    }
  });

  it('a chokidar unlink event for an externally-deleted file emits "deleted" and drops it from cache', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      const externalJob: Job = {
        id: 'j_external_unlink',
        name: 'external',
        enabled: true,
        trigger: { type: 'cron', expression: '0 * * * *' },
        filter: null,
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        createdAt: 1,
        updatedAt: 1,
      };
      const path = join(dir, 'jobs', 'j_external_unlink.json');
      writeFileSync(path, JSON.stringify(externalJob, null, 2), 'utf8');
      // Wait for the 'add' to land it in the cache first.
      const addDeadline = Date.now() + WATCH_DEADLINE_MS;
      while (Date.now() < addDeadline && !store.get('j_external_unlink')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(store.get('j_external_unlink')).not.toBeNull();

      const events: string[] = [];
      store.onChange((e) => events.push(e.type));
      rmSync(path);
      const delDeadline = Date.now() + WATCH_DEADLINE_MS;
      while (Date.now() < delDeadline && store.get('j_external_unlink')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(store.get('j_external_unlink')).toBeNull();
      expect(events).toContain('deleted');
    } finally {
      await store.close();
    }
  });

  it('a self-write whose coalescing window has already expired is treated as an external change', async () => {
    let clock = 1_000_000;
    const store = new JobStore({
      dataDir: dir,
      logger: silentLogger,
      watch: true,
      nowMs: () => clock,
    });
    await store.watcherReady;
    try {
      const job = store.create({
        name: 'window-expiry',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
      });
      // Push the clock well past the 500ms self-write coalescing window
      // before the external rewrite lands, so handleFsEvent's deadline
      // check falls through (treats it as an external edit) instead of
      // suppressing it as our own write.
      clock += 10_000;
      const updated: Job = { ...job, name: 'renamed-externally', updatedAt: clock };
      const events: Array<{ type: string }> = [];
      store.onChange((e) => events.push(e));
      writeFileSync(join(dir, 'jobs', `${job.id}.json`), JSON.stringify(updated, null, 2), 'utf8');
      const deadline = Date.now() + WATCH_DEADLINE_MS;
      while (Date.now() < deadline && store.get(job.id)?.name !== 'renamed-externally') {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(store.get(job.id)?.name).toBe('renamed-externally');
      expect(events.some((e) => e.type === 'updated')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('a chokidar fs event with malformed JSON content is logged and ignored', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      const before = store.list();
      writeFileSync(join(dir, 'jobs', 'j_malformed_ext.json'), '{ not valid json', 'utf8');
      // Give chokidar a beat to process the add — it must NOT crash and must
      // NOT add anything to the store.
      await new Promise((r) => setTimeout(r, 500));
      expect(store.get('j_malformed_ext')).toBeNull();
      expect(store.list()).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it('a chokidar fs event whose JSON fails schema validation is logged and ignored', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      writeFileSync(
        join(dir, 'jobs', 'j_schema_bad.json'),
        JSON.stringify({ not: 'a valid job shape' }),
        'utf8',
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(store.get('j_schema_bad')).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('a chokidar fs event whose file cannot be read is logged and ignored (mocked read failure)', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      const path = join(dir, 'jobs', 'j_unreadable.json');
      failReadFileFor.add(path);
      writeFileSync(path, '{}', 'utf8');
      await new Promise((r) => setTimeout(r, 500));
      expect(store.get('j_unreadable')).toBeNull();
    } finally {
      failReadFileFor.clear();
      await store.close();
    }
  });

  it('enable() / disable() convenience methods flip the enabled flag', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const job = store.create(sampleBody('flip'));
      expect(job.enabled).toBe(true);
      const disabled = store.disable(job.id);
      expect(disabled.enabled).toBe(false);
      const enabled = store.enable(job.id);
      expect(enabled.enabled).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('patch() applies trigger / filter / action fields when provided (not just name/enabled)', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const job = store.create(sampleBody('full-patch'));
      const patched = store.patch(job.id, {
        trigger: { type: 'cron', expression: '0 8 * * *' },
        filter: 'payload.x = 1',
        action: { type: 'spawn', daemonId: 'd1', folder: '/elsewhere', prompt: 'new prompt' },
      });
      expect(patched.trigger).toEqual({ type: 'cron', expression: '0 8 * * *' });
      expect(patched.filter).toBe('payload.x = 1');
      expect(patched.action).toEqual({
        type: 'spawn',
        daemonId: 'd1',
        folder: '/elsewhere',
        prompt: 'new prompt',
      });
    } finally {
      await store.close();
    }
  });

  it('ignores non-.json files dropped into the jobs directory (chokidar add)', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      writeFileSync(join(dir, 'jobs', 'README.txt'), 'not a job file', 'utf8');
      await new Promise((r) => setTimeout(r, 500));
      expect(store.list()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('a chokidar watcher-level error is caught and logged, not thrown', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      // Simulate a real chokidar internal failure (e.g. ENOSPC, a permission
      // error watching the directory) by emitting on the underlying
      // FSWatcher directly — chokidar's watcher is a plain EventEmitter, and
      // this is the only way to exercise the wiring without inducing a real
      // OS-level watch failure (which isn't portable across CI environments).
      const watcher = (store as unknown as { watcher: { emit: (e: string, err: Error) => void } })
        .watcher;
      expect(() => watcher.emit('error', new Error('simulated watcher failure'))).not.toThrow();
    } finally {
      await store.close();
    }
  });

  it('ignores non-.json files already present in the jobs directory at load time', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    writeFileSync(join(dir, 'jobs', '.DS_Store'), 'not a job', 'utf8');
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(store.list()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('onChange() returns an unsubscribe function that stops future notifications', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const events: string[] = [];
      const unsub = store.onChange((e) => events.push(e.type));
      store.create(sampleBody('before-unsub'));
      unsub();
      store.create(sampleBody('after-unsub'));
      expect(events).toEqual(['created']);
    } finally {
      await store.close();
    }
  });

  it('an unlink of a bare ".json" file (empty id after stripping the extension) is a no-op, not a crash', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: true });
    await store.watcherReady;
    try {
      const bogusPath = join(dir, 'jobs', '.json');
      writeFileSync(bogusPath, '{}', 'utf8');
      // Wait for the 'add' to be processed (it'll be ignored — schema
      // rejection at best — before we delete it).
      await new Promise((r) => setTimeout(r, 500));
      const events: string[] = [];
      store.onChange((e) => events.push(e.type));
      rmSync(bogusPath);
      await new Promise((r) => setTimeout(r, 500));
      // No "deleted" event — there was never a cache entry keyed by "" to
      // remove, and handleFsEvent must not throw.
      expect(events).not.toContain('deleted');
    } finally {
      await store.close();
    }
  });

  it('an onChange handler that throws is caught + logged, and does not stop other handlers', async () => {
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const order: string[] = [];
      store.onChange(() => {
        order.push('first-throws');
        throw new Error('handler boom');
      });
      store.onChange((e) => order.push(`second-${e.type}`));
      expect(() =>
        store.create({
          name: 'emit-throws',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: { type: 'spawn', daemonId: 'd1', folder: '/x', prompt: 'x' },
        }),
      ).not.toThrow();
      expect(order).toEqual(['first-throws', 'second-created']);
    } finally {
      await store.close();
    }
  });
});
