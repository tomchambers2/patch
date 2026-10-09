// Groups (spec/08 § Groups): a free-text organisational label on a job.
// Purely cosmetic — it never affects whether or how a job fires, so unlike
// jobs-archive.test.ts there is nothing to prove at the cron/ingress layer.
// What has to round-trip is the store (JSON-on-disk) and the REST surface
// (create/patch/list), same as `group` on any other job field.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobStore } from '../src/jobs/store.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

const TRIGGER = { type: 'cron', expression: '0 7 * * *' } as const;
const ACTION = { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' } as const;

describe('job groups', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-group-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- store -------------------------------------------------------------

  describe('JobStore', () => {
    function makeStore(): JobStore {
      return new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    }

    it('a new job carries no group unless one is given at creation', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'j', trigger: TRIGGER, action: ACTION });
        expect(job.group).toBeUndefined();

        const grouped = store.create({
          name: 'j2',
          trigger: TRIGGER,
          action: ACTION,
          group: 'Home',
        });
        expect(grouped.group).toBe('Home');
      } finally {
        await store.close();
      }
    });

    it('patch sets, changes, and clears the group', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'j', trigger: TRIGGER, action: ACTION });
        expect(store.patch(job.id, { group: 'Finance' }).group).toBe('Finance');
        expect(store.get(job.id)?.group).toBe('Finance');
        expect(store.patch(job.id, { group: 'Watchers' }).group).toBe('Watchers');
        expect(store.patch(job.id, { group: '' }).group).toBe('');
      } finally {
        await store.close();
      }
    });

    it('a grouped job survives a reload from disk', async () => {
      const first = makeStore();
      let id: string;
      try {
        id = first.create({ name: 'j', trigger: TRIGGER, action: ACTION, group: 'Home' }).id;
      } finally {
        await first.close();
      }
      const second = makeStore();
      try {
        expect(second.get(id)?.group).toBe('Home');
      } finally {
        await second.close();
      }
    });

    it('patching an unrelated field leaves an existing group alone', async () => {
      const store = makeStore();
      try {
        const job = store.create({
          name: 'j',
          trigger: TRIGGER,
          action: ACTION,
          group: 'Home',
        });
        const patched = store.patch(job.id, { enabled: false });
        expect(patched.group).toBe('Home');
      } finally {
        await store.close();
      }
    });
  });

  // ---- REST --------------------------------------------------------------

  describe('REST /api/jobs', () => {
    async function bootstrap(): Promise<{
      built: Awaited<ReturnType<typeof buildAll>>;
      auth: { authorization: string };
    }> {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: user });
      registry.upsertSurface({
        surfaceId: 'srf-group',
        surfaceKind: 'terminal',
        label: 'cli',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-group',
        surfaceKind: 'terminal',
        label: 'cli',
      });
      const built = await buildAll({
        logger: false,
        registry,
        daemonLink: new InProcessDaemonLink(),
      });
      return { built, auth: { authorization: `Bearer ${jwt}` } };
    }

    it('POST creates a job carrying its group', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { name: 'j', trigger: TRIGGER, action: ACTION, group: 'Home' },
        });
        expect(res.statusCode).toBe(201);
        expect((res.json() as Job).group).toBe('Home');
      } finally {
        await built.app.close();
      }
    });

    it('PATCH sets the group, and the job reads back that way', async () => {
      const { built, auth } = await bootstrap();
      try {
        const created = (
          await built.app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: auth,
            payload: { name: 'j', trigger: TRIGGER, action: ACTION },
          })
        ).json() as Job;
        expect(created.group).toBeUndefined();

        const patched = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { group: 'Watchers' },
        });
        expect(patched.statusCode).toBe(200);
        expect((patched.json() as Job).group).toBe('Watchers');

        const fetched = await built.app.inject({
          method: 'GET',
          url: `/api/jobs/${created.id}`,
          headers: auth,
        });
        expect((fetched.json() as Job).group).toBe('Watchers');
      } finally {
        await built.app.close();
      }
    });

    it("GET /api/jobs list returns each job's group", async () => {
      const { built, auth } = await bootstrap();
      try {
        await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { name: 'a', trigger: TRIGGER, action: ACTION, group: 'Home' },
        });
        await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { name: 'b', trigger: TRIGGER, action: ACTION },
        });

        const listed = (
          await built.app.inject({ method: 'GET', url: '/api/jobs', headers: auth })
        ).json() as { jobs: Job[] };
        const a = listed.jobs.find((j) => j.name === 'a');
        const b = listed.jobs.find((j) => j.name === 'b');
        expect(a?.group).toBe('Home');
        expect(b?.group).toBeUndefined();
      } finally {
        await built.app.close();
      }
    });

    it('rejects a non-string group with 400', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { name: 'j', trigger: TRIGGER, action: ACTION, group: 5 },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });
  });
});
