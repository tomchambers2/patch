import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

// A message sent while Codex works reaches it through `turn/steer` after the
// next tool call finishes, not after the whole turn.
function harness(opts: { steerFails?: boolean; waiting?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patch-codex-steer-'));
  const history = new CodexHistory(root);
  const calls: { method: string; params: any }[] = [];
  let listener: ((m: any) => void) | undefined;
  const emit = (method: string, params: object): void =>
    listener?.({ method, params: { threadId: 'thread1', turnId: 't1', ...params } });
  const toolItem = {
    id: 'i1',
    type: 'commandExecution',
    command: 'ls',
    aggregatedOutput: 'a',
    status: 'completed',
    exitCode: 0,
  };
  const client = {
    subscribe: (fn: (m: any) => void) => {
      listener = fn;
      return () => {};
    },
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread1', path: '/p' } };
      if (method === 'turn/steer') {
        if (opts.steerFails) throw new Error('turn is not steerable');
        return { turnId: 't1' };
      }
      if (method === 'turn/start') {
        setTimeout(() => {
          emit('item/started', { item: toolItem });
          emit('item/completed', { item: toolItem });
          setTimeout(() => emit('turn/completed', { turn: { id: 't1', status: 'completed' } }), 5);
        }, 0);
        return { turn: { id: 't1' } };
      }
      throw new Error('unexpected ' + method);
    },
  };
  const accounts: any = {
    resolveChosen: async () => ({ accountId: 'a' }),
    turnClient: async () => client,
    releaseTurnClient: async () => {},
  };
  let waiting = opts.waiting;
  const run = async () => {
    const events: SdkEnvelope[] = [];
    const backend = new CodexBackend(accounts, history);
    for await (const e of backend.run({
      prompt: 'work',
      cwd: root,
      chatId: 'c',
      model: 'gpt',
      permissionMode: 'acceptEdits',
      oauthAccessToken: '',
      abortController: new AbortController(),
      onToolBoundary: () => {
        const text = waiting;
        waiting = undefined;
        return text;
      },
    } as any))
      events.push(e);
    return events;
  };
  return { root, calls, run };
}

describe('Codex delivery at a tool boundary', () => {
  it('steers the running turn with what is waiting once a tool call finishes', async () => {
    const h = harness({ waiting: 'change course' });
    try {
      const events = await h.run();
      expect(events.at(-1)?.type).toBe('result');
      const steer = h.calls.filter((c) => c.method === 'turn/steer');
      expect(steer).toHaveLength(1);
      expect(steer[0]!.params).toEqual({
        threadId: 'thread1',
        expectedTurnId: 't1',
        input: [{ type: 'text', text: 'change course', text_elements: [] }],
      });
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('steers nothing when nothing is waiting', async () => {
    const h = harness();
    try {
      await h.run();
      expect(h.calls.filter((c) => c.method === 'turn/steer')).toHaveLength(0);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('fails the turn visibly when Codex refuses the steer', async () => {
    const h = harness({ waiting: 'change course', steerFails: true });
    try {
      await expect(h.run()).rejects.toThrow('did not take a message');
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
