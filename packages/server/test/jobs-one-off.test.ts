// One-off jobs (spec/08 § One-off jobs): a job that does its thing once and
// then retires itself.
//
// The expiry decision belongs to the DISPATCHER, at the moment a fire settles,
// because only there is the host's own outcome known. `ok` retires the job;
// `dispatch-error` must not, because a fire that never landed never did the
// thing the job exists to do. The store owns the write, so "already expired"
// is answered by the stored job rather than by dispatcher memory — which is
// what makes a second settle a genuine no-op.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobStore } from '../src/jobs/store.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

const TRIGGER = { type: 'cron', expression: '* * * * *' } as const;
const ACTION = { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' } as const;

describe('one-off jobs', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-oneoff-'));
    now = 1_000_000;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(): JobStore {
    return new JobStore({
      dataDir: dir,
      logger: silentLogger,
      watch: false,
      nowMs: () => now,
    });
  }

  // ---- store -------------------------------------------------------------

  describe('JobStore', () => {
    it('carries oneOff through create, and defaults to absent (recurring)', async () => {
      const store = makeStore();
      try {
        const oneOff = store.create({
          name: 'once',
          trigger: TRIGGER,
          action: ACTION,
          oneOff: true,
        });
        const recurring = store.create({ name: 'every day', trigger: TRIGGER, action: ACTION });
        expect(oneOff.oneOff).toBe(true);
        expect(recurring.oneOff).toBeUndefined();
        expect(oneOff.expiredAt).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    it('patch can make a job one-off and make it recurring again', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'j', trigger: TRIGGER, action: ACTION });
        expect(store.patch(job.id, { oneOff: true }).oneOff).toBe(true);
        expect(store.patch(job.id, { oneOff: false }).oneOff).toBe(false);
      } finally {
        await store.close();
      }
    });

    it('expireOneOff disables the job and stamps expiredAt', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'once', trigger: TRIGGER, action: ACTION, oneOff: true });
        const expired = store.expireOneOff(job.id, 4242);
        expect(expired).not.toBeNull();
        expect(expired?.enabled).toBe(false);
        expect(expired?.expiredAt).toBe(4242);
        // ...and it is persisted, not just returned.
        expect(store.get(job.id)?.expiredAt).toBe(4242);
      } finally {
        await store.close();
      }
    });

    it('expireOneOff is null (a no-op) for unknown / recurring / already-expired jobs', async () => {
      const store = makeStore();
      try {
        expect(store.expireOneOff('j_nope', 1)).toBeNull();

        const recurring = store.create({ name: 'daily', trigger: TRIGGER, action: ACTION });
        expect(store.expireOneOff(recurring.id, 1)).toBeNull();
        expect(store.get(recurring.id)?.expiredAt).toBeUndefined();
        expect(store.get(recurring.id)?.enabled).toBe(true);

        const once = store.create({ name: 'once', trigger: TRIGGER, action: ACTION, oneOff: true });
        expect(store.expireOneOff(once.id, 111)).not.toBeNull();
        expect(store.expireOneOff(once.id, 222)).toBeNull();
        // The SECOND call changed nothing — the first stamp stands.
        expect(store.get(once.id)?.expiredAt).toBe(111);
      } finally {
        await store.close();
      }
    });

    it('enabling an expired job re-arms it — an enabled job is never expired', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'once', trigger: TRIGGER, action: ACTION, oneOff: true });
        store.expireOneOff(job.id, 111);
        expect(store.get(job.id)?.expiredAt).toBe(111);

        const rearmed = store.enable(job.id);
        expect(rearmed.enabled).toBe(true);
        expect(rearmed.expiredAt).toBeUndefined();
        // Still one-off, so it can retire again.
        expect(rearmed.oneOff).toBe(true);
        expect(store.expireOneOff(job.id, 333)?.expiredAt).toBe(333);
      } finally {
        await store.close();
      }
    });

    it('disabling an expired job leaves the stamp alone', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'once', trigger: TRIGGER, action: ACTION, oneOff: true });
        store.expireOneOff(job.id, 111);
        expect(store.disable(job.id).expiredAt).toBe(111);
      } finally {
        await store.close();
      }
    });
  });

  // ---- dispatcher --------------------------------------------------------

  describe('dispatcher expiry', () => {
    function setup(job: Job): {
      link: InProcessDaemonLink;
      store: JobStore;
      disp: JobDispatcher;
      dispatchOnce: () => string;
    } {
      const link = new InProcessDaemonLink();
      const store = makeStore();
      const logs = new JobLogs(dir);
      let n = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        daemonLink: link,
        logger: silentLogger,
        logs,
        jobs: store,
        idGenerator: () => `fire${++n}`,
        ackTimeoutMs: 5_000,
        nowMs: () => now,
      });
      // Seed the real store with the job the dispatcher will be asked about.
      const seeded = store.create({
        name: job.name,
        trigger: job.trigger,
        action: job.action,
        ...(job.oneOff !== undefined ? { oneOff: job.oneOff } : {}),
      });
      const dispatchOnce = (): string => {
        const res = disp.dispatch({ ...seeded }, {}, 'cron');
        return res.event.chatId as string;
      };
      return { link, store, disp, dispatchOnce };
    }

    const ONE_OFF: Job = {
      id: 'seeded',
      name: 'once',
      enabled: true,
      trigger: TRIGGER,
      filter: null,
      action: ACTION,
      oneOff: true,
      createdAt: 1,
      updatedAt: 1,
    };

    it('a fire that settles ok retires the one-off job', async () => {
      const { link, store, disp, dispatchOnce } = setup(ONE_OFF);
      try {
        const jobId = store.list()[0]!.id;
        const chatId = dispatchOnce();
        expect(store.get(jobId)?.expiredAt).toBeUndefined();

        link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });

        const after = store.get(jobId);
        expect(after?.enabled).toBe(false);
        expect(after?.expiredAt).toBe(now);
      } finally {
        disp.close();
        await store.close();
      }
    });

    it('a fire that settles dispatch-error does NOT retire it — it never did its thing', async () => {
      const { link, store, disp, dispatchOnce } = setup(ONE_OFF);
      try {
        const jobId = store.list()[0]!.id;
        const chatId = dispatchOnce();

        link.emit({
          type: 'chat.error',
          chatId,
          error: { code: 'folder_not_found', message: 'no such folder: /work' },
          seq: -1,
        });

        const after = store.get(jobId);
        expect(after?.enabled).toBe(true);
        expect(after?.expiredAt).toBeUndefined();
      } finally {
        disp.close();
        await store.close();
      }
    });

    it('a recurring job is untouched by a fire settling ok', async () => {
      const { link, store, disp, dispatchOnce } = setup({ ...ONE_OFF, oneOff: undefined });
      try {
        const jobId = store.list()[0]!.id;
        const chatId = dispatchOnce();
        link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });

        const after = store.get(jobId);
        expect(after?.enabled).toBe(true);
        expect(after?.expiredAt).toBeUndefined();
      } finally {
        disp.close();
        await store.close();
      }
    });

    it('a SECOND fire settling ok is a no-op — the first stamp stands', async () => {
      const { link, store, disp, dispatchOnce } = setup(ONE_OFF);
      try {
        const jobId = store.list()[0]!.id;
        // Two fires in flight at once (no concurrency limit), as a burst
        // trigger would produce, then both settle ok.
        const chatA = dispatchOnce();
        const chatB = dispatchOnce();
        expect(chatA).not.toBe(chatB);

        link.emit({ type: 'chat.spawned', chatId: chatA, daemonId: 'd1', folder: '/work' });
        const firstStamp = store.get(jobId)?.expiredAt;
        expect(firstStamp).toBe(now);

        // Time moves on; the second settle must not re-stamp.
        now += 60_000;
        link.emit({ type: 'chat.spawned', chatId: chatB, daemonId: 'd1', folder: '/work' });

        expect(store.get(jobId)?.expiredAt).toBe(firstStamp);
        expect(store.get(jobId)?.enabled).toBe(false);
      } finally {
        disp.close();
        await store.close();
      }
    });

    it('expiry does not disturb the run log — both fires are still recorded', async () => {
      const { link, store, disp, dispatchOnce } = setup(ONE_OFF);
      const logs = new JobLogs(dir);
      try {
        const jobId = store.list()[0]!.id;
        const chatA = dispatchOnce();
        const chatB = dispatchOnce();
        link.emit({ type: 'chat.spawned', chatId: chatA, daemonId: 'd1', folder: '/work' });
        link.emit({ type: 'chat.spawned', chatId: chatB, daemonId: 'd1', folder: '/work' });

        const runs = logs.readRuns(jobId);
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.status === 'ok')).toBe(true);
      } finally {
        disp.close();
        await store.close();
      }
    });
  });

  // ---- REST --------------------------------------------------------------
  //
  // The schema tests prove the strict bodies accept `oneOff` and refuse
  // `expiredAt`; these prove the real HTTP surface is actually wired through
  // them, and that `oneOff` survives the round trip to the store.

  describe('REST /api/jobs', () => {
    async function bootstrap(): Promise<{
      built: Awaited<ReturnType<typeof buildAll>>;
      auth: { authorization: string };
    }> {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: user });
      registry.upsertSurface({
        surfaceId: 'srf-oneoff',
        surfaceKind: 'terminal',
        label: 'cli',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-oneoff',
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

    const BODY = { name: 'once', trigger: TRIGGER, action: ACTION };

    it('POST with oneOff:true creates a one-off job that reads back as one', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { ...BODY, oneOff: true },
        });
        expect(res.statusCode).toBe(201);
        const created = res.json() as Job;
        expect(created.oneOff).toBe(true);
        expect(created.expiredAt).toBeUndefined();

        const got = await built.app.inject({
          method: 'GET',
          url: `/api/jobs/${created.id}`,
          headers: auth,
        });
        expect((got.json() as Job).oneOff).toBe(true);
      } finally {
        await built.app.close();
      }
    });

    it('POST without oneOff still creates a recurring job', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: BODY,
        });
        expect(res.statusCode).toBe(201);
        expect((res.json() as Job).oneOff).toBeUndefined();
      } finally {
        await built.app.close();
      }
    });

    it('POST is REFUSED if a client tries to set expiredAt itself', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { ...BODY, oneOff: true, expiredAt: 123 },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });

    it('PATCH can flip oneOff, and is REFUSED if it carries expiredAt', async () => {
      const { built, auth } = await bootstrap();
      try {
        const created = (
          await built.app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: auth,
            payload: BODY,
          })
        ).json() as Job;

        const patched = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { oneOff: true },
        });
        expect(patched.statusCode).toBe(200);
        expect((patched.json() as Job).oneOff).toBe(true);

        const refused = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { expiredAt: 5 },
        });
        expect(refused.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });

    it('re-enabling an expired one-off over REST clears the stamp — it is armed again', async () => {
      const { built, auth } = await bootstrap();
      try {
        const created = (
          await built.app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: auth,
            payload: { ...BODY, oneOff: true },
          })
        ).json() as Job;

        // Retire it the only way anything can: the store's own write path.
        expect(built.jobs.expireOneOff(created.id, 999)).not.toBeNull();
        const expired = (
          await built.app.inject({
            method: 'GET',
            url: `/api/jobs/${created.id}`,
            headers: auth,
          })
        ).json() as Job;
        expect(expired.enabled).toBe(false);
        expect(expired.expiredAt).toBe(999);

        const rearmed = (
          await built.app.inject({
            method: 'PATCH',
            url: `/api/jobs/${created.id}`,
            headers: auth,
            payload: { enabled: true },
          })
        ).json() as Job;
        expect(rearmed.enabled).toBe(true);
        expect(rearmed.expiredAt).toBeUndefined();
        expect(rearmed.oneOff).toBe(true);
      } finally {
        await built.app.close();
      }
    });
  });
});
