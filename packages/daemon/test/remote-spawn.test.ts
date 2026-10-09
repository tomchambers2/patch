// The calling machine's half of a cross-machine `patch_spawn`: it waits for
// the named machine's answer and turns a refusal into a real error.
//
// This is the code path the live defect went through: the spawn frame left
// host-a, host-logged-out refused it ("has never read a model catalogue"), and
// nothing carried that back — the agent was told `created:'remote'`.

import { describe, it, expect, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  createRemoteSpawnCoordinator,
  describeSpawnFailure,
  REMOTE_SPAWN_TIMEOUT_MS,
} from '../src/remote-spawn.js';
import { RemoteSpawnError } from '../src/control.js';
import { FolderNotFoundError, NoModelCatalogueError } from '../src/chatRunner.js';

function harness(timeoutMs?: number) {
  const emitted: WireEvent[] = [];
  const unknown: string[] = [];
  let n = 0;
  const coord = createRemoteSpawnCoordinator({
    emit: (e) => emitted.push(e),
    onUnknownResponse: (id) => unknown.push(id),
    newRequestId: () => `req-${++n}`,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { coord, emitted, unknown };
}

describe('remote spawn coordinator', () => {
  it('emits a patch.spawn carrying the requestId the answer must echo', async () => {
    const { coord, emitted } = harness();
    const p = coord.spawn({
      host: 'host-b',
      sourceChatId: 'mgr',
      folder: '/work/qa',
      prompt: 'hi',
    });
    expect(emitted[0]).toEqual({
      type: 'patch.spawn',
      sourceChatId: 'mgr',
      daemonId: 'host-b',
      folder: '/work/qa',
      prompt: 'hi',
      requestId: 'req-1',
    });
    coord.resolve({ requestId: 'req-1', ok: true, chatId: 'chat-new' });
    await expect(p).resolves.toEqual({ chatId: 'chat-new' });
  });

  it('sends no model when none was named — the target takes its own last-used', async () => {
    const { coord, emitted } = harness();
    const p = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/work/qa' });
    expect(emitted[0]).not.toHaveProperty('model');
    expect(emitted[0]).toMatchObject({ prompt: '' });
    coord.resolve({ requestId: 'req-1', ok: true, chatId: 'c' });
    await p;
  });

  it('REJECTS on a refusal, naming the machine and quoting its reason', async () => {
    const { coord } = harness();
    const p = coord.spawn({ host: 'host-logged-out', sourceChatId: 'mgr', folder: '/work/qa' });
    coord.resolve({
      requestId: 'req-1',
      ok: false,
      error: {
        code: 'no_model_catalogue',
        message:
          'machine host-logged-out has never read a model catalogue, so it has no last-used model',
      },
    });
    await expect(p).rejects.toThrow(RemoteSpawnError);
    await p.catch((err: RemoteSpawnError) => {
      expect(err.code).toBe('no_model_catalogue');
      expect(err.message).toContain('host-logged-out');
      expect(err.message).toContain('never read a model catalogue');
    });
  });

  it('an expiry is a loud error naming the machine, never a silent success', async () => {
    vi.useFakeTimers();
    try {
      const { coord } = harness(50);
      const p = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/work/qa' });
      const assertion = expect(p).rejects.toThrow(/machine host-b did not answer/);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late answer after the expiry is reported as unknown, not resolved twice', async () => {
    vi.useFakeTimers();
    try {
      const { coord, unknown } = harness(50);
      const p = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/work/qa' });
      const assertion = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      coord.resolve({ requestId: 'req-1', ok: true, chatId: 'c' });
      expect(unknown).toEqual(['req-1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two in-flight spawns from the same chat apart', async () => {
    const { coord, emitted } = harness();
    const a = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/a' });
    const b = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/b' });
    expect(emitted.map((e) => (e as { requestId: string }).requestId)).toEqual(['req-1', 'req-2']);
    coord.resolve({ requestId: 'req-2', ok: true, chatId: 'chat-b' });
    coord.resolve({ requestId: 'req-1', ok: true, chatId: 'chat-a' });
    await expect(a).resolves.toEqual({ chatId: 'chat-a' });
    await expect(b).resolves.toEqual({ chatId: 'chat-b' });
  });

  it('a refusal with no reason still fails — never a success by omission', async () => {
    const { coord } = harness();
    const p = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/work/qa' });
    coord.resolve({ requestId: 'req-1', ok: false });
    await expect(p).rejects.toThrow(/without a reason/);
  });

  it('carries the model when the caller named one', async () => {
    const { coord, emitted } = harness();
    const p = coord.spawn({
      host: 'host-b',
      sourceChatId: 'mgr',
      folder: '/work/qa',
      model: 'claude-opus-5',
    });
    expect(emitted[0]).toMatchObject({ model: 'claude-opus-5' });
    coord.resolve({ requestId: 'req-1', ok: true, chatId: 'c' });
    await p;
  });

  it('accepts a success that names no chat rather than inventing one', async () => {
    const { coord } = harness();
    const p = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/work/qa' });
    coord.resolve({ requestId: 'req-1', ok: true });
    await expect(p).resolves.toEqual({});
  });

  it('mints its own correlation id when none is injected', async () => {
    const emitted: WireEvent[] = [];
    const coord = createRemoteSpawnCoordinator({
      emit: (e) => emitted.push(e),
      onUnknownResponse: () => {},
    });
    const p = coord.spawn({ host: 'host-b', sourceChatId: 'mgr', folder: '/work/qa' });
    const requestId = (emitted[0] as { requestId: string }).requestId;
    expect(requestId).toMatch(/^rspawn-/);
    coord.resolve({ requestId, ok: true, chatId: 'c' });
    await expect(p).resolves.toEqual({ chatId: 'c' });
  });

  it('reports a response for a request it never made', () => {
    const { coord, unknown } = harness();
    coord.resolve({ requestId: 'nope', ok: true, chatId: 'c' });
    expect(unknown).toEqual(['nope']);
  });

  it('waits 30s by default', () => {
    expect(REMOTE_SPAWN_TIMEOUT_MS).toBe(30_000);
  });
});

describe('describeSpawnFailure', () => {
  it('keeps the three refusals distinguishable — the fix differs for each', () => {
    // spec/04 § Spawn: a missing folder is fixed by naming another folder; a
    // missing catalogue by naming a model or connecting the credential there.
    expect(describeSpawnFailure(new FolderNotFoundError('/no/such'))).toEqual({
      code: 'folder_not_found',
      message: 'folder does not exist or is not a directory: /no/such',
    });
    expect(describeSpawnFailure(new NoModelCatalogueError('host-x')).code).toBe(
      'no_model_catalogue',
    );
    expect(describeSpawnFailure(new Error('the SDK fell over'))).toEqual({
      code: 'sdk_error',
      message: 'the SDK fell over',
    });
  });

  it('still says something when the failure was not an Error at all', () => {
    expect(describeSpawnFailure('not even an error')).toEqual({
      code: 'sdk_error',
      message: 'not even an error',
    });
  });
});
