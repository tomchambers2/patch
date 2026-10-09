// spec/20-hooks.md, host half: a `script` hook gets message+context JSON on
// stdin and its stdout is parsed per the documented contract; a `prompt` hook
// runs a one-shot tool-less model query on this host's own backend.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import type { HookCheckRequestEvent } from '@patch/wire';
import { handleHookCheck, parseHookOutcome } from '../src/hookCheck.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silentLogger = pino({ level: 'silent' });

function baseEvent(overrides: Partial<HookCheckRequestEvent> = {}): HookCheckRequestEvent {
  return {
    type: 'hook.check_request',
    daemonId: 'd1',
    requestId: 'req_1',
    hookId: 'hook_1',
    kind: 'script',
    timeoutMs: 5000,
    context: {
      message: 'hello',
      chatId: 'c1',
      folder: '/work',
      daemonId: 'd1',
      specialThread: false,
    },
    ...overrides,
  };
}

function run(
  event: HookCheckRequestEvent,
  deps: Parameters<typeof handleHookCheck>[2],
): Promise<Extract<WireEvent, { type: 'hook.check_result' }>> {
  return new Promise((resolve) => {
    void handleHookCheck(
      event,
      (e) => {
        if (e.type === 'hook.check_result') resolve(e);
      },
      deps,
    );
  });
}

const dummySdkDeps = {
  sdkBackend: createMockSdkBackend(),
  resolveOAuth: (): OAuthCheckResult => ({ ok: true, accessToken: 'tok' }),
  logger: silentLogger,
};

describe('parseHookOutcome', () => {
  it('empty stdout is pass', () => {
    expect(parseHookOutcome('')).toEqual({ decision: 'pass' });
    expect(parseHookOutcome('   \n')).toEqual({ decision: 'pass' });
  });

  it('parses a plain JSON outcome', () => {
    expect(parseHookOutcome('{"decision":"advise","analysis":"hmm"}')).toEqual({
      decision: 'advise',
      analysis: 'hmm',
    });
  });

  it('unwraps a ```json fenced reply', () => {
    expect(parseHookOutcome('```json\n{"decision":"pass"}\n```')).toEqual({ decision: 'pass' });
  });

  it('rejects non-JSON stdout', () => {
    expect(parseHookOutcome('not json at all')).toBeNull();
  });

  it('rejects advise/block with no analysis', () => {
    expect(parseHookOutcome('{"decision":"block"}')).toBeNull();
  });
});

describe('handleHookCheck — script', () => {
  let dir: string;
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length > 0) {
      const d = cleanup.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it('exit 0 with empty stdout is a pass', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hook-'));
    cleanup.push(dir);
    const event = baseEvent({
      script: { command: 'exit 0' },
      context: { ...baseEvent().context, folder: dir },
    });
    const result = await run(event, dummySdkDeps);
    expect(result.status).toBe('ok');
    expect(result.decision).toBe('pass');
  });

  it('receives message+context as JSON on stdin and echoes a block', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hook-'));
    cleanup.push(dir);
    const event = baseEvent({
      script: {
        command:
          'node -e \'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{' +
          'const ctx=JSON.parse(d); console.log(JSON.stringify({decision:"block",analysis:"msg was: "+ctx.message}));})\'',
      },
      context: { ...baseEvent().context, folder: dir, message: 'my secret password' },
    });
    const result = await run(event, dummySdkDeps);
    expect(result.status).toBe('ok');
    expect(result.decision).toBe('block');
    expect(result.analysis).toBe('msg was: my secret password');
  });

  it('non-zero exit is a failed run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hook-'));
    cleanup.push(dir);
    const event = baseEvent({
      script: { command: 'echo "boom" >&2; exit 1' },
      context: { ...baseEvent().context, folder: dir },
    });
    const result = await run(event, dummySdkDeps);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('boom');
  });

  it('malformed stdout on exit 0 is a failed run, never a silent pass', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hook-'));
    cleanup.push(dir);
    const event = baseEvent({
      script: { command: 'echo "not json"' },
      context: { ...baseEvent().context, folder: dir },
    });
    const result = await run(event, dummySdkDeps);
    expect(result.status).toBe('failed');
    expect(result.decision).toBeUndefined();
  });

  it('a command killed on timeout is reported as a timeout', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hook-'));
    cleanup.push(dir);
    const event = baseEvent({
      script: { command: 'sleep 5' },
      timeoutMs: 1000,
      context: { ...baseEvent().context, folder: dir },
    });
    const result = await run(event, dummySdkDeps);
    expect(result.status).toBe('timeout');
  }, 10_000);

  it('refuses a folder that does not exist on this host', async () => {
    const event = baseEvent({
      script: { command: 'exit 0' },
      context: { ...baseEvent().context, folder: '/no/such/folder/xyz' },
    });
    const result = await run(event, dummySdkDeps);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('folder not found');
  });
});

