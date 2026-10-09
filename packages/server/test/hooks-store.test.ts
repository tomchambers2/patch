// HookStore CRUD + atomic write + reload (mirrors jobs-store.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { HookStore } from '../src/hooks/store.js';
import type { HookCreateBody } from '../src/hooks/types.js';

const silentLogger = pino({ level: 'silent' });

function scriptHook(name = 'test'): HookCreateBody {
  return {
    name,
    when: 'user_message',
    kind: 'script',
    script: { command: 'exit 0' },
  };
}

describe('HookStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hooks-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, lists, gets, patches, and deletes hooks', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(store.list()).toEqual([]);
      const hook = store.create(scriptHook('first'));
      expect(hook.id).toMatch(/^hook_/);
      expect(hook.enabled).toBe(true);
      expect(hook.timeoutMs).toBe(15_000);
      expect(store.list()).toHaveLength(1);
      expect(store.get(hook.id)).toEqual(hook);

      const patched = store.patch(hook.id, { name: 'renamed', enabled: false });
      expect(patched.name).toBe('renamed');
      expect(patched.enabled).toBe(false);
      expect(patched.updatedAt).toBeGreaterThanOrEqual(hook.createdAt);

      expect(store.delete(hook.id)).toBe(true);
      expect(store.list()).toEqual([]);
      expect(store.delete(hook.id)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('persists hooks atomically to disk', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      store.create(scriptHook('alpha'));
      const files = readdirSync(join(dir, 'hooks'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^hook_.*\.json$/);
    } finally {
      await store.close();
    }
  });

  it('reloads hooks written to disk by a previous process', async () => {
    const first = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    const created = first.create(scriptHook('persisted'));
    await first.close();

    const second = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(second.get(created.id)).toEqual(created);
    } finally {
      await second.close();
    }
  });

  it('enable/disable toggle without touching other fields', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const hook = store.create(scriptHook());
      const disabled = store.disable(hook.id);
      expect(disabled.enabled).toBe(false);
      const enabled = store.enable(hook.id);
      expect(enabled.enabled).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('rejects a kind/script mismatch at create time', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(() =>
        store.create({
          name: 'bad',
          when: 'user_message',
          kind: 'prompt',
          script: { command: 'x' },
        }),
      ).toThrow(/requires "prompt"/);
    } finally {
      await store.close();
    }
  });

  it('accepts agent_response (spec/20-hooks.md § On the agent’s response)', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const hook = store.create({ ...scriptHook(), when: 'agent_response' });
      expect(hook.when).toBe('agent_response');
    } finally {
      await store.close();
    }
  });

  it('rejects an unknown when value', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      expect(() =>
        store.create({ ...scriptHook(), when: 'turn_started' } as unknown as HookCreateBody),
      ).toThrow(/not implemented/);
    } finally {
      await store.close();
    }
  });

  it('notifies onChange handlers of created/updated/deleted', async () => {
    const store = new HookStore({ dataDir: dir, logger: silentLogger, watch: false });
    try {
      const events: string[] = [];
      const unsub = store.onChange((e) => events.push(e.type));
      const hook = store.create(scriptHook());
      store.patch(hook.id, { name: 'x' });
      store.delete(hook.id);
      unsub();
      store.create(scriptHook());
      expect(events).toEqual(['created', 'updated', 'deleted']);
    } finally {
      await store.close();
    }
  });
});
