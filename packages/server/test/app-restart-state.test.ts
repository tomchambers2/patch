// The whole app across a restart (spec/01 § Chat state, spec/08 § Concurrency):
// the chat mirror is read back from disk and the job dispatcher settles the slots
// a previous process left behind against it, with the evidence rule wired in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

const JOB_ID = 'j_00000000000000000000000012';
const ACQUIRED = 1_700_000_000_000;

describe('the app after a restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-app-restart-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** What a previous process left on disk: a held slot, and what the mirror last knew. */
  function leaveBehind(opts: { activity: string; workedAt?: number }): string {
    mkdirSync(join(dir, 'inflight'), { recursive: true });
    const file = join(dir, 'inflight', `${JOB_ID}-fire1.json`);
    writeFileSync(
      file,
      JSON.stringify({
        jobId: JOB_ID,
        chatId: 'c1',
        localId: 'fire1',
        acquiredAt: ACQUIRED,
        concurrency: 1,
        trigger: 'todoist',
        actionType: 'spawn',
        daemonId: 'd1',
      }),
    );
    writeFileSync(
      join(dir, 'chat-registry.json'),
      JSON.stringify({
        version: 1,
        chats: [
          {
            chatId: 'c1',
            name: null,
            preview: null,
            daemonId: 'd1',
            folder: '/w',
            activity: opts.activity,
            status: 'active',
            lastUpdated: ACQUIRED + 1,
            jobId: JOB_ID,
          },
        ],
        worked: opts.workedAt === undefined ? {} : { c1: opts.workedAt },
      }),
    );
    return file;
  }

  async function boot(first = true) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(61));
    const registry = Registry.load(dir);
    if (first) registry.bootstrapAccount({ keypair: user });
    const link = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink: link });
    return { built, link };
  }

  it('releases a slot at once for a chat last known idle that had been seen working', async () => {
    const slot = leaveBehind({ activity: 'idle', workedAt: ACQUIRED + 5_000 });
    const { built, link } = await boot();
    try {
      expect(built.chatRegistry.get('c1')?.activity).toBe('idle');
      link.setStatus('offline');
      link.setStatus('online');
      expect(existsSync(slot)).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('keeps the slot for a chat last known idle that was never seen working', async () => {
    const slot = leaveBehind({ activity: 'idle' });
    const { built, link } = await boot();
    try {
      link.setStatus('offline');
      link.setStatus('online');
      expect(existsSync(slot)).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('keeps the slot for a chat last known to be working', async () => {
    const slot = leaveBehind({ activity: 'running', workedAt: ACQUIRED + 5_000 });
    const { built, link } = await boot();
    try {
      link.setStatus('offline');
      link.setStatus('online');
      expect(existsSync(slot)).toBe(true);
    } finally {
      await built.app.close();
    }
  });

  it('writes the mirror out when it shuts down', async () => {
    const { built, link } = await boot();
    link.emit({ type: 'chat.spawned', chatId: 'c9', daemonId: 'd1', folder: '/w' });
    await built.app.close();
    const again = await boot(false);
    try {
      expect(again.built.chatRegistry.get('c9')).toBeDefined();
    } finally {
      await again.built.app.close();
    }
  });
});
