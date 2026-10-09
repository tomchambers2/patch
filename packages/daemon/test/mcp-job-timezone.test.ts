// spec/08 § Cron via the agent-facing surface: an agent writing a job with
// `patch_job_create` must be able to say WHICH ZONE its cron runs in, or every
// agent-authored schedule is silently UTC and a 9am job fires at 10am in BST.
//
// The trigger arrives as an opaque object (the MCP tool schema takes it
// `unknown` and lets the wire schema be the one gate), so what these tests pin
// is that the zone survives the whole path — MCP client → host UDS →
// JobCreateBody → store — and that an unresolvable one is refused with a
// message naming it rather than being demoted to UTC.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const LOCAL_KEY = 'test-local-key';
const silent = pino({ level: 'silent' });

const ACTION = { type: 'spawn', daemonId: 'd1', folder: '/work', skill: 'brief' } as const;

interface StoredJob {
  id: string;
  trigger: { type: string; expression: string; timezone?: string };
}

describe('patch_job_create / patch_job_update carry a cron timezone', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-mcp-tz-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-mcp-tz-folder-'));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: () => undefined,
    logger: silent,
  });
  const jobs = new MemoryJobsStore();
  const socketPath = join(home, 'daemon.sock');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs, listDevices: () => [] });
    await app.listen({ path: socketPath });
    const server = buildPatchToolsServer({
      daemonSocketPath: socketPath,
      chatId: 'caller-1',
      localKey: LOCAL_KEY,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  /** Call a tool and return its parsed JSON payload. */
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, never>> {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
    };
    return JSON.parse(res.content[0]!.text) as Record<string, never>;
  }

  it('creates a zoned cron job and stores the zone verbatim', async () => {
    const out = (await call('patch_job_create', {
      name: 'daily email update',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    })) as unknown as { jobId: string; job: StoredJob };
    expect(out.job.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
    // And it reads back the same way through patch_job_list.
    const listed = (await call('patch_job_list', {})) as unknown as { jobs: StoredJob[] };
    expect(listed.jobs.find((j) => j.id === out.jobId)?.trigger.timezone).toBe('Europe/London');
  });

  it('a trigger with no zone stays zone-less — nothing backfills it', async () => {
    const out = (await call('patch_job_create', {
      name: 'legacy',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    })) as unknown as { job: StoredJob };
    expect(out.job.trigger).toEqual({ type: 'cron', expression: '0 9 * * *' });
    expect('timezone' in out.job.trigger).toBe(false);
  });

  it('patch_job_update replaces the trigger wholesale, zone included', async () => {
    const created = (await call('patch_job_create', {
      name: 'to be rezoned',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    })) as unknown as { jobId: string };
    const updated = (await call('patch_job_update', {
      jobId: created.jobId,
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' },
    })) as unknown as { job: StoredJob };
    expect(updated.job.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'America/New_York',
    });
  });

  // NO FALLBACK. An agent that mistypes a zone must be told, not quietly
  // given a UTC schedule that fires an hour out for half the year.
  it('refuses an unresolvable zone, naming it, and stores nothing', async () => {
    const before = ((await call('patch_job_list', {})) as unknown as { jobs: StoredJob[] }).jobs
      .length;
    const res = (await client.callTool({
      name: 'patch_job_create',
      arguments: {
        name: 'bad zone',
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
        action: ACTION,
      },
    })) as { isError: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    // The message has to be actionable on its own: which field, which value.
    expect(res.content[0]!.text).toMatch(/invalid IANA timezone/);
    expect(res.content[0]!.text).toMatch(/Europe\/Landon/);
    expect(res.content[0]!.text).toMatch(/timezone/);
    const after = ((await call('patch_job_list', {})) as unknown as { jobs: StoredJob[] }).jobs
      .length;
    expect(after).toBe(before);
  });

  // The trigger is an opaque object in the tool schema, so the DESCRIPTION is
  // the only place an agent can learn the field exists. If it stops mentioning
  // the zone, agent-authored jobs go back to being silently UTC.
  it('the tool descriptions tell an agent the field exists', async () => {
    const list = (await client.listTools()) as {
      tools: { name: string; description?: string }[];
    };
    const create = list.tools.find((t) => t.name === 'patch_job_create');
    expect(create?.description).toMatch(/timezone/i);
    expect(create?.description).toMatch(/cron/i);
    const update = list.tools.find((t) => t.name === 'patch_job_update');
    expect(update?.description).toMatch(/trigger/i);
  });
});
