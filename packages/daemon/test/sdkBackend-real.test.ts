// Coverage for the REAL @anthropic-ai/claude-agent-sdk backend in sdkBackend.ts
// (`createRealSdkBackend`). Unlike sdk-apikey-strip.test.ts /
// disallowed-tools.test.ts / no-system-prompt-injection.test.ts (which each use
// a single top-level `vi.mock` and inspect one option), this file exercises the
// FULL set of code paths: `translateSdkMessage`'s branches, `oneShotRun`'s
// option wiring, `loadSdk`'s cache/failure branches, and — the bulk of it —
// `persistentRun` / `openPersistSession` (session open/reuse/reopen, the
// streaming-input `notify` handshake, abort → `interrupt()`, thrown/`done`
// query results, and the idle-timeout close).
//
// We never touch a real Claude account: `@anthropic-ai/claude-agent-sdk` is
// replaced per-test with `vi.doMock` (module factory, NOT hoisted) so each test
// can script its own fake `query()`. Because `sdkBackend.ts` caches the loaded
// SDK module and the open persistent sessions in MODULE-SCOPED variables, every
// test calls `vi.resetModules()` before re-mocking + re-importing so it gets a
// clean module instance (matching the `vi.doMock` + dynamic-import pattern
// already used in oauth-gate.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type QueryFactory = (args: { prompt: unknown; options: Record<string, unknown> }) => unknown;

// `loadSdk` prefers the backend PROVISIONED on the machine (spec/02 § Agent
// backends) over the ambient package. Point every test at an empty patch home
// so what it exercises is the mocked bare specifier, and never whatever this
// developer's own machine happens to have provisioned.
let emptyPatchHome: string;
let priorPatchHome: string | undefined;

async function loadRealBackend(queryImpl: QueryFactory) {
  vi.resetModules();
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryImpl }));
  return import('../src/sdkBackend.js');
}

beforeEach(() => {
  emptyPatchHome = mkdtempSync(join(tmpdir(), 'patch-home-empty-'));
  priorPatchHome = process.env['PATCH_HOME'];
  process.env['PATCH_HOME'] = emptyPatchHome;
});

