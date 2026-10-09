// spec/02 § Background task completions + spec/14 § Status badges — the host
// counts each chat's still-running background commands and sub-agents and puts
// the number on `chat.state`.
//
// The sidebar holds every chat and the transcript of none, so it cannot derive
// this for itself: it read `activity: 'idle'` and drew the finished tick over a
// chat whose backgrounded build was still going. The count is the only thing
// that tells it otherwise.
//
// Previously this counted native Bash/Task `run_in_background` launches,
// folded from the transcript (`BackgroundTaskTracker`, deleted alongside this
// rewrite). That mechanism is permanently denied now (sdkBackend.ts's
// `canUseTool`, disallowed-tools.test.ts) — an agent can still ASK for it out
// of habit, and the denied call's own `tool_call` would have been folded in as
// "running" with no possible completion notice ever following it, wedging the
// sidebar's count at a nonzero value forever. The count now reads straight off
// `patch_watch`'s persisted records (watch.ts's `count()`, unit-tested in
// watch.test.ts), which can never get stuck: a record only ever says `running`
// while the resident poll can still find its real pid alive.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-bgcount-'));
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

function states(events: WireEvent[]): ChatStateEvent[] {
  return events.filter((e): e is ChatStateEvent => e.type === 'chat.state');
}

describe('chat.state carries the running patch_watch count', () => {
  it('reports 0 for a freshly spawned chat that has watched nothing', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      { type: 'assistant', content: 'hello', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    for (const s of states(events)) expect(s.backgroundTasks).toBe(0);
    expect(states(events).length).toBeGreaterThan(0);
  });

  it('goes to 1 the moment startWatch is called, before the turn settles', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      { type: 'assistant', content: 'kicked it off', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'build it in the background' });
    events.length = 0;

    daemon.startWatch('chat-1', { command: 'sleep 5', description: 'a slow build' });
    const after = states(events).at(-1);
    expect(after?.backgroundTasks).toBe(1);

    daemon.stopWatch('chat-1', daemon.listWatch('chat-1')[0]!.taskId);
  });

  it('drops back to 0 the moment stopWatch actually kills something, without waiting for the poll', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      { type: 'assistant', content: 'kicked it off', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'build it in the background' });
    const rec = daemon.startWatch('chat-1', { command: 'sleep 5', description: 'a slow build' });
    expect(daemon.listWatch('chat-1').find((r) => r.taskId === rec.taskId)?.status).toBe('running');

    events.length = 0;
    const stopped = daemon.stopWatch('chat-1', rec.taskId);
    expect(stopped).toBe(true);
    expect(states(events).at(-1)?.backgroundTasks).toBe(0);
  });

  it('stopping an already-ended task is a no-op and does not re-announce state', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      { type: 'assistant', content: 'kicked it off', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'build it in the background' });
    const rec = daemon.startWatch('chat-1', { command: 'sleep 5', description: 'a slow build' });
    daemon.stopWatch('chat-1', rec.taskId);
    expect(daemon.stopWatch('chat-1', rec.taskId)).toBe(false);
  });

  it('counts each chat independently', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      { type: 'assistant', content: 'kicked it off', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'build A' });
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-B' },
      { type: 'assistant', content: 'kicked it off', sessionId: 'sess-B' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'build B' });

    daemon.startWatch('chat-1', { command: 'sleep 5', description: 'a' });
    daemon.startWatch('chat-2', { command: 'sleep 5', description: 'b1' });
    daemon.startWatch('chat-2', { command: 'sleep 5', description: 'b2' });

    const chat1State = [...states(events)].reverse().find((s) => s.chatId === 'chat-1');
    const chat2State = [...states(events)].reverse().find((s) => s.chatId === 'chat-2');
    expect(chat1State?.backgroundTasks).toBe(1);
    expect(chat2State?.backgroundTasks).toBe(2);

    for (const rec of daemon.listWatch('chat-1')) daemon.stopWatch('chat-1', rec.taskId);
    for (const rec of daemon.listWatch('chat-2')) daemon.stopWatch('chat-2', rec.taskId);
  });
});