describe('handleHookCheck — prompt', () => {
  it('parses the model reply as the structured outcome', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"decision":"advise","analysis":"a bit blunt"}' },
      { type: 'result', sessionId: 's1' },
    ]);
    const event = baseEvent({
      kind: 'prompt',
      prompt: { instructions: 'Be nice.', model: 'claude-haiku-4-5-20251001' },
    });
    const result = await run(event, {
      sdkBackend: sdk,
      resolveOAuth: () => ({ ok: true, accessToken: 't' }),
      logger: silentLogger,
    });
    expect(result.status).toBe('ok');
    expect(result.decision).toBe('advise');
    expect(result.analysis).toBe('a bit blunt');
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe('claude-haiku-4-5-20251001');
    expect(opts?.permissionMode).toBe('bypassPermissions');
  });

  it("hands the message's images to the model and says so in the query", async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"decision":"pass"}' },
      { type: 'result', sessionId: 's_img' },
    ]);
    const images = [{ mediaType: 'image/png' as const, data: 'aGVsbG8=' }];
    const event = baseEvent({
      kind: 'prompt',
      prompt: { instructions: 'Is the screenshot clear?', model: 'claude-haiku-4-5-20251001' },
      context: { ...baseEvent().context, images },
    });
    const result = await run(event, {
      sdkBackend: sdk,
      resolveOAuth: () => ({ ok: true, accessToken: 't' }),
      logger: silentLogger,
    });
    expect(result.status).toBe('ok');
    const opts = sdk.lastOptions();
    expect(opts?.images).toEqual(images);
    expect(opts?.prompt).toContain('came with 1 attached image');
  });

  it('a text-only message sends no images and no image note', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"decision":"pass"}' },
      { type: 'result', sessionId: 's_txt' },
    ]);
    await run(
      baseEvent({
        kind: 'prompt',
        prompt: { instructions: 'x', model: 'claude-haiku-4-5-20251001' },
      }),
      {
        sdkBackend: sdk,
        resolveOAuth: () => ({ ok: true, accessToken: 't' }),
        logger: silentLogger,
      },
    );
    expect(sdk.lastOptions()?.images).toBeUndefined();
    expect(sdk.lastOptions()?.prompt).not.toContain('attached image');
  });

  it('a reply that is not the documented JSON shape is a failed run', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'Sure thing, looks fine to me!' },
      { type: 'result', sessionId: 's2' },
    ]);
    const event = baseEvent({
      kind: 'prompt',
      prompt: { instructions: 'Be nice.', model: 'claude-haiku-4-5-20251001' },
    });
    const result = await run(event, {
      sdkBackend: sdk,
      resolveOAuth: () => ({ ok: true, accessToken: 't' }),
      logger: silentLogger,
    });
    expect(result.status).toBe('failed');
  });

  it('no credential available is a failed run, never a silent pass', async () => {
    const event = baseEvent({
      kind: 'prompt',
      prompt: { instructions: 'Be nice.', model: 'claude-haiku-4-5-20251001' },
    });
    const result = await run(event, {
      sdkBackend: createMockSdkBackend(),
      resolveOAuth: () => ({ ok: false, reason: 'not signed in' }),
      logger: silentLogger,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not signed in');
  });
});
