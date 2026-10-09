// Autonomy prompt (spec/08 § Autonomy prompt): text prepended to a job's
// first user-turn. Default unless customised — there is no "off" state — so
// what has to round-trip is the store (create/patch/clear-via-null/reload),
// the REST surface, and the DISPATCHER actually prefacing the rendered
// prompt with it.

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
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '../src/jobs/types.js';
import type { Job } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

const TRIGGER = { type: 'cron', expression: '0 7 * * *' } as const;
const ACTION = { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' } as const;

describe('job autonomy prompt', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-autonomy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- store ---------------------------------------------------------

  describe('JobStore', () => {
    function makeStore(): JobStore {
      return new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    }

    it('a new job carries no override unless one is given at creation', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'j', trigger: TRIGGER, action: ACTION });
        expect(job.autonomyPrompt).toBeUndefined();

        const custom = store.create({
          name: 'j2',
          trigger: TRIGGER,
          action: ACTION,
          autonomyPrompt: 'Be quick.',
        });
        expect(custom.autonomyPrompt).toBe('Be quick.');
      } finally {
        await store.close();
      }
    });

    it('patch sets, changes, and clears (via null) the override', async () => {
      const store = makeStore();
      try {
        const job = store.create({ name: 'j', trigger: TRIGGER, action: ACTION });
        expect(store.patch(job.id, { autonomyPrompt: 'First.' }).autonomyPrompt).toBe('First.');
        expect(store.get(job.id)?.autonomyPrompt).toBe('First.');
        expect(store.patch(job.id, { autonomyPrompt: 'Second.' }).autonomyPrompt).toBe('Second.');
        // `null` is the explicit "back to default" instruction — omitting the
        // key would leave the override alone instead.
        expect(store.patch(job.id, { autonomyPrompt: null }).autonomyPrompt).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    it('a customised job survives a reload from disk', async () => {
      const first = makeStore();
      let id: string;
      try {
        id = first.create({
          name: 'j',
          trigger: TRIGGER,
          action: ACTION,
          autonomyPrompt: 'Be quick.',
        }).id;
      } finally {
        await first.close();
      }
      const second = makeStore();
      try {
        expect(second.get(id)?.autonomyPrompt).toBe('Be quick.');
      } finally {
        await second.close();
      }
    });

    it('patching an unrelated field leaves an existing override alone', async () => {
      const store = makeStore();
      try {
        const job = store.create({
          name: 'j',
          trigger: TRIGGER,
          action: ACTION,
          autonomyPrompt: 'Be quick.',
        });
        const patched = store.patch(job.id, { enabled: false });
        expect(patched.autonomyPrompt).toBe('Be quick.');
      } finally {
        await store.close();
      }
    });
  });

  // ---- REST ------------------------------------------------------------

  describe('REST /api/jobs', () => {
    async function bootstrap(): Promise<{
      built: Awaited<ReturnType<typeof buildAll>>;
      auth: { authorization: string };
    }> {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: user });
      registry.upsertSurface({
        surfaceId: 'srf-autonomy',
        surfaceKind: 'terminal',
        label: 'cli',
        issuedAt: 1,
      });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-autonomy',
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

    it('POST creates a job carrying its custom prompt', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { name: 'j', trigger: TRIGGER, action: ACTION, autonomyPrompt: 'Be quick.' },
        });
        expect(res.statusCode).toBe(201);
        expect((res.json() as Job).autonomyPrompt).toBe('Be quick.');
      } finally {
        await built.app.close();
      }
    });

    it('PATCH sets, and null clears, the override', async () => {
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
        expect(created.autonomyPrompt).toBeUndefined();

        const patched = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { autonomyPrompt: 'Be quick.' },
        });
        expect(patched.statusCode).toBe(200);
        expect((patched.json() as Job).autonomyPrompt).toBe('Be quick.');

        const cleared = await built.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}`,
          headers: auth,
          payload: { autonomyPrompt: null },
        });
        expect((cleared.json() as Job).autonomyPrompt).toBeUndefined();
      } finally {
        await built.app.close();
      }
    });

    it('rejects an empty string with 400', async () => {
      const { built, auth } = await bootstrap();
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: auth,
          payload: { name: 'j', trigger: TRIGGER, action: ACTION, autonomyPrompt: '' },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await built.app.close();
      }
    });
  });

  // ---- dispatcher --------------------------------------------------------

  describe('JobDispatcher.withAutonomyPrompt', () => {
    function makeJob(overrides: Partial<Job> = {}): Job {
      return {
        id: 'j_autonomy',
        name: 'test',
        enabled: true,
        trigger: TRIGGER,
        filter: null,
        action: ACTION,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      };
    }

    it('prefaces a prompt-only first turn with the default when uncustomised', () => {
      const out = JobDispatcher.withAutonomyPrompt(
        ACTION,
        'go',
        makeJob(),
        DEFAULT_JOB_AUTONOMY_PROMPT,
      );
      expect(out).toBe(`${DEFAULT_JOB_AUTONOMY_PROMPT}\n\ngo`);
    });

    it("prefaces with the job's custom override instead of the default", () => {
      const out = JobDispatcher.withAutonomyPrompt(
        ACTION,
        'go',
        { autonomyPrompt: 'Just get on with it.' },
        DEFAULT_JOB_AUTONOMY_PROMPT,
      );
      expect(out).toBe('Just get on with it.\n\ngo');
    });

    it('inserts the prompt AFTER the /<skill> line, so it stays a recognisable slash command', () => {
      const out = JobDispatcher.withAutonomyPrompt(
        { type: 'spawn', daemonId: 'd1', folder: '/x', skill: 'bus-watch' },
        '/bus-watch\n\n{"payload":{}}',
        makeJob(),
        DEFAULT_JOB_AUTONOMY_PROMPT,
      );
      expect(out).toBe(`/bus-watch\n\n${DEFAULT_JOB_AUTONOMY_PROMPT}\n\n{"payload":{}}`);
    });

    it('a script action passes the rendered text through untouched (no chat to preface)', () => {
      const scriptAction = {
        type: 'script',
        daemonId: 'd1',
        folder: '/x',
        command: 'true',
      } as const;
      expect(
        JobDispatcher.withAutonomyPrompt(scriptAction, '', makeJob(), DEFAULT_JOB_AUTONOMY_PROMPT),
      ).toBe('');
    });

    it('an action with no skill and empty rendered text stays empty — nothing to preface', () => {
      const bareAction = { type: 'spawn', daemonId: 'd1', folder: '/x' } as const;
      expect(
        JobDispatcher.withAutonomyPrompt(bareAction, '', makeJob(), DEFAULT_JOB_AUTONOMY_PROMPT),
      ).toBe('');
    });

    it('an uncustomised job is prefaced with the ACCOUNT prompt passed in, not the built-in default', () => {
      const out = JobDispatcher.withAutonomyPrompt(ACTION, 'go', makeJob(), 'House rule.');
      expect(out).toBe('House rule.\n\ngo');
    });

    it("a job's own override beats the account prompt", () => {
      const out = JobDispatcher.withAutonomyPrompt(
        ACTION,
        'go',
        { autonomyPrompt: 'Mine.' },
        'House rule.',
      );
      expect(out).toBe('Mine.\n\ngo');
    });

    it('end-to-end: an edit to the account prompt reaches the NEXT fire of an uncustomised job', () => {
      const link = new InProcessDaemonLink();
      let account = 'First rule.';
      let n = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => `fire-${n++}`,
        autonomyPrompt: () => account,
      });
      try {
        const job = makeJob();
        disp.dispatch(job, { firedAt: '1' }, 'cron');
        account = 'Second rule.';
        disp.dispatch(job, { firedAt: '2' }, 'cron');
        const prompts = link.sent.flatMap((s) =>
          s.event.type === 'chat.spawn_request' ? [s.event.prompt] : [],
        );
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('First rule.\n\ngo');
        expect(prompts[1]).toContain('Second rule.\n\ngo');
      } finally {
        disp.close();
      }
    });

    it("end-to-end: a customised job's fire carries its own text, not the default", () => {
      const link = new InProcessDaemonLink();
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fixed-autonomy',
      });
      try {
        const job = makeJob({ autonomyPrompt: 'Be quick.' });
        disp.dispatch(job, { firedAt: '2026-01-01' }, 'cron');
        const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
        expect(sent).toBeDefined();
        if (sent && sent.event.type === 'chat.spawn_request') {
          expect(sent.event.prompt).toContain('Be quick.\n\ngo');
        }
      } finally {
        disp.close();
      }
    });
  });
});