afterEach(() => {
  vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  vi.resetModules();
  vi.useRealTimers();
  delete process.env['PATCH_PERSISTENT_SESSIONS'];
  if (priorPatchHome === undefined) delete process.env['PATCH_HOME'];
  else process.env['PATCH_HOME'] = priorPatchHome;
  rmSync(emptyPatchHome, { recursive: true, force: true });
});

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('createRealSdkBackend — one-shot path: translateSdkMessage branches', () => {
  it('translates every SDK message shape the real backend can encounter', async () => {
    const messages: unknown[] = [
      // non-object / null → system fallback
      null,
      42,
      // stream_event → text_delta happy path
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
      },
      // stream_event → delta.type !== 'text_delta'
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'other_delta' } },
      },
      // stream_event → text_delta but text is not a string
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 123 } },
      },
      // stream_event → delta is not an object
      { type: 'stream_event', event: { type: 'content_block_delta', delta: 'nope' } },
      // stream_event → event.type !== 'content_block_delta'
      { type: 'stream_event', event: { type: 'message_start' } },
      // stream_event → event is not an object
      { type: 'stream_event', event: 'nope' },
      // stream_event → no event key at all
      { type: 'stream_event' },
      // result → session_id + result both strings
      { type: 'result', session_id: 'sess1', result: 'done text' },
      // result → neither present
      { type: 'result' },
      // assistant → multi-block text concatenation + session_id
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'World' },
          ],
        },
        session_id: 'sess2',
      },
      // assistant → malformed tool_use block (no `name`) is skipped; the
      // happy-path tool_use → `tool_use` envelope is covered by its own test
      // below (translateSdkMessage returns an array, so it can't be spliced
      // into this flat "one message → one envelope" fixture list).
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] },
      },
      // assistant → content is not an array
      { type: 'assistant', message: { role: 'assistant', content: 'nope' } },
      // assistant → message is not an object
      { type: 'assistant', message: 'nope' },
      // assistant → no message key
      { type: 'assistant' },
      // assistant → block in array is not an object
      { type: 'assistant', message: { role: 'assistant', content: [42] } },
      // assistant → block.type === 'text' but text is not a string
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 5 }] } },
      // user → passthrough
      { type: 'user' },
      // unrecognised type → system fallback
      { type: 'weird-unknown-type' },
      // rate_limit_event → five_hour maps to the "session" window
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.82,
          resetsAt: 1_800_000_000_000,
        },
      },
      // rate_limit_event → seven_day maps to the "week" window
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1 },
      },
      // rate_limit_event → per-model/overage detail is not "session, week"; ignored
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.4 },
      },
      // rate_limit_event → malformed rate_limit_info still yields a safe system envelope
      { type: 'rate_limit_event', rate_limit_info: 'nope' },
    ];

    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        for (const m of messages) yield m;
      })();
    });

    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );

    expect(out).toHaveLength(messages.length);
    expect(out[0]).toMatchObject({ type: 'system', raw: null });
    expect(out[1]).toMatchObject({ type: 'system', raw: 42 });
    expect(out[2]).toMatchObject({ type: 'assistant_delta', content: 'Hi ' });
    expect(out[3]).toMatchObject({ type: 'system' });
    expect(out[4]).toMatchObject({ type: 'system' });
    expect(out[5]).toMatchObject({ type: 'system' });
    expect(out[6]).toMatchObject({ type: 'system' });
    expect(out[7]).toMatchObject({ type: 'system' });
    expect(out[8]).toMatchObject({ type: 'system' });
    expect(out[9]).toMatchObject({ type: 'result', sessionId: 'sess1', content: 'done text' });
    expect(out[10]).toMatchObject({ type: 'result', sessionId: undefined, content: undefined });
    expect(out[11]).toMatchObject({
      type: 'assistant',
      content: 'Hello World',
      sessionId: 'sess2',
    });
    expect(out[12]).toMatchObject({ type: 'assistant', content: '' });
    expect(out[13]).toMatchObject({ type: 'assistant', content: '' });
    expect(out[14]).toMatchObject({ type: 'assistant', content: '' });
    expect(out[15]).toMatchObject({ type: 'assistant', content: '' });
    expect(out[16]).toMatchObject({ type: 'assistant', content: '' });
    expect(out[17]).toMatchObject({ type: 'assistant', content: '' });
    expect(out[18]).toMatchObject({ type: 'user' });
    expect(out[19]).toMatchObject({ type: 'system' });
    expect(out[20]).toMatchObject({
      type: 'system',
      rateLimit: {
        scope: 'session',
        window: { status: 'allowed_warning', utilization: 0.82, resetsAt: 1_800_000_000_000 },
      },
    });
    expect(out[21]).toMatchObject({
      type: 'system',
      rateLimit: { scope: 'week', window: { status: 'allowed', utilization: 0.1 } },
    });
    expect(out[22]).toMatchObject({ type: 'system' });
    expect((out[22] as { rateLimit?: unknown }).rateLimit).toBeUndefined();
    expect(out[23]).toMatchObject({ type: 'system' });
    expect((out[23] as { rateLimit?: unknown }).rateLimit).toBeUndefined();
  });

  it('reuses the cached SDK module across two run() calls (loadSdk cache branch)', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out1 = await drain(
      backend.run({ prompt: 'a', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    const out2 = await drain(
      backend.run({ prompt: 'b', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect(out1).toHaveLength(1);
    expect(out2).toHaveLength(1);
  });

  // A live tool call (Bash, AskUserQuestion, etc.) must reach the surface as it
  // happens, not only be recoverable retroactively from the JSONL transcript on
  // reconnect/replay (history.ts's `jsonlLineToWire`). One SDK `assistant`
  // message can carry narration text AND a `tool_use` block — both must come
  // out, in order, as separate envelopes.
  it('splits an assistant message into a text envelope + a tool_use envelope, in order', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check that.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
          session_id: 'sess1',
        };
        yield { type: 'result', session_id: 'sess1' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      type: 'assistant',
      content: 'Let me check that.',
      sessionId: 'sess1',
    });
    expect(out[1]).toMatchObject({
      type: 'tool_use',
      tool: { name: 'Bash', args: { command: 'ls' }, callId: 'toolu_1' },
    });
    expect(out[2]).toMatchObject({ type: 'result' });
  });

  it('splits a multi-tool_use assistant message into one tool_use envelope per block', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } },
              { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/b' } },
            ],
          },
        };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    // Both tool_use blocks come out; the empty text between/around them is
    // suppressed by chatRunner (not here — translateSdkMessage still emits it,
    // chatRunner drops empty-content envelopes downstream).
    const toolUses = out.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]).toMatchObject({ tool: { name: 'Read', callId: 'toolu_1' } });
    expect(toolUses[1]).toMatchObject({ tool: { name: 'Read', callId: 'toolu_2' } });
  });

  it('translates a tool_result block on a user message into a tool_result envelope', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'file 1\nfile 2',
                is_error: false,
              },
            ],
          },
        };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'tool_result',
      toolResult: { name: 'tool', callId: 'toolu_1', result: 'file 1\nfile 2' },
    });
    expect((out[0] as { toolResult?: { isError?: unknown } }).toolResult?.isError).toBeUndefined();
  });

  it('names a tool_result after the matching tool_use seen earlier in the same run', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
          },
        };
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }],
          },
        };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    const result = out.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ toolResult: { name: 'Bash', callId: 'toolu_1' } });
  });

  it('marks a failed tool_result with isError: true', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      return (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
            ],
          },
        };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect(out[0]).toMatchObject({ type: 'tool_result', toolResult: { isError: true } });
  });
});

