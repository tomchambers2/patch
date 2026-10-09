// HookRunner: matches hooks to a check, dispatches `hook.check_request` to
// the chat's own host in parallel, times out, aggregates (spec/20-hooks.md).

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { HookRunner } from '../src/hooks/runner.js';
import type { Hook, HooksInterface } from '../src/hooks/types.js';

const silentLogger = pino({ level: 'silent' });

class FakeHooksStore implements HooksInterface {
  private readonly byId = new Map<string, Hook>();
  constructor(hooks: Hook[]) {
    for (const h of hooks) this.byId.set(h.id, h);
  }
  list(): Hook[] {
    return [...this.byId.values()];
  }
  get(id: string): Hook | null {
    return this.byId.get(id) ?? null;
  }
  create(): Hook {
    throw new Error('not implemented');
  }
  patch(): Hook {
    throw new Error('not implemented');
  }
  delete(): boolean {
    throw new Error('not implemented');
  }
  enable(): Hook {
    throw new Error('not implemented');
  }
  disable(): Hook {
    throw new Error('not implemented');
  }
  onChange(): () => void {
    return () => {};
  }
}

function hook(id: string, overrides: Partial<Hook> = {}): Hook {
  return {
    id,
    name: id,
    enabled: true,
    when: 'user_message',
    kind: 'script',
    script: { command: 'exit 0' },
    gate: {},
    timeoutMs: 100,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const ctx = {
  message: 'hello',
  chatId: 'c_abc',
  folder: '/work',
  daemonId: 'd1',
  specialThread: false,
};

describe('HookRunner', () => {
  it('returns pass with no results when nothing matches', async () => {
    const link = new InProcessDaemonLink();
    const runner = new HookRunner({
      hooks: new FakeHooksStore([]),
      daemonLink: link,
      logger: silentLogger,
    });
    const result = await runner.check(ctx);
    expect(result).toEqual({ decision: 'pass', results: [] });
  });

  it('dispatches matching hooks in parallel and aggregates pass', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([hook('hook_a'), hook('hook_b')]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const checkPromise = runner.check(ctx);
    // Both requests should have gone out before either resolves.
    await vi_waitForSentCount(link, 2);
    for (const sent of link.sent) {
      const req = sent.event as { type: string; requestId: string; hookId: string };
      expect(req.type).toBe('hook.check_request');
      link.emit({
        type: 'hook.check_result',
        requestId: req.requestId,
        hookId: req.hookId,
        status: 'ok',
        decision: 'pass',
        durationMs: 1,
      });
    }
    const result = await checkPromise;
    expect(result.decision).toBe('pass');
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === 'ok' && r.decision === 'pass')).toBe(true);
  });

  it('a block from one hook wins the aggregate even when others pass', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([hook('hook_a'), hook('hook_b')]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const checkPromise = runner.check(ctx);
    await vi_waitForSentCount(link, 2);
    for (const sent of link.sent) {
      const req = sent.event as { requestId: string; hookId: string };
      link.emit({
        type: 'hook.check_result',
        requestId: req.requestId,
        hookId: req.hookId,
        status: 'ok',
        decision: req.hookId === 'hook_a' ? 'block' : 'pass',
        analysis: req.hookId === 'hook_a' ? 'looks dangerous' : undefined,
        durationMs: 1,
      });
    }
    const result = await checkPromise;
    expect(result.decision).toBe('block');
    const blocking = result.results.find((r) => r.hookId === 'hook_a');
    expect(blocking?.decision).toBe('block');
    expect(blocking?.analysis).toBe('looks dangerous');
  });

  it('a hook that never answers times out and the aggregate advises, never blocks', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([hook('hook_a', { timeoutMs: 20 })]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const result = await runner.check(ctx);
    expect(result.decision).toBe('advise');
    expect(result.results[0]?.status).toBe('timeout');
  });

  it('an offline host fails the hook immediately without sending', async () => {
    const link = new InProcessDaemonLink();
    link.setDaemonId(null);
    const hooks = new FakeHooksStore([hook('hook_a', { gate: { hosts: null } })]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const result = await runner.check(ctx);
    expect(result.decision).toBe('advise');
    expect(result.results[0]?.status).toBe('failed');
    expect(result.results[0]?.error).toMatch(/offline/);
    expect(link.sent).toHaveLength(0);
  });

  it('a hook whose gate does not match this chat is excluded', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([hook('hook_a', { gate: { chatIds: ['c_other'] } })]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const result = await runner.check(ctx);
    expect(result).toEqual({ decision: 'pass', results: [] });
  });
});

describe('HookRunner.checkAgentResponse', () => {
  it('only matches agent_response hooks, never user_message ones', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([
      hook('hook_um', { when: 'user_message' }),
      hook('hook_ar', { when: 'agent_response' }),
    ]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const checkPromise = runner.checkAgentResponse({
      ...ctx,
      message: 'the agent reply',
      toolCallsSummary: 'Ran 1 command',
    });
    await vi_waitForSentCount(link, 1);
    const req = link.sent[0]!.event as {
      type: string;
      requestId: string;
      hookId: string;
      context: { message: string; toolCallsSummary?: string };
    };
    expect(req.hookId).toBe('hook_ar');
    expect(req.context.message).toBe('the agent reply');
    expect(req.context.toolCallsSummary).toBe('Ran 1 command');
    link.emit({
      type: 'hook.check_result',
      requestId: req.requestId,
      hookId: req.hookId,
      status: 'ok',
      decision: 'pass',
      durationMs: 1,
    });
    const results = await checkPromise;
    expect(results).toEqual([
      { hookId: 'hook_ar', hookName: 'hook_ar', status: 'ok', decision: 'pass', durationMs: 1 },
    ]);
  });

  it('does not aggregate — a failed hook is reported as failed, not forced to block', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([hook('hook_a', { when: 'agent_response', timeoutMs: 20 })]);
    const runner = new HookRunner({ hooks, daemonLink: link, logger: silentLogger });
    const results = await runner.checkAgentResponse(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('timeout');
    // No `decision` field on a failed/timeout result — nothing for a caller
    // to mistake for a real block/advise/pass.
    expect(results[0]?.decision).toBeUndefined();
  });

  it('nothing matching returns an empty array, not pass', async () => {
    const link = new InProcessDaemonLink();
    const runner = new HookRunner({
      hooks: new FakeHooksStore([hook('hook_um', { when: 'user_message' })]),
      daemonLink: link,
      logger: silentLogger,
    });
    const results = await runner.checkAgentResponse(ctx);
    expect(results).toEqual([]);
  });
});

describe('HookRunner — hook.agent_response_check_request handling', () => {
  it('resolves matching hooks and reports the outcome back to the same host', async () => {
    const link = new InProcessDaemonLink();
    const hooks = new FakeHooksStore([hook('hook_ar', { when: 'agent_response' })]);
    new HookRunner({ hooks, daemonLink: link, logger: silentLogger });

    link.emit({
      type: 'hook.agent_response_check_request',
      daemonId: 'd1',
      chatId: 'c_abc',
      checkId: 'arc_1',
      folder: '/work',
      specialThread: false,
      reply: 'done',
      toolCallsSummary: 'Ran 0 commands',
    });

    await vi_waitForSentCount(link, 1);
    const checkReq = link.sent[0]!.event as { requestId: string; hookId: string };
    link.emit({
      type: 'hook.check_result',
      requestId: checkReq.requestId,
      hookId: checkReq.hookId,
      status: 'ok',
      decision: 'block',
      analysis: 'contains a secret',
      durationMs: 1,
    });

    await vi_waitForSentCount(link, 2);
    const outcome = link.sent[1]!.event as {
      type: string;
      chatId: string;
      checkId: string;
      results: Array<{ hookId: string; decision?: string; analysis?: string }>;
    };
    expect(outcome.type).toBe('hook.agent_response_outcome');
    expect(outcome.chatId).toBe('c_abc');
    expect(outcome.checkId).toBe('arc_1');
    expect(outcome.results).toEqual([
      {
        hookId: 'hook_ar',
        hookName: 'hook_ar',
        status: 'ok',
        decision: 'block',
        analysis: 'contains a secret',
        durationMs: 1,
      },
    ]);
  });
});

/** Poll briefly until the fake link has recorded `n` sent frames. */
async function vi_waitForSentCount(link: InProcessDaemonLink, n: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (link.sent.length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} sent frames`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
