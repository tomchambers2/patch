// `patch.spawn.response` — the named machine's own outcome for a cross-host
// spawn (spec/03 § Cross-chat tools).
//
// Without this frame a cross-host `patch.spawn` was fire-and-forget: a target
// that REFUSED the spawn reported nothing, and the calling agent's tool call
// returned success for a chat that did not exist. These assertions are the
// contract that makes that impossible — the answer names the machine, carries
// the request it belongs to, and says out loud whether it worked.

import { describe, it, expect } from 'vitest';
import { PatchSpawnEvent, PatchSpawnResponseEvent } from '../src/index.js';

const ok = {
  type: 'patch.spawn.response',
  requestId: 'req-1',
  sourceChatId: 'chat-src',
  daemonId: 'host-b',
  folder: '/work/qa',
  ok: true,
  chatId: 'chat-new',
} as const;

describe('patch.spawn.response', () => {
  it('accepts a success carrying the new chat', () => {
    expect(PatchSpawnResponseEvent.safeParse(ok).success).toBe(true);
  });

  it('accepts a refusal carrying the reason the target machine gave', () => {
    const res = PatchSpawnResponseEvent.safeParse({
      type: 'patch.spawn.response',
      requestId: 'req-1',
      sourceChatId: 'chat-src',
      daemonId: 'host-b',
      folder: '/work/qa',
      ok: false,
      error: { code: 'no_model_catalogue', message: 'never read a model catalogue' },
    });
    expect(res.success).toBe(true);
  });

  it('requires the machine that answered — an error that names no host is unactionable', () => {
    const { daemonId: _drop, ...noHost } = ok;
    void _drop;
    const res = PatchSpawnResponseEvent.safeParse(noHost);
    expect(res.success).toBe(false);
    expect(res.success ? [] : res.error.issues.map((i) => i.path.join('.'))).toContain('daemonId');
  });

  it('requires the requestId — an answer nobody can correlate resolves nothing', () => {
    const { requestId: _drop, ...noReq } = ok;
    void _drop;
    expect(PatchSpawnResponseEvent.safeParse(noReq).success).toBe(false);
  });

  it('requires the outcome flag', () => {
    const { ok: _drop, ...noOk } = ok;
    void _drop;
    expect(PatchSpawnResponseEvent.safeParse(noOk).success).toBe(false);
  });

  it('rejects an unknown error code — refusals use the shared ChatErrorCode set', () => {
    expect(
      PatchSpawnResponseEvent.safeParse({
        ...ok,
        ok: false,
        chatId: undefined,
        error: { code: 'made_up', message: 'nope' },
      }).success,
    ).toBe(false);
  });

  it('is strict: an unknown key is a rejected frame, never a silently ignored one', () => {
    expect(PatchSpawnResponseEvent.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('pairs with a request that can carry the same requestId', () => {
    const res = PatchSpawnEvent.safeParse({
      type: 'patch.spawn',
      sourceChatId: 'chat-src',
      daemonId: 'host-b',
      folder: '/work/qa',
      prompt: 'hi',
      requestId: 'req-1',
    });
    expect(res.success).toBe(true);
    // Omitted on the same-host audit frame, which answers to nobody.
    expect(
      PatchSpawnEvent.safeParse({
        type: 'patch.spawn',
        sourceChatId: 'chat-src',
        daemonId: 'host-a',
        folder: '/work/qa',
        prompt: 'hi',
      }).success,
    ).toBe(true);
  });
});
