// MCP integration: connect a real Client to buildPatchToolsServer over an
// in-memory transport pair, list tools, invoke each, assert the response
// shape. Uses Fastify's `.inject()`-driven UDS shim by mocking the host
// socket — we monkey-patch httpRequest by listening on a real UDS for the
// fastify app, since the MCP tool handlers go through the actual UDS path.

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

// The socket is gated as a whole (spec/02 § Control IPC); the MCP child
// presents the host's local key as a Bearer on every call.
const LOCAL_KEY = 'test-local-key';

const silent = pino({ level: 'silent' });

describe('patch-tools MCP server — full client round-trip', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-mcp-int-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-mcp-folder-'));
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
    app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      listDevices: () => [
        {
          deviceId: 'kitchen',
          name: 'Kitchen',
          online: true,
          muted: false,
          lastUsedAt: 1_700_000_000_000,
        },
      ],
    });
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

  it('sends the one-sentence Pad instruction at initialize', () => {
    expect(client.getInstructions()).toBe(
      'To show a design or UI for the user to react to, use a Pad (patch_pad_create) instead of describing it.',
    );
  });

  it('listTools returns the full tool catalogue', async () => {
    const list = (await client.listTools()) as { tools: { name: string }[] };
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'patch_activity',
        'patch_artifact',
        'patch_ask_human',
        'patch_browser_click',
        'patch_browser_close',
        'patch_browser_fill_form',
        'patch_browser_key',
        'patch_browser_mouse',
        'patch_browser_open',
        'patch_browser_read',
        'patch_browser_screenshot',
        'patch_browser_select',
        'patch_browser_tabs',
        'patch_browser_type',
        'patch_browser_upload',
        'patch_call',
        'patch_cancel_wake',
        'patch_delegate',
        'patch_delegate_list',
        'patch_delegate_send',
        'patch_delegate_stop',
        'patch_doc_comment',
        'patch_doc_convert',
        'patch_doc_export',
        'patch_doc_reply',
        'patch_doc_suggest',
        'patch_goal_clear',
        'patch_goal_get',
        'patch_goal_set',
        'patch_history',
        'patch_job_create',
        'patch_job_delete',
        'patch_job_disable',
        'patch_job_enable',
        'patch_job_list',
        'patch_job_runs',
        'patch_job_update',
        'patch_job_webhooks',
        'patch_list_chats',
        'patch_list_devices',
        'patch_loop',
        'patch_notify',
        'patch_pad_create',
        'patch_pad_list',
        'patch_pad_reply',
        'patch_pad_update',
        'patch_peek',
        'patch_report',
        'patch_send_back',
        'patch_send_to',
        'patch_speak',
        'patch_spawn',
        'patch_stop',
        'patch_wake_me',
        'patch_watch',
        'patch_watch_list',
        'patch_watch_output',
        'patch_watch_stop',
        'view_file',
      ].sort(),
    );
  });

  it('patch_wake_me → patch_cancel_wake round-trips through the UDS endpoint', async () => {
    // Seed the calling chat (caller-1 is baked into the MCP server) so the
    // self-wake has a chat to target.
    metaStore.write({
      chatId: 'caller-1',
      folder,
      name: null,
      nextSeq: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const set = (await client.callTool({
      name: 'patch_wake_me',
      arguments: { message: 'go to bed', in: '1h' },
    })) as { content: { text: string }[] };
    const setRes = JSON.parse(set.content[0]!.text) as { ok: boolean; fireAt: number };
    expect(setRes.ok).toBe(true);
    expect(typeof setRes.fireAt).toBe('number');
    expect(daemon.peekWake('caller-1')?.message).toBe('go to bed');

    const cancel = (await client.callTool({
      name: 'patch_cancel_wake',
      arguments: {},
    })) as { content: { text: string }[] };
    const cancelRes = JSON.parse(cancel.content[0]!.text) as { ok: boolean; cancelled: boolean };
    expect(cancelRes).toEqual({ ok: true, cancelled: true });
    expect(daemon.peekWake('caller-1')).toBeNull();
  });

  it('patch_loop arms a recurring wake that patch_cancel_wake stops (same underlying timer)', async () => {
    metaStore.write({
      chatId: 'caller-1',
      folder,
      name: null,
      nextSeq: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const set = (await client.callTool({
      name: 'patch_loop',
      arguments: { message: 'check on the build', every: '5m' },
    })) as { content: { text: string }[] };
    const setRes = JSON.parse(set.content[0]!.text) as { ok: boolean; fireAt: number };
    expect(setRes.ok).toBe(true);
    const rec = daemon.peekWake('caller-1');
    expect(rec?.message).toBe('check on the build');
    expect(rec?.every).toBe(5 * 60_000);

    // Stopping a loop reuses patch_cancel_wake — no separate stop tool.
    const cancel = (await client.callTool({
      name: 'patch_cancel_wake',
      arguments: {},
    })) as { content: { text: string }[] };
    const cancelRes = JSON.parse(cancel.content[0]!.text) as { ok: boolean; cancelled: boolean };
    expect(cancelRes).toEqual({ ok: true, cancelled: true });
    expect(daemon.peekWake('caller-1')).toBeNull();
  });

  // patch_goal_set/get/clear need a REAL chatId in `daemon.chatState` (unlike
  // the wake tools above, `setGoal` refuses an unknown chat) — same reason
  // patch_notify/patch_call below build a freshly spawned chat + its own
  // MCP server rather than reusing the shared, never-spawned `caller-1`.
  it('patch_goal_set → patch_goal_get → patch_goal_clear round-trips through the UDS endpoint', async () => {
    const goalCallerId = await daemon.spawnChat({ folder });
    const serverG = buildPatchToolsServer({
      daemonSocketPath: socketPath,
      chatId: goalCallerId,
      localKey: LOCAL_KEY,
    });
    const [ctG, stG] = InMemoryTransport.createLinkedPair();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cG: any = new Client({ name: 'testG', version: '0.0.0' });
    await Promise.all([serverG.connect(stG), cG.connect(ctG)]);
    try {
      const set = (await cG.callTool({
        name: 'patch_goal_set',
        arguments: { condition: 'Ship the release by Friday' },
      })) as { content: { text: string }[] };
      const setRes = JSON.parse(set.content[0]!.text) as { ok: boolean; goal: string };
      expect(setRes).toEqual({ ok: true, goal: 'Ship the release by Friday' });
      expect(daemon.chatState.get(goalCallerId)?.goal).toBe('Ship the release by Friday');

      const get = (await cG.callTool({ name: 'patch_goal_get', arguments: {} })) as {
        content: { text: string }[];
      };
      const getRes = JSON.parse(get.content[0]!.text) as {
        ok: boolean;
        goal: string | null;
        goalProgress: { turnsEvaluated: number } | null;
      };
      expect(getRes.goal).toBe('Ship the release by Friday');
      expect(getRes.goalProgress?.turnsEvaluated).toBe(0);

      const clear = (await cG.callTool({ name: 'patch_goal_clear', arguments: {} })) as {
        content: { text: string }[];
      };
      const clearRes = JSON.parse(clear.content[0]!.text) as { ok: boolean; goal: string | null };
      expect(clearRes).toEqual({ ok: true, goal: null });
      expect(daemon.chatState.get(goalCallerId)?.goal).toBeNull();
    } finally {
      await cG.close();
    }
  });

  it('patch_wake_me rejects a missing in/at (400)', async () => {
    metaStore.write({
      chatId: 'caller-1',
      folder,
      name: null,
      nextSeq: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const res = (await client.callTool({
      name: 'patch_wake_me',
      arguments: { message: 'no delay given' },
    })) as { content: { text: string }[]; isError?: boolean };
    // The tool surfaces the host's 400 as an error result.
    const text = res.content[0]!.text;
    expect(text).toMatch(/exactly one|invalid_input|error/i);
  });

  it('patch_spawn → patch_peek → patch_send_to → patch_stop end-to-end', async () => {
    const spawn = (await client.callTool({
      name: 'patch_spawn',
      arguments: { folder },
    })) as { content: { text: string }[] };
    const spawned = JSON.parse(spawn.content[0]!.text) as { chatId: string };
    expect(typeof spawned.chatId).toBe('string');

    const peek = (await client.callTool({
      name: 'patch_peek',
      arguments: { chatId: spawned.chatId },
    })) as { content: { text: string }[] };
    const peeked = JSON.parse(peek.content[0]!.text) as {
      chat_state: { activity: string };
      events: unknown[];
      truncated: boolean;
    };
    expect(peeked.chat_state.activity).toBe('idle');
    expect(Array.isArray(peeked.events)).toBe(true);
    expect(typeof peeked.truncated).toBe('boolean');

    const sent = (await client.callTool({
      name: 'patch_send_to',
      arguments: { chatId: spawned.chatId, message: 'hi' },
    })) as { content: { text: string }[] };
    expect(JSON.parse(sent.content[0]!.text)).toEqual({ ok: true, queued: true });

    const stop = (await client.callTool({
      name: 'patch_stop',
      arguments: { chatId: spawned.chatId },
    })) as { content: { text: string }[] };
    expect(JSON.parse(stop.content[0]!.text)).toEqual({ ok: true });
  });

  it('patch_list_chats + patch_history return shape', async () => {
    const listed = (await client.callTool({
      name: 'patch_list_chats',
      arguments: {},
    })) as { content: { text: string }[] };
    const chats = JSON.parse(listed.content[0]!.text) as {
      chats: { chatId: string }[];
    };
    expect(Array.isArray(chats.chats)).toBe(true);
    expect(chats.chats.length).toBeGreaterThan(0);

    const hist = (await client.callTool({
      name: 'patch_history',
      arguments: { chatId: chats.chats[0]!.chatId },
    })) as { content: { text: string }[] };
    const parsed = JSON.parse(hist.content[0]!.text) as { events: unknown[] };
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  it('patch_activity surfaces the host 503 as a tool error when activity is not configured', async () => {
    // This file's shared `buildControl` call (beforeAll) doesn't pass
    // `getActivity` — the success path is covered end-to-end below, in its
    // own describe block with a configured one.
    const res = (await client.callTool({
      name: 'patch_activity',
      arguments: { since: 0, until: 1000 },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.content[0]!.text).toMatch(/activity not configured/i);
  });

  it('patch_list_devices returns registered devices with presence', async () => {
    const res = (await client.callTool({
      name: 'patch_list_devices',
      arguments: {},
    })) as { content: { text: string }[] };
    const parsed = JSON.parse(res.content[0]!.text) as {
      devices: { deviceId: string; name: string; online: boolean; muted: boolean }[];
    };
    expect(Array.isArray(parsed.devices)).toBe(true);
    expect(parsed.devices[0]).toMatchObject({
      deviceId: 'kitchen',
      name: 'Kitchen',
      online: true,
      muted: false,
    });
  });

  it('patch_job_create + list + delete via MCP', async () => {
    const created = (await client.callTool({
      name: 'patch_job_create',
      arguments: {
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder: '/work/bus', skill: 'bus-watch' },
        name: 'morning bus',
        // spec/08 § Groups — unlike `archived`, settable at birth.
        group: 'Home',
      },
    })) as { content: { text: string }[] };
    const { jobId } = JSON.parse(created.content[0]!.text) as { jobId: string };
    expect(typeof jobId).toBe('string');
    expect(JSON.parse(created.content[0]!.text).job.group).toBe('Home');

    const listed = (await client.callTool({
      name: 'patch_job_list',
      arguments: {},
    })) as { content: { text: string }[] };
    const { jobs: jl } = JSON.parse(listed.content[0]!.text) as {
      jobs: { id: string }[];
    };
    expect(jl.find((j) => j.id === jobId)).toBeDefined();

    const disabled = (await client.callTool({
      name: 'patch_job_disable',
      arguments: { jobId },
    })) as { content: { text: string }[] };
    expect(JSON.parse(disabled.content[0]!.text).job.enabled).toBe(false);

    const enabled = (await client.callTool({
      name: 'patch_job_enable',
      arguments: { jobId },
    })) as { content: { text: string }[] };
    expect(JSON.parse(enabled.content[0]!.text).job.enabled).toBe(true);

    const updated = (await client.callTool({
      name: 'patch_job_update',
      arguments: { jobId, name: 'renamed' },
    })) as { content: { text: string }[] };
    expect(JSON.parse(updated.content[0]!.text).job.name).toBe('renamed');

    // An agent can put a job away and bring it back (spec/08 § Archived jobs),
    // and archiving leaves `enabled` exactly as it was.
    const archived = (await client.callTool({
      name: 'patch_job_update',
      arguments: { jobId, archived: true },
    })) as { content: { text: string }[] };
    expect(JSON.parse(archived.content[0]!.text).job.archived).toBe(true);
    expect(JSON.parse(archived.content[0]!.text).job.enabled).toBe(true);

    const unarchived = (await client.callTool({
      name: 'patch_job_update',
      arguments: { jobId, archived: false },
    })) as { content: { text: string }[] };
    expect(JSON.parse(unarchived.content[0]!.text).job.archived).toBe(false);

    const del = (await client.callTool({
      name: 'patch_job_delete',
      arguments: { jobId },
    })) as { content: { text: string }[] };
    expect(JSON.parse(del.content[0]!.text)).toEqual({ ok: true });
  });

  // Regression (C2-12): patch_job_runs / patch_job_webhooks must CLAMP a
  // limit > 200 to the hard cap, not REJECT it at MCP-schema validation. The
  // spec says "capped at 200 regardless of the requested limit" — a .max(200)
  // on the tool schema would 32602 the limit:5000 call before the control-side
  // clamp (parseRunsLimit) ever runs. This test fails if .max(200) is
  // reinstated on either tool's inputSchema.
  it('patch_job_runs / patch_job_webhooks accept limit > 200 and clamp it', async () => {
    // A standalone UDS app whose jobs store records the limit it was asked for.
    const seen: { runs?: number; webhooks?: number } = {};
    const clampingJobs = {
      list: async () => [],
      create: async () => {
        throw new Error('unused');
      },
      patch: async () => {
        throw new Error('unused');
      },
      delete: async () => true,
      enable: async () => {
        throw new Error('unused');
      },
      disable: async () => {
        throw new Error('unused');
      },
      runs: async (_id: string, limit?: number) => {
        seen.runs = limit;
        return [];
      },
      webhooks: async (_id: string, limit?: number) => {
        seen.webhooks = limit;
        return [];
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app2: any = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs: clampingJobs as any,
    });
    const sock2 = join(home, 'daemon2.sock');
    await app2.listen({ path: sock2 });
    try {
      const server2 = buildPatchToolsServer({
        daemonSocketPath: sock2,
        chatId: 'caller-2',
        localKey: LOCAL_KEY,
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c2: any = new Client({ name: 'test2', version: '0.0.0' });
      await Promise.all([server2.connect(st), c2.connect(ct)]);

      const runsRes = (await c2.callTool({
        name: 'patch_job_runs',
        arguments: { jobId: 'j1', limit: 5000 },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(runsRes.isError).toBeFalsy();
      expect(JSON.parse(runsRes.content[0]!.text)).toEqual({ runs: [] });
      expect(seen.runs).toBe(200); // control-side parseRunsLimit clamp

      const hooksRes = (await c2.callTool({
        name: 'patch_job_webhooks',
        arguments: { jobId: 'j1', limit: 5000 },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(hooksRes.isError).toBeFalsy();
      expect(JSON.parse(hooksRes.content[0]!.text)).toEqual({ webhooks: [] });
      expect(seen.webhooks).toBe(200);

      await c2.close();
    } finally {
      await app2.close();
    }
  });

  // Every tool above was exercised with its OPTIONAL fields at their default
  // (omitted) — this test flips every one of those `!== undefined` spreads to
  // its TRUE side in one pass, so each tool's mcp.ts wrapper gets both branch
  // arms covered.
  it('every optional tool argument, set: limit/fromSeq/archived/voicePrefix/localId/name/prompt/at/notAfter/filter/trigger/action/enabled', async () => {
    const peeked = (await client.callTool({
      name: 'patch_peek',
      arguments: { chatId: 'caller-1', limit: 5 },
    })) as { content: { text: string }[]; isError?: boolean };
    // caller-1 was never spawned — a 404 is fine, we only care that the
    // `limit` query-param branch in mcp.ts's patch_peek wrapper was taken.
    expect(peeked.content[0]!.text).toMatch(/404|not_found/i);

    const spawned = (await client.callTool({
      name: 'patch_spawn',
      arguments: { folder, name: 'a named spawn', prompt: 'get going' },
    })) as { content: { text: string }[] };
    const { chatId: namedChatId } = JSON.parse(spawned.content[0]!.text) as { chatId: string };
    expect(typeof namedChatId).toBe('string');

    const sent = (await client.callTool({
      name: 'patch_send_to',
      arguments: {
        chatId: namedChatId,
        message: 'hi',
        voicePrefix: '[voice] ',
        localId: 'send-to-loc-1',
      },
    })) as { content: { text: string }[] };
    expect(JSON.parse(sent.content[0]!.text)).toEqual({ ok: true, queued: true });

    const hist = (await client.callTool({
      name: 'patch_history',
      arguments: { chatId: namedChatId, fromSeq: 0, limit: 10 },
    })) as { content: { text: string }[] };
    expect(Array.isArray((JSON.parse(hist.content[0]!.text) as { events: unknown[] }).events)).toBe(
      true,
    );

    const listed = (await client.callTool({
      name: 'patch_list_chats',
      arguments: { archived: 'include' },
    })) as { content: { text: string }[] };
    expect(Array.isArray((JSON.parse(listed.content[0]!.text) as { chats: unknown[] }).chats)).toBe(
      true,
    );

    // patch_wake_me with `at` (not `in`) AND `notAfter` both set.
    const farFuture = new Date(Date.now() + 3_600_000).toISOString();
    const wellPast = new Date(Date.now() - 3_600_000).toISOString();
    const wakeSet = (await client.callTool({
      name: 'patch_wake_me',
      arguments: { message: 'wake at a fixed time', at: farFuture, notAfter: wellPast },
    })) as { content: { text: string }[]; isError?: boolean };
    // `notAfter` in the past voids the wake — the host-side response shape
    // isn't the point here, only that mcp.ts forwarded both optional fields.
    expect(wakeSet.content[0]!.text.length).toBeGreaterThan(0);

    const jobCreated = (await client.callTool({
      name: 'patch_job_create',
      arguments: {
        trigger: { type: 'cron', expression: '0 8 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder, skill: 'x' },
        name: 'with a filter',
        filter: 'only when raining',
      },
    })) as { content: { text: string }[] };
    const { jobId: filteredJobId } = JSON.parse(jobCreated.content[0]!.text) as { jobId: string };

    const jobUpdated = (await client.callTool({
      name: 'patch_job_update',
      arguments: {
        jobId: filteredJobId,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', daemonId: 'd1', folder, skill: 'y' },
        filter: 'only when sunny',
        enabled: false,
      },
    })) as { content: { text: string }[] };
    const updatedJob = JSON.parse(jobUpdated.content[0]!.text) as {
      job: { enabled: boolean; filter: string | null };
    };
    expect(updatedJob.job.enabled).toBe(false);
    expect(updatedJob.job.filter).toBe('only when sunny');

    await client.callTool({ name: 'patch_job_delete', arguments: { jobId: filteredJobId } });
  });

  // patch_job_runs / patch_job_webhooks WITHOUT a limit — the clamping test
  // above always passes one, leaving the "no query params at all" path
  // (`qs` empty -> the bare, unparameterised URL) untested. Needs its own
  // jobs store (like the clamping test) since `MemoryJobsStore` doesn't
  // implement `runs`/`webhooks` at all.
  it('patch_job_runs / patch_job_webhooks with no limit at all', async () => {
    const seen: { runs?: number; webhooks?: number } = {};
    const noLimitJobs = {
      list: async () => [],
      create: async () => {
        throw new Error('unused');
      },
      patch: async () => {
        throw new Error('unused');
      },
      delete: async () => true,
      enable: async () => {
        throw new Error('unused');
      },
      disable: async () => {
        throw new Error('unused');
      },
      runs: async (_id: string, limit?: number) => {
        seen.runs = limit;
        return [];
      },
      webhooks: async (_id: string, limit?: number) => {
        seen.webhooks = limit;
        return [];
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app4: any = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: noLimitJobs as any });
    const sock4 = join(home, 'daemon4.sock');
    await app4.listen({ path: sock4 });
    try {
      const server4 = buildPatchToolsServer({
        daemonSocketPath: sock4,
        chatId: 'caller-4',
        localKey: LOCAL_KEY,
      });
      const [ct4, st4] = InMemoryTransport.createLinkedPair();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c4: any = new Client({ name: 'test4', version: '0.0.0' });
      await Promise.all([server4.connect(st4), c4.connect(ct4)]);

      const runs = (await c4.callTool({
        name: 'patch_job_runs',
        arguments: { jobId: 'j1' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(runs.isError).toBeFalsy();
      expect(JSON.parse(runs.content[0]!.text)).toEqual({ runs: [] });
      // No `limit` argument -> mcp.ts's URL carries no `?limit=` query param at
      // all; control.ts's own default (50) is what the store actually sees.
      expect(seen.runs).toBe(50);

      const webhooks = (await c4.callTool({
        name: 'patch_job_webhooks',
        arguments: { jobId: 'j1' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(webhooks.isError).toBeFalsy();
      expect(JSON.parse(webhooks.content[0]!.text)).toEqual({ webhooks: [] });
      expect(seen.webhooks).toBe(50);

      await c4.close();
    } finally {
      await app4.close();
    }
  });

  // patch_notify / patch_call — untouched by every test above. Both need a
  // REAL chatId in `daemon.chatState` as the caller (the shared `caller-1`
  // server was never spawned into chatState, only used for tools that don't
  // check chat existence), so this test spawns a fresh chat and builds a
  // second MCP server bound to it.
  it('patch_notify (with and without optional fields) and patch_call (with and without optional fields)', async () => {
    const notifyCallerId = await daemon.spawnChat({ folder });
    const server3 = buildPatchToolsServer({
      daemonSocketPath: socketPath,
      chatId: notifyCallerId,
      localKey: LOCAL_KEY,
    });
    const [ct3, st3] = InMemoryTransport.createLinkedPair();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c3: any = new Client({ name: 'test3', version: '0.0.0' });
    await Promise.all([server3.connect(st3), c3.connect(ct3)]);
    try {
      // importance + deepLink BOTH set. The agent no longer picks a channel:
      // it says what and how much, and the server routes it.
      const notifyFull = (await c3.callTool({
        name: 'patch_notify',
        arguments: {
          message: 'urgent ping',
          importance: 'urgent',
          deepLink: 'https://todoist.com/showTask?id=1',
        },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(JSON.parse(notifyFull.content[0]!.text)).toEqual({ ok: true });

      // No deepLink (the FALSE side of that spread).
      const notifyBare = (await c3.callTool({
        name: 'patch_notify',
        arguments: { message: 'a plain ping', importance: 'silent' },
      })) as { content: { text: string }[] };
      expect(JSON.parse(notifyBare.content[0]!.text)).toEqual({ ok: true });

      // spec/06 § `patch_notify` — quickReplies (≤2) round-trips through the
      // UDS endpoint.
      const notifyQuick = (await c3.callTool({
        name: 'patch_notify',
        arguments: {
          message: 'build failed, retry?',
          importance: 'normal',
          quickReplies: ['Yes', 'Snooze 10 min'],
        },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(JSON.parse(notifyQuick.content[0]!.text)).toEqual({ ok: true });

      // More than 2 quickReplies is rejected by the tool's own input schema —
      // the MCP SDK reports this as an error result, not a thrown call.
      const notifyTooMany = (await c3.callTool({
        name: 'patch_notify',
        arguments: { message: 'x', importance: 'normal', quickReplies: ['a', 'b', 'c'] },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(notifyTooMany.isError).toBeTruthy();

      // patch_speak names an act rather than choosing a delivery, so it is the
      // one place a channel is still pinned — to the speakers.
      const speak = (await c3.callTool({
        name: 'patch_speak',
        arguments: { message: 'the oven is done', deviceId: 'kitchen' },
      })) as { content: { text: string }[] };
      expect(JSON.parse(speak.content[0]!.text)).toEqual({ ok: true });

      // chatId + message BOTH set (rings a DIFFERENT chat than the caller).
      const otherChatId = await daemon.spawnChat({ folder });
      const callFull = (await c3.callTool({
        name: 'patch_call',
        arguments: { chatId: otherChatId, message: 'pick up' },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(callFull.isError).toBeFalsy();

      // Neither chatId nor message set (rings the caller itself, no message).
      const callBare = (await c3.callTool({ name: 'patch_call', arguments: {} })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(callBare.isError).toBeFalsy();
    } finally {
      await c3.close();
    }
  });
});

describe('patch_activity — full MCP round-trip with a configured getActivity', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-mcp-activity-'));
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: () => undefined,
    logger: silent,
  });
  const jobs = new MemoryJobsStore();
  const socketPath = join(home, 'daemon.sock');

  const calls: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      getActivity: async (callerChatId, since, until, messagesCursor, limit) => {
        calls.push({ callerChatId, since, until, messagesCursor, limit });
        return {
          messages: [
            {
              chatId: 'c2',
              chatName: 'bus watch',
              daemonId: 'd1',
              folder: '/tmp/bus',
              text: 'is it late',
              ts: 1_500,
            },
          ],
          messagesTruncated: false,
        };
      },
    });
    await app.listen({ path: socketPath });

    const server = buildPatchToolsServer({
      daemonSocketPath: socketPath,
      chatId: 'caller-activity-1',
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

  it('forwards since/until/cursors/limit and returns the enriched shape', async () => {
    const res = (await client.callTool({
      name: 'patch_activity',
      arguments: {
        since: 1_000,
        until: 5_000,
        messagesCursor: 1_200,
        limit: 50,
      },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text) as {
      messages: { chatId: string; text: string }[];
      messagesTruncated: boolean;
    };
    expect((parsed as Record<string, unknown>).chatSessions).toBeUndefined();
    expect(parsed.messages).toEqual([
      {
        chatId: 'c2',
        chatName: 'bus watch',
        daemonId: 'd1',
        folder: '/tmp/bus',
        text: 'is it late',
        ts: 1_500,
      },
    ]);
    expect(parsed.messagesTruncated).toBe(false);
    expect(calls).toEqual([
      {
        callerChatId: 'caller-activity-1',
        since: 1_000,
        until: 5_000,
        messagesCursor: 1_200,
        limit: 50,
      },
    ]);
  });

  it('omits optional cursors/limit from the request when not given', async () => {
    calls.length = 0;
    await client.callTool({ name: 'patch_activity', arguments: { since: 0, until: 100 } });
    expect(calls).toEqual([
      {
        callerChatId: 'caller-activity-1',
        since: 0,
        until: 100,
        messagesCursor: undefined,
        limit: undefined,
      },
    ]);
  });
});
