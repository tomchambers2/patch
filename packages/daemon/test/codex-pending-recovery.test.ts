import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

// A Codex process that died before recording a turn leaves a pending marker
// that no thread turn carries. That must not wedge the chat.
function harness(threadTurns: unknown[], readFails = false) {
  const root = mkdtempSync(join(tmpdir(), 'patch-codex-pending-'));
  const history = new CodexHistory(root);
  const sid = 'codex-thread1';
  history.begin(sid);
  history.setPending(sid, { id: 'lost-client-id', prompt: 'build it' });
  const calls: { method: string; params: any }[] = [];
  let listener: ((m: any) => void) | undefined;
  const client = {
    subscribe: (fn: (m: any) => void) => {
      listener = fn;
      return () => {};
    },
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/resume') return { thread: { id: 'thread1', path: '/p' } };
      if (method === 'thread/read') {
        if (readFails) throw new Error('codex unreachable');
        return { thread: { turns: threadTurns } };
      }
      if (method === 'turn/start') {
        setTimeout(
          () =>
            listener?.({
              method: 'turn/completed',
              params: {
                threadId: 'thread1',
                turnId: 't2',
                turn: { id: 't2', status: 'completed' },
              },
            }),
          0,
        );
        return { turn: { id: 't2' } };
      }
      throw new Error('unexpected ' + method);
    },
  };
  const accounts: any = {
    resolveChosen: async () => ({ accountId: 'a' }),
    turnClient: async () => client,
    releaseTurnClient: async () => {},
  };
  const run = async () => {
    const events: SdkEnvelope[] = [];
    const backend = new CodexBackend(accounts, history);
    for await (const e of backend.run({
      prompt: 'build it',
      cwd: root,
      chatId: 'c',
      model: 'gpt',
      permissionMode: 'acceptEdits',
      oauthAccessToken: '',
      abortController: new AbortController(),
      resumeSessionId: sid,
    } as any))
      events.push(e);
    return events;
  };
  return { root, history, sid, calls, run };
}

describe('Codex pending-turn recovery', () => {
  it('clears the marker and resends when the thread has no record of the turn', async () => {
    const h = harness([]);
    try {
      const events = await h.run();
      expect(events.at(-1)?.type).toBe('result');
      expect(h.calls.filter((c) => c.method === 'turn/start')).toHaveLength(1);
      expect(h.history.pending(h.sid)).toBeNull();
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('still fails loudly, keeping the marker, when the thread cannot be read', async () => {
    const h = harness([], true);
    try {
      await expect(h.run()).rejects.toThrow('codex unreachable');
      expect(h.history.pending(h.sid)).not.toBeNull();
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
