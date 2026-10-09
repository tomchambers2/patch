// hookMatches: structural gate axes + JSONata filter (spec/20-hooks.md § Gate).

import { describe, it, expect } from 'vitest';
import { hookMatches } from '../src/hooks/gate.js';
import type { Hook, HookCheckContext } from '../src/hooks/types.js';

function hook(overrides: Partial<Hook> = {}): Hook {
  return {
    id: 'hook_01',
    name: 'test',
    enabled: true,
    when: 'user_message',
    kind: 'script',
    script: { command: 'exit 0' },
    gate: {},
    timeoutMs: 15_000,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const ctx: HookCheckContext = {
  message: 'hello world',
  chatId: 'c_abc',
  folder: '/home/tom/projects/bus',
  daemonId: 'd_abc',
  specialThread: false,
};

describe('hookMatches', () => {
  it('matches a hook with no gate restrictions', async () => {
    expect(await hookMatches(hook(), ctx, Date.now())).toBe(true);
  });

  it('a disabled hook never matches', async () => {
    expect(await hookMatches(hook({ enabled: false }), ctx, Date.now())).toBe(false);
  });

  it('hosts allow-list excludes a chat on another host', async () => {
    const h = hook({ gate: { hosts: ['d_other'] } });
    expect(await hookMatches(h, ctx, Date.now())).toBe(false);
    expect(await hookMatches(hook({ gate: { hosts: ['d_abc'] } }), ctx, Date.now())).toBe(true);
  });

  it('folders allow-list excludes a chat in another folder', async () => {
    const h = hook({ gate: { folders: ['/other'] } });
    expect(await hookMatches(h, ctx, Date.now())).toBe(false);
  });

  it('chatIds allow-list excludes a different chat', async () => {
    const h = hook({ gate: { chatIds: ['c_other'] } });
    expect(await hookMatches(h, ctx, Date.now())).toBe(false);
  });

  it('specialThreads defaults to ordinary chats only', async () => {
    const h = hook({ gate: { specialThreads: true } });
    expect(await hookMatches(h, ctx, Date.now())).toBe(false);
    expect(await hookMatches(h, { ...ctx, specialThread: true }, Date.now())).toBe(true);
  });

  it('an ordinary hook (specialThreads unset) does not reach a special thread', async () => {
    expect(await hookMatches(hook(), { ...ctx, specialThread: true }, Date.now())).toBe(false);
  });

  it('filter is evaluated against the message', async () => {
    const h = hook({ gate: { filter: "$contains(payload.message, 'secret')" } });
    expect(await hookMatches(h, ctx, Date.now())).toBe(false);
    expect(await hookMatches(h, { ...ctx, message: 'my secret' }, Date.now())).toBe(true);
  });

  it('a bad filter fails closed and reports the error', async () => {
    const h = hook({ gate: { filter: '($$$ bad jsonata' } });
    let reported: string | undefined;
    const matched = await hookMatches(h, ctx, Date.now(), (err) => {
      reported = err.message;
    });
    expect(matched).toBe(false);
    expect(reported).toBeDefined();
  });
});