describe('createRealSdkBackend — one-shot option wiring', () => {
  it('omits model + mcpServers when unset and defaults permissionMode; includes them when set', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown; options: Record<string, unknown> });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();

    await drain(
      backend.run({ prompt: 'a', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect('model' in calls[0]!.options).toBe(false);
    expect(calls[0]!.options['permissionMode']).toBe('auto');
    expect(calls[0]!.options['mcpServers']).toBeUndefined();

    await drain(
      backend.run({
        prompt: 'b',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        model: 'claude-opus',
        permissionMode: 'plan',
        mcpServer: { command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
        extraMcpServers: [
          {
            name: 'playwright',
            command: 'npx',
            args: ['@playwright/mcp@latest', '--headless'],
            env: {},
          },
          { name: 'my-tools', command: '/opt/tools', args: [], env: { TOKEN: 't' } },
        ],
      }),
    );
    expect(calls[1]!.options['model']).toBe('claude-opus');
    expect(calls[1]!.options['permissionMode']).toBe('plan');
    // `patch` (this host's own tools) FIRST, then the host's enabled MCP
    // servers in list order (Settings → MCP), each as a stdio server.
    const servers = calls[1]!.options['mcpServers'] as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['patch', 'playwright', 'my-tools']);
    expect(servers).toEqual({
      patch: { type: 'stdio', command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
        env: {},
      },
      'my-tools': { type: 'stdio', command: '/opt/tools', args: [], env: { TOKEN: 't' } },
    });
  });

  it('wires patch alone when the host has no enabled MCP servers, and nothing without mcpServer', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown; options: Record<string, unknown> });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();

    await drain(
      backend.run({
        prompt: 'a',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        mcpServer: { command: 'node', args: ['server.js'], env: {} },
      }),
    );
    expect(calls[0]!.options['mcpServers']).toEqual({
      patch: { type: 'stdio', command: 'node', args: ['server.js'], env: {} },
    });

    await drain(
      backend.run({
        prompt: 'b',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        mcpServer: { command: 'node', args: ['server.js'], env: {} },
        extraMcpServers: [],
      }),
    );
    expect(calls[1]!.options['mcpServers']).toEqual({
      patch: { type: 'stdio', command: 'node', args: ['server.js'], env: {} },
    });

    // No patch tools server configured: the extras do not ride alone.
    await drain(
      backend.run({
        prompt: 'c',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        extraMcpServers: [{ name: 'my-tools', command: '/opt/tools', args: [], env: {} }],
      }),
    );
    expect(calls[2]!.options['mcpServers']).toBeUndefined();
  });

  it('passes opts.settings through to the SDK query options (Memory + CLAUDE.md toggles)', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown; options: Record<string, unknown> });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();

    await drain(
      backend.run({ prompt: 'a', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect('settings' in calls[0]!.options).toBe(false);

    await drain(
      backend.run({
        prompt: 'b',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        settings: {
          autoMemoryEnabled: false,
          claudeMdExcludes: ['/tmp/threads/manager/CLAUDE.md'],
        },
      }),
    );
    expect(calls[1]!.options['settings']).toEqual({
      autoMemoryEnabled: false,
      claudeMdExcludes: ['/tmp/threads/manager/CLAUDE.md'],
    });
  });

  it('passes opts.settingSources through to the SDK query options on the one-shot path', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown; options: Record<string, unknown> });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const base = { cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' };

    await drain(backend.run({ prompt: 'a', ...base }));
    expect('settingSources' in calls[0]!.options).toBe(false);

    await drain(backend.run({ prompt: 'b', ...base, settingSources: [] }));
    expect(calls[1]!.options['settingSources']).toEqual([]);

    await drain(backend.run({ prompt: 'c', ...base, settingSources: ['user', 'project'] }));
    expect(calls[2]!.options['settingSources']).toEqual(['user', 'project']);
  });

  it('omits canUseTool when onPermissionRequest is unset; wires it and translates allow/deny when set', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown; options: Record<string, unknown> });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();

    // No onPermissionRequest supplied (auto/bypassPermissions turns) — the
    // real SDK must not be given a canUseTool at all.
    await drain(
      backend.run({ prompt: 'a', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect('canUseTool' in calls[0]!.options).toBe(false);

    // onPermissionRequest supplied (a blocking mode) — canUseTool is wired
    // and correctly translates the host's {approve, updatedInput?} into
    // the SDK's PermissionResult shape in both directions.
    const requests: Array<{ tool: string; args: Record<string, unknown>; description?: string }> =
      [];
    await drain(
      backend.run({
        prompt: 'b',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        onPermissionRequest: async (req) => {
          requests.push(req);
          return req.tool === 'Bash'
            ? { approve: false }
            : { approve: true, updatedInput: { edited: true } };
        },
      }),
    );
    const canUseTool = calls[1]!.options['canUseTool'] as (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { description?: string },
    ) => Promise<Record<string, unknown>>;
    expect(typeof canUseTool).toBe('function');

    const denied = await canUseTool(
      'Bash',
      { command: 'echo hi' },
      { description: 'Run: echo hi' },
    );
    expect(denied).toEqual({ behavior: 'deny', message: 'Permission denied by user' });
    expect(requests[0]).toEqual({
      tool: 'Bash',
      args: { command: 'echo hi' },
      description: 'Run: echo hi',
    });

    const allowed = await canUseTool('Edit', { file_path: 'a.txt' }, {});
    expect(allowed).toEqual({ behavior: 'allow', updatedInput: { edited: true } });
  });
});

describe('createRealSdkBackend — where the agent backend comes from', () => {
  it('says the ARTIFACT is incomplete when the SDK will not load', () => {
    // The SDK is the host's own library dependency and ships inside the
    // artifact (scripts/build-daemon.mjs copies it beside daemon.mjs). It is not
    // something a machine is expected to have, so "install it on this host" is
    // the wrong advice — a build that cannot load it is a broken build.
    // Asserted on the source rather than by breaking the import, because the
    // monorepo always resolves it.
    const src = readFileSync(new URL('../src/sdkBackend.ts', import.meta.url), 'utf8');
    expect(src).toContain('ships inside the');
    expect(src).toContain('reinstall the host');
    expect(src).not.toContain('provisionedAgentSdkEntry');
  });

  it("runs every query against the MACHINE's claude, not a bundled one", async () => {
    // spec/02 § Agent backends: "a host runs the same `claude` the user runs".
    // The artifact carries ~4 MB of library and never the ~200 MB CLI, so
    // without this option the SDK looks for a platform package that isn't there
    // and dies with "Native CLI binary for <platform> not found".
    const claude = join(emptyPatchHome, 'bin', 'claude');
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, '#!/bin/sh\n');
    chmodSync(claude, 0o755);
    const prior = process.env['CLAUDE_CODE_PATH'];
    process.env['CLAUDE_CODE_PATH'] = claude;
    try {
      const calls: Array<{ options: Record<string, unknown> }> = [];
      const { createRealSdkBackend } = await loadRealBackend((args) => {
        calls.push(args as { options: Record<string, unknown> });
        return (async function* () {
          yield { type: 'result', session_id: 's' };
        })();
      });
      const ac = new AbortController();
      await drain(
        createRealSdkBackend().run({
          prompt: 'x',
          cwd: '/tmp',
          abortController: ac,
          oauthAccessToken: 'tok',
        }),
      );
      expect(calls[0]!.options['pathToClaudeCodeExecutable']).toBe(claude);
    } finally {
      if (prior === undefined) delete process.env['CLAUDE_CODE_PATH'];
      else process.env['CLAUDE_CODE_PATH'] = prior;
    }
  });
});

