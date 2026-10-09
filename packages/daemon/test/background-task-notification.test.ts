// spec/02 § Background task completions — a background task finishing is a
// thing the user must be able to see. Claude Code reports it as a user-role
// message carrying a `<task-notification>` block; the host lifts its summary
// onto the transcript as a system message. Every OTHER user message keeps its
// existing behaviour (it carries no chat-visible text of its own).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { translateSdkMessage } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

const NOTIFICATION = `<task-notification>
<task-id>baiw888mq</task-id>
<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>
<output-file>/tmp/claude-1000/proj/tasks/baiw888mq.output</output-file>
<status>completed</status>
<summary>Background command "Build web package to compile CSS" completed (exit code 0)</summary>
</task-notification>`;

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-bgtask-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder };
}

describe('background task completion notices', () => {
  it('translates a task-notification user message into a system envelope carrying the summary', () => {
    const [env] = translateSdkMessage({
      type: 'user',
      message: { role: 'user', content: NOTIFICATION },
    });
    expect(env?.type).toBe('system');
    expect(env?.content).toBe(
      'Background command "Build web package to compile CSS" completed (exit code 0)',
    );
  });

  it('reads a notification delivered as text content blocks', () => {
    const [env] = translateSdkMessage({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: NOTIFICATION }] },
    });
    expect(env?.type).toBe('system');
    expect(env?.content).toBe(
      'Background command "Build web package to compile CSS" completed (exit code 0)',
    );
  });

  it('leaves an ordinary user message with no chat-visible content, as before', () => {
    const [env] = translateSdkMessage({
      type: 'user',
      message: { role: 'user', content: 'just a normal turn' },
    });
    expect(env?.type).toBe('user');
    expect(env?.content).toBeUndefined();
  });

  it('surfaces a tool-result user message as a tool_result envelope (live tool visibility)', () => {
    const [env] = translateSdkMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    });
    expect(env?.type).toBe('tool_result');
    expect(env?.toolResult).toMatchObject({ name: 'tool', callId: 'toolu_1', result: 'ok' });
  });

  it('fans the notice out to surfaces as a system chat.message', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      {
        type: 'system',
        content: 'Background command "Build web package to compile CSS" completed (exit code 0)',
      },
      { type: 'assistant', content: 'the build is green', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'build it in the background' });
    await new Promise((r) => setTimeout(r, 20));

    const system = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'system',
    );
    expect(system).toHaveLength(1);
    expect(system[0]?.content).toBe(
      'Background command "Build web package to compile CSS" completed (exit code 0)',
    );
  });
});