describe('realRun — one-shot vs persistent dispatch', () => {
  it('uses oneShotRun when PATCH_PERSISTENT_SESSIONS is unset', async () => {
    delete process.env['PATCH_PERSISTENT_SESSIONS'];
    const calls: Array<{ prompt: unknown }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    await drain(
      backend.run({
        prompt: 'a',
        cwd: '/tmp',
        chatId: 'c1',
        abortController: ac,
        oauthAccessToken: 'tok',
      }),
    );
    // oneShotRun passes the raw prompt STRING; persistentRun passes an async
    // generator. A string here proves the one-shot path was taken.
    expect(calls[0]!.prompt).toBe('a');
  });

  it('uses oneShotRun when chatId is undefined even with PATCH_PERSISTENT_SESSIONS=1', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    const calls: Array<{ prompt: unknown }> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      calls.push(args as { prompt: unknown });
      return (async function* () {
        yield { type: 'result', session_id: 's' };
      })();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    await drain(
      backend.run({ prompt: 'a', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    );
    expect(calls[0]!.prompt).toBe('a');
  });
});

// ---- persistentRun / openPersistSession ------------------------------------
//
// The persistent-session `input()` async generator only progresses when
// something actually iterates the `prompt` passed to `query()`. Each fake
// query below performs a "read-ahead": after consuming the currently-queued
// user message it immediately requests the NEXT one from `prompt` too (this is
// exactly what a real streaming-input SDK does — it keeps its stdin reader
// primed). That read-ahead call suspends inside `input()`'s
// `await new Promise((r) => (notify = r))`, so the FOLLOWING `push()` (next
// turn) or `end()` (session teardown) genuinely exercises the `notify?.()`
// branch, not just the always-null case.
describe('createRealSdkBackend — persistent sessions (PATCH_PERSISTENT_SESSIONS=1)', () => {
  it('passes opts.settingSources through to the SDK query options on the persistent path', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    vi.useFakeTimers();
    const openedOptions: Array<Record<string, unknown>> = [];
    const { createRealSdkBackend } = await loadRealBackend((args) => {
      openedOptions.push(args.options);
      const capturedPrompt = args.prompt as AsyncGenerator<unknown>;
      return {
        interrupt: vi.fn(async () => undefined),
        next: async () => {
          await capturedPrompt.next();
          return { done: false, value: { type: 'result', session_id: 's' } };
        },
      };
    });
    const backend = createRealSdkBackend();
    const run = (chatId: string, extra: Record<string, unknown>) =>
      drain(
        backend.run({
          prompt: 'p',
          cwd: '/tmp/a',
          chatId,
          abortController: new AbortController(),
          oauthAccessToken: 'tok',
          ...extra,
        }),
      );

    await run('chat-unset', {});
    expect('settingSources' in openedOptions[0]!).toBe(false);

    await run('chat-empty', { settingSources: [] });
    expect(openedOptions[1]!['settingSources']).toEqual([]);

    await run('chat-some', { settingSources: ['project'] });
    expect(openedOptions[2]!['settingSources']).toEqual(['project']);
  });

  it('opens fresh, reuses same-cwd, reopens on cwd change, and the idle timer closes stale sessions (both branches of the delete-on-timeout guard)', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    vi.useFakeTimers();

    let opens = 0;
    const openedOptions: Array<Record<string, unknown>> = [];
    const queryFactory: QueryFactory = (args) => {
      opens += 1;
      openedOptions.push(args.options);
      const sessionIndex = opens;
      const capturedPrompt = args.prompt as AsyncGenerator<unknown>;
      let turn = 0;
      let pending: Promise<IteratorResult<unknown>> | null = null;
      return {
        interrupt: vi.fn(async () => undefined),
        next: async () => {
          const p = pending ?? capturedPrompt.next();
          pending = null;
          await p;
          turn += 1;
          // Read-ahead so the NEXT push()/end() on this session hits `notify`.
          pending = capturedPrompt.next();
          return {
            done: false,
            value: { type: 'result', session_id: `sess-${sessionIndex}-${turn}` },
          };
        },
      };
    };
    const { createRealSdkBackend } = await loadRealBackend(queryFactory);
    const backend = createRealSdkBackend();

    // Turn 1: fresh session, cwd A.
    const out1 = await drain(
      backend.run({
        prompt: 'turn1',
        cwd: '/tmp/a',
        chatId: 'chat-1',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    );
    expect(opens).toBe(1);
    expect(out1).toEqual([
      { type: 'result', sessionId: 'sess-1-1', content: undefined, raw: expect.anything() },
    ]);

    // Turn 2: SAME cwd → reused, no new query() call.
    const out2 = await drain(
      backend.run({
        prompt: 'turn2',
        cwd: '/tmp/a',
        chatId: 'chat-1',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    );
    expect(opens).toBe(1);
    expect(out2).toEqual([
      { type: 'result', sessionId: 'sess-1-2', content: undefined, raw: expect.anything() },
    ]);

    // Turn 3: DIFFERENT cwd → old session ended, a new one opened. Also passes
    // `model`, covering openPersistSession's `opts.model !== undefined` branch
    // (turn 1 already covered the undefined/omitted case).
    const out3 = await drain(
      backend.run({
        prompt: 'turn3',
        cwd: '/tmp/b',
        chatId: 'chat-1',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        model: 'claude-opus',
      }),
    );
    expect(opens).toBe(2);
    expect(out3).toEqual([
      { type: 'result', sessionId: 'sess-2-1', content: undefined, raw: expect.anything() },
    ]);
    expect(openedOptions[0]!['model']).toBeUndefined();
    expect('model' in openedOptions[0]!).toBe(false);
    expect(openedOptions[1]!['model']).toBe('claude-opus');

    // Advance past PERSIST_IDLE_MS (120_000ms): fires the dangling idle timer
    // left over from session #1 (its `persistSessions.get(chatId) === s` check
    // is now FALSE, since the map holds session #2 — false branch) AND session
    // #2's own idle timer (still the current session → TRUE branch → deleted).
    await vi.advanceTimersByTimeAsync(120_001);

    // Turn 4 on the ORIGINAL cwd: the old session is gone either way, and the
    // map is now empty (session #2 was deleted by its own idle timer) → opens fresh.
    const out4 = await drain(
      backend.run({
        prompt: 'turn4',
        cwd: '/tmp/a',
        chatId: 'chat-1',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    );
    expect(opens).toBe(3);
    expect(out4).toEqual([
      { type: 'result', sessionId: 'sess-3-1', content: undefined, raw: expect.anything() },
    ]);
  });

  it('wires the same mcpServers (patch + the enabled extras) into openPersistSession as the one-shot path', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    const openedOptions: Array<Record<string, unknown>> = [];
    const queryFactory: QueryFactory = (args) => {
      openedOptions.push(args.options);
      const capturedPrompt = args.prompt as AsyncGenerator<unknown>;
      return {
        interrupt: vi.fn(async () => undefined),
        next: async () => {
          await capturedPrompt.next();
          return { done: false, value: { type: 'result', session_id: 'sess-1' } };
        },
      };
    };
    const { createRealSdkBackend } = await loadRealBackend(queryFactory);
    const backend = createRealSdkBackend();

    await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        chatId: 'chat-mcp',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        mcpServer: { command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
        extraMcpServers: [
          {
            name: 'playwright',
            command: 'npx',
            args: ['@playwright/mcp@latest', '--headless'],
            env: {},
          },
          { name: 'my-tools', command: '/opt/tools', args: [], env: { TOKEN: 't' } },
        ],
      }),
    );
    expect(openedOptions[0]!['mcpServers']).toEqual({
      patch: { type: 'stdio', command: 'node', args: ['server.js'], env: { FOO: 'bar' } },
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
        env: {},
      },
      'my-tools': { type: 'stdio', command: '/opt/tools', args: [], env: { TOKEN: 't' } },
    });
  });

  it('a session that ends (done:true) without ever emitting a result is dropped, not reused', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    let opens = 0;
    const queryFactory: QueryFactory = (args) => {
      opens += 1;
      const capturedPrompt = args.prompt as AsyncGenerator<unknown>;
      let served = false;
      return {
        interrupt: vi.fn(async () => undefined),
        next: async () => {
          if (!served) {
            served = true;
            await capturedPrompt.next();
            return {
              done: false,
              value: {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
              },
            };
          }
          return { done: true, value: undefined };
        },
      };
    };
    const { createRealSdkBackend } = await loadRealBackend(queryFactory);
    const backend = createRealSdkBackend();

    const out = await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        chatId: 'chat-done',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    );
    expect(opens).toBe(1);
    expect(out).toEqual([
      { type: 'assistant', content: 'partial', sessionId: undefined, raw: expect.anything() },
    ]);

    // Same chatId + cwd again: since the prior session was dropped on `done`,
    // this MUST open a fresh one rather than reuse.
    await drain(
      backend.run({
        prompt: 'again',
        cwd: '/tmp',
        chatId: 'chat-done',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    );
    expect(opens).toBe(2);
  });

  it('a query.next() rejection drops the session and rethrows (caller sees the error)', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    let opens = 0;
    const boom = new Error('sdk exploded');
    const queryFactory: QueryFactory = (args) => {
      opens += 1;
      const capturedPrompt = args.prompt as AsyncGenerator<unknown>;
      return {
        interrupt: vi.fn(async () => undefined),
        next: async () => {
          await capturedPrompt.next();
          throw boom;
        },
      };
    };
    const { createRealSdkBackend } = await loadRealBackend(queryFactory);
    const backend = createRealSdkBackend();

    await expect(
      drain(
        backend.run({
          prompt: 'hi',
          cwd: '/tmp',
          chatId: 'chat-err',
          abortController: new AbortController(),
          oauthAccessToken: 'tok',
        }),
      ),
    ).rejects.toThrow('sdk exploded');
    expect(opens).toBe(1);

    // Broken session was dropped: the next turn on the same chat reopens.
    await expect(
      drain(
        backend.run({
          prompt: 'again',
          cwd: '/tmp',
          chatId: 'chat-err',
          abortController: new AbortController(),
          oauthAccessToken: 'tok',
        }),
      ),
    ).rejects.toThrow('sdk exploded');
    expect(opens).toBe(2);
  });

  it('aborting mid-turn calls query.interrupt() (and swallows a rejected interrupt) without killing the process', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    const interrupt = vi.fn(async () => {
      throw new Error('interrupt failed');
    });
    let resolveNext!: (v: { done: boolean; value: unknown }) => void;
    const hanging = new Promise<{ done: boolean; value: unknown }>((r) => {
      resolveNext = r;
    });
    let nextCalled = false;
    const queryFactory: QueryFactory = () => ({
      interrupt,
      next: () => {
        nextCalled = true;
        return hanging;
      },
    });
    const { createRealSdkBackend } = await loadRealBackend(queryFactory);
    const backend = createRealSdkBackend();
    const ac = new AbortController();

    const gen = backend.run({
      prompt: 'hi',
      cwd: '/tmp',
      chatId: 'chat-abort',
      abortController: ac,
      oauthAccessToken: 'tok',
    });
    const resultPromise = gen.next();

    // Let the generator body run up to the (hanging) `s.query.next()` call —
    // the abort listener is registered BEFORE that call, so once `next()` has
    // been invoked we know the listener is live. Getting there crosses a real
    // dynamic `import()` (loadSdk()) the first time, which needs actual
    // event-loop ticks, not just microtasks — so poll with a macrotask yield
    // (bounded, to fail fast instead of hanging if something regresses).
    for (let i = 0; i < 200 && !nextCalled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(nextCalled).toBe(true);
    ac.abort();
    // Give the fire-and-forget `interrupt().catch(...)` a microtask to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(interrupt).toHaveBeenCalledTimes(1);

    // Unblock the hanging next() so the turn completes and the test can end.
    resolveNext({ done: true, value: undefined });
    const settled = await resultPromise;
    expect(settled.done).toBe(true);
  });

  it('wires canUseTool into openPersistSession the same way as the one-shot path', async () => {
    process.env['PATCH_PERSISTENT_SESSIONS'] = '1';
    const openedOptions: Array<Record<string, unknown>> = [];
    const queryFactory: QueryFactory = (args) => {
      openedOptions.push(args.options);
      const capturedPrompt = args.prompt as AsyncGenerator<unknown>;
      return {
        interrupt: vi.fn(async () => undefined),
        next: async () => {
          await capturedPrompt.next();
          return { done: false, value: { type: 'result', session_id: 'sess-1' } };
        },
      };
    };
    const { createRealSdkBackend } = await loadRealBackend(queryFactory);
    const backend = createRealSdkBackend();

    await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        chatId: 'chat-canusetool',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        onPermissionRequest: async () => ({ approve: true }),
      }),
    );
    expect(typeof openedOptions[0]!['canUseTool']).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Permission-mode downgrade (spec/02 § Permission mode)
//
// Claude Code resolves `--permission-mode` against gates patch cannot see (the
// server-side auto-mode circuit breaker; whether the model supports the mode)
// and, where the mode is unavailable, SUBSTITUTES `default` without saying so.
// `default` asks for approval on every tool call, which for an unattended job
// chat is not a degraded mode but a dead one — it stalls forever in a chat
// nobody is watching. The `system`/`init` message carries the mode Claude Code
// actually resolved, so the substitution is detectable on the very first
// message, before any tool has run. Patch fails the turn there.
// ---------------------------------------------------------------------------
describe('createRealSdkBackend — permission mode is honoured or the turn dies', () => {
  const initWith = (mode: string): unknown => ({
    type: 'system',
    subtype: 'init',
    permissionMode: mode,
    session_id: 'sess-init',
  });

  it('throws when Claude Code resolves a DIFFERENT mode than the one asked for', async () => {
    const { createRealSdkBackend, PermissionModeDowngradedError } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        // Asked for `auto`, got `default` — exactly what an old `claude` build
        // or an unsupported model produces.
        yield initWith('default');
        yield { type: 'result', session_id: 'sess-init', result: 'should never be reached' };
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    await expect(
      drain(
        backend.run({
          prompt: 'hi',
          cwd: '/tmp',
          abortController: ac,
          oauthAccessToken: 'tok',
          permissionMode: 'auto',
        }),
      ),
    ).rejects.toThrow(PermissionModeDowngradedError);
  });

  it('names both modes in the error, so the log says what was swapped for what', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield initWith('default');
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const err = await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        permissionMode: 'auto',
      }),
    ).catch((e: unknown) => e as Error & { requested: string; effective: string });
    expect(err.requested).toBe('auto');
    expect(err.effective).toBe('default');
    expect(err.message).toContain("'auto'");
    expect(err.message).toContain("'default'");
  });

  it('runs normally when the mode comes back as asked', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield initWith('bypassPermissions');
        yield { type: 'result', session_id: 'sess-init', result: 'done' };
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        permissionMode: 'bypassPermissions',
      }),
    );
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });

  // spec/02 § Permission mode's plan-mode exception. Every OTHER substitution
  // target throws above; `plan` does not, because it still blocks a tool call
  // on a human decision (the same `canUseTool` gate patch wires for every
  // mode) rather than being the dead end `default` is for an unattended chat.
  it('does NOT throw when Claude Code resolves the turn onto `plan` instead', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        // Asked for `bypassPermissions`, got `plan` — the plan-mode exception.
        yield initWith('plan');
        yield { type: 'result', session_id: 'sess-init', result: 'done' };
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        permissionMode: 'bypassPermissions',
      }),
    );
    // The turn ran to completion — no thrown PermissionModeDowngradedError
    // cut it short.
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });

  it('yields a permissionModeAutoDowngrade envelope naming both modes, for `plan` only', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield initWith('plan');
        yield { type: 'result', session_id: 'sess-init', result: 'done' };
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        permissionMode: 'bypassPermissions',
      }),
    );
    const marker = out.find((e) => e.permissionModeAutoDowngrade !== undefined);
    expect(marker?.permissionModeAutoDowngrade).toEqual({
      requested: 'bypassPermissions',
      effective: 'plan',
    });
  });

  it('compares against the `auto` default when the turn named no mode', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield initWith('default');
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const err = await drain(
      backend.run({ prompt: 'hi', cwd: '/tmp', abortController: ac, oauthAccessToken: 'tok' }),
    ).catch((e: unknown) => e as Error & { requested: string });
    expect(err.requested).toBe('auto');
  });

  it('stays silent when the CLI reports no mode at all — unknown is not a mismatch', async () => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: 'sess-init' };
        yield { type: 'result', session_id: 'sess-init', result: 'done' };
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    const ac = new AbortController();
    const out = await drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'tok',
        permissionMode: 'auto',
      }),
    );
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A `result` that is reporting a FAILURE must fail the turn
// ---------------------------------------------------------------------------
//
// Claude Code reports a failed turn without throwing, two different ways:
// `subtype: 'success'` with `is_error: true` and the text in `result` (this is
// how a spend limit arrives), or an `error_*` subtype with the text in
// `errors[]`. Patch read neither, so the turn SETTLED — chat idle, no error
// state, nothing to retry, and the failure text delivered as though the agent
// had said it. Dozens of chats sat reading as finished with "You've hit your
// monthly spend limit" as their last word.
//
// The SDK only throws when the process ALSO exits non-zero, which is why some of
// them errored properly and others looked fine: the same failure, two outcomes,
// decided by whether the CLI happened to exit cleanly.
describe('createRealSdkBackend — an error result is a failed turn, not a quiet success', () => {
  const runWith = async (result: unknown) => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', permissionMode: 'auto', session_id: 's' };
        yield result;
      }
      return gen();
    });
    const backend = createRealSdkBackend();
    return drain(
      backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        permissionMode: 'auto',
      }),
    );
  };

  it('fails on the exact spend-limit result that read as success', async () => {
    await expect(
      runWith({
        type: 'result',
        subtype: 'success',
        is_error: true,
        session_id: 's',
        result:
          "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · " +
          'your weekly limit resets 8pm (UTC)',
      }),
    ).rejects.toThrow(/spend limit/);
  });

  it('carries the text through so the rate-limit and failover predicates still match it', async () => {
    // Those predicates read the message. Losing the text would silently disable
    // auto-resume and account failover for this exact failure.
    const err = await runWith({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "You've hit your monthly spend limit · resets 8pm (UTC)",
    }).catch((e: unknown) => e as Error);
    expect(err.message).toContain('Claude Code returned an error result:');
    expect(err.message).toContain('resets 8pm');
  });

  it('fails on an error_* subtype, taking the text from errors[]', async () => {
    await expect(
      runWith({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['tool crashed', 'and again'],
      }),
    ).rejects.toThrow(/tool crashed; and again/);
  });

  it('fails on an error_* subtype even when is_error is absent', async () => {
    await expect(runWith({ type: 'result', subtype: 'error_max_turns' })).rejects.toThrow(
      /error_max_turns/,
    );
  });

  it('leaves a genuine success alone', async () => {
    const out = await runWith({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's',
      result: 'all done',
    });
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });

  it('leaves a result with no is_error and no subtype alone (older CLIs)', async () => {
    const out = await runWith({ type: 'result', session_id: 's', result: 'all done' });
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The THIRD way a failed turn arrives: an injected assistant message
// ---------------------------------------------------------------------------
//
// This is the one that survived the `result` fix. Claude Code injects a
// SYNTHETIC assistant message carrying the provider's message, then ends the turn
// normally. Patch rendered it as the agent's own words, so a chat taking a
// Todoist event every few minutes answered each one with "You've hit your monthly
// spend limit" and settled DONE — 492 of them across 141 sessions in one day,
// ticked green in the sidebar, nothing retrying any of it.
//
// The fixtures below are the real transcript shape off the box.
describe('createRealSdkBackend — an injected assistant error is a failed turn', () => {
  const LIMIT =
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · " +
    'your weekly limit resets 8pm (UTC)';

  const runWith = async (assistant: unknown) => {
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', permissionMode: 'auto', session_id: 's' };
        yield assistant;
        yield { type: 'result', subtype: 'success', is_error: false, result: 'done' };
      }
      return gen();
    });
    return drain(
      createRealSdkBackend().run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        permissionMode: 'auto',
      }),
    );
  };

  it('fails on the SDK typed error field — the reliable signal', async () => {
    await expect(
      runWith({
        type: 'assistant',
        error: 'rate_limit',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: LIMIT }],
        },
      }),
    ).rejects.toThrow(/spend limit/);
  });

  it('fails on the transcript marker isApiErrorMessage', async () => {
    await expect(
      runWith({
        type: 'assistant',
        isApiErrorMessage: true,
        message: { role: 'assistant', content: [{ type: 'text', text: LIMIT }] },
      }),
    ).rejects.toThrow(/spend limit/);
  });

  it('fails on a <synthetic> message carrying a limit, when neither marker is set', async () => {
    // The real shape: synthetic AND no model input. Both are required now, so a
    // genuine turn that merely quotes the phrase cannot trip this arm.
    await expect(
      runWith({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          usage: { input_tokens: 0 },
          content: [{ type: 'text', text: LIMIT }],
        },
      }),
    ).rejects.toThrow(/spend limit/);
  });

  it('does NOT fail when a REAL agent quotes the phrase', async () => {
    // One of them was doing precisely this: writing the reason into a Todoist
    // comment to mark its own task failed. Matching on text alone would have
    // killed that turn for reporting the truth.
    const out = await runWith({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: `I could not finish: ${LIMIT}. Logging it to Todoist.` }],
      },
    });
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });

  it('leaves a <synthetic> message alone when it is not a failure', async () => {
    const out = await runWith({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Context compacted.' }],
      },
    });
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });

  it('leaves an ordinary assistant message alone', async () => {
    const out = await runWith({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'hello' }],
      },
    });
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// How much of the detection depends on reading prose
// ---------------------------------------------------------------------------
//
// Fair challenge: if this rests on spotting "<synthetic>" and a phrase, it will
// break the day the wording changes. So three of the four checks are STRUCTURAL
// — a typed field, a marker, or the presence of a field that only exists on an
// error — and these pin that the text-reading arm is genuinely the last resort.
describe('assistantErrorText — the structural checks stand on their own', () => {
  // Loaded through loadRealBackend like everything else here: the module caches
  // its SDK handle in module scope, so the file re-imports per test rather than
  // holding a stale instance.
  const load = async () => await loadRealBackend(() => undefined);
  const bare = (over: Record<string, unknown>) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'some prose' }] },
    ...over,
  });

  it('catches it on the SDK typed field alone, with no recognisable text', async () => {
    const { assistantErrorText } = await load();
    expect(assistantErrorText(bare({ error: 'billing_error' }))).toBe('some prose');
  });

  it('catches it on isApiErrorMessage alone, with no text at all', async () => {
    const { assistantErrorText } = await load();
    const msg = { type: 'assistant', isApiErrorMessage: true, message: { content: [] } };
    expect(assistantErrorText(msg)).toBe('api error (no text)');
  });

  it('catches it on apiErrorStatus alone — a field only an error carries', async () => {
    const { assistantErrorText } = await load();
    expect(assistantErrorText(bare({ apiErrorStatus: 429 }))).toBe('some prose');
  });

  it('catches it on quotaLimits alone', async () => {
    const { assistantErrorText } = await load();
    expect(assistantErrorText(bare({ quotaLimits: { monthly: 'exceeded' } }))).toBe('some prose');
  });

  it('needs NONE of the wording for any of those — prose it has never seen still fails', async () => {
    // The wording could change tomorrow; these do not care.
    const { assistantErrorText } = await load();
    const odd = {
      type: 'assistant',
      error: 'unknown',
      message: { content: [{ type: 'text', text: 'Something entirely new went wrong.' }] },
    };
    expect(assistantErrorText(odd)).toBe('Something entirely new went wrong.');
  });

  it('the text-reading arm requires BOTH synthetic and zero model input', async () => {
    // A real model turn always consumes input tokens, so this arm cannot fire on
    // genuine output however the text reads.
    const { assistantErrorText } = await load();
    const realTurnQuoting = {
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 120 },
        content: [{ type: 'text', text: "You've hit your monthly spend limit" }],
      },
    };
    expect(assistantErrorText(realTurnQuoting)).toBeUndefined();

    const syntheticButBusy = {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        usage: { input_tokens: 42 },
        content: [{ type: 'text', text: "You've hit your monthly spend limit" }],
      },
    };
    expect(assistantErrorText(syntheticButBusy)).toBeUndefined();
  });

  it('leaves a benign synthetic notice alone — that is why the arm reads the text', async () => {
    const { assistantErrorText } = await load();
    const compacted = {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        usage: { input_tokens: 0 },
        content: [{ type: 'text', text: 'Context compacted.' }],
      },
    };
    expect(assistantErrorText(compacted)).toBeUndefined();
  });
});

describe('isModelOutput — the safety net for failures nobody has seen yet', () => {
  const load = async () => await loadRealBackend(() => undefined);

  it('a synthetic message is not model output', async () => {
    const { isModelOutput } = await load();
    expect(isModelOutput({ type: 'assistant', message: { model: '<synthetic>' } })).toBe(false);
  });

  it('zero input tokens is not model output, whatever it claims to be', async () => {
    const { isModelOutput } = await load();
    expect(
      isModelOutput({
        type: 'assistant',
        message: { model: 'claude-opus-5', usage: { input_tokens: 0 } },
      }),
    ).toBe(false);
  });

  it('a real turn IS model output', async () => {
    const { isModelOutput } = await load();
    expect(
      isModelOutput({
        type: 'assistant',
        message: { model: 'claude-opus-5', usage: { input_tokens: 120 } },
      }),
    ).toBe(true);
  });

  it('absent usage counts as real — calling a genuine turn fake is the worse error', async () => {
    // An older CLI may not report usage. The markers are the primary defence;
    // this is only the net, and a net that fails real work is worse than a gap.
    const { isModelOutput } = await load();
    expect(isModelOutput({ type: 'assistant', message: { model: 'claude-opus-5' } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan Mode exit returns the live session to the chat's own mode
//
// The agent's `EnterPlanMode`/`ExitPlanMode` move the running Claude Code
// process between modes. The chat's displayed mode is restored by chatRunner,
// but the process itself must be told too — otherwise a `bypassPermissions`
// chat reads "bypass" while the process asks for approval on every Bash call.
// ---------------------------------------------------------------------------
describe('createRealSdkBackend — ExitPlanMode returns the session to the requested mode', () => {
  const exitPlanMessages = (): unknown[] => [
    { type: 'system', subtype: 'init', permissionMode: 'bypassPermissions', session_id: 's' },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: {} }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'approved' }] },
    },
    { type: 'result', session_id: 's', result: 'done' },
  ];

  it('calls setPermissionMode(requested) on the live query after an approved ExitPlanMode', async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        for (const m of exitPlanMessages()) yield m;
      }
      return Object.assign(gen(), { setPermissionMode });
    });
    await drain(
      createRealSdkBackend().run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        permissionMode: 'bypassPermissions',
      }),
    );
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('does not touch the mode when ExitPlanMode was denied', async () => {
    const setPermissionMode = vi.fn(async () => undefined);
    const { createRealSdkBackend } = await loadRealBackend(() => {
      async function* gen(): AsyncGenerator<unknown> {
        for (const m of exitPlanMessages()) {
          yield (m as { type: string }).type === 'user'
            ? {
                type: 'user',
                message: {
                  content: [
                    { type: 'tool_result', tool_use_id: 'tu1', content: 'no', is_error: true },
                  ],
                },
              }
            : m;
        }
      }
      return Object.assign(gen(), { setPermissionMode });
    });
    await drain(
      createRealSdkBackend().run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        permissionMode: 'bypassPermissions',
      }),
    );
    expect(setPermissionMode).not.toHaveBeenCalled();
  });
});
