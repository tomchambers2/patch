// C1: sequence durability (spec/02-daemon.md "Sequence durability").
//
// Every seq the host hands out is recorded in the chat's history log
// (~/.patch/chats/<chatId>/events.jsonl). On restart the seq resumes above the
// highest one the log, meta.json or the legacy `seq` file remembers, so replay
// survives crashes — seqs are never reused.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function makeDaemon(home: string, sdk = createMockSdkBackend()) {
  const events: WireEvent[] = [];
  let id = 0;
  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, metaStore };
}

describe('C1 sequence durability', () => {
  it('records every seq in the chat history log, and mirrors nextSeq into meta.json when the turn settles', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-seq-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-seq-folder-'));
    mkdirSync(folder, { recursive: true });
    const { daemon, sdk, metaStore } = makeDaemon(home);
    sdk.enqueue([
      { type: 'assistant', content: 'a' },
      { type: 'assistant', content: 'b' },
      { type: 'assistant', content: 'c' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    // The per-emit `seq` file is no longer written — the log is the authority.
    expect(existsSync(join(home, 'chats', chatId, 'seq'))).toBe(false);
    const seqs = readFileSync(join(home, 'chats', chatId, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { seq: number; rec: { k: string } })
      .filter((r) => r.rec.k === 'event')
      .map((r) => r.seq);
    // 4 emits — the user turn at seq 0 plus three assistant messages.
    expect(seqs).toEqual([0, 1, 2, 3]);
    // meta.json mirror agrees once the turn has settled.
    expect(metaStore.read(chatId)?.nextSeq).toBe(4);
    daemon.shutdown();
  });

  it('on restart the seq resumes from the persisted value — replay never reuses a seq', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-seq-restart-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-seq-restart-folder-'));
    mkdirSync(folder, { recursive: true });

    // First host lifetime: the user turn (seq 0) plus two assistant messages
    // (seqs 1,2) → nextSeq=3.
    {
      const { daemon, sdk } = makeDaemon(home);
      sdk.enqueue([
        { type: 'assistant', content: 'a', sessionId: 'S' },
        { type: 'assistant', content: 'b', sessionId: 'S' },
      ]);
      await daemon.spawnChat({ folder, prompt: 'first', chatId: 'restart-chat' });
      await new Promise((r) => setTimeout(r, 30));
      daemon.shutdown();
    }

    // Second host lifetime: fresh process, hydrate from disk, send again.
    const { daemon, sdk, events } = makeDaemon(home);
    daemon.hydrate();
    expect(daemon.chatState.get('restart-chat')?.nextSeq).toBe(3);
    // Behaviour #1: hydrate marks idle and does NOT auto-resume any chat —
    // no SDK query ran, so the backend was never invoked.
    expect(daemon.chatState.get('restart-chat')?.activity).toBe('idle');
    expect(sdk.lastOptions()).toBeUndefined();

    sdk.enqueue([{ type: 'assistant', content: 'c', sessionId: 'S' }]);
    await daemon.sendInput({ chatId: 'restart-chat', message: 'again', localId: 'L1' });

    const seqs = events
      .filter((e) => e.type === 'chat.message')
      .map((e) => (e as unknown as { seq: number }).seq);
    // The post-restart turn continues at seq=3 (its user turn), not 0.
    expect(seqs).toEqual([3, 4]);
    daemon.shutdown();
  });

  it('hydrate takes the max of meta.nextSeq and the legacy seq file (older hosts wrote it)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-seq-skew-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-seq-skew-folder-'));
    mkdirSync(folder, { recursive: true });
    const metaStore = createMetaStore(home);
    // Simulate a crash where the seq file got ahead of meta.json.
    metaStore.write({
      chatId: 'skew-chat',
      folder,
      name: null,
      nextSeq: 4,
      createdAt: 1,
      updatedAt: 2,
    });
    metaStore.writeSeq('skew-chat', 5);

    const { daemon } = makeDaemon(home, createMockSdkBackend());
    daemon.hydrate();
    expect(daemon.chatState.get('skew-chat')?.nextSeq).toBe(5);
    daemon.shutdown();
  });

  it('hydrate resumes above the history log even when meta.json and the seq file lag behind', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-seq-log-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-seq-log-folder-'));
    mkdirSync(folder, { recursive: true });
    {
      const { daemon, sdk } = makeDaemon(home);
      sdk.enqueue([
        { type: 'assistant', content: 'a', sessionId: 'S' },
        { type: 'assistant', content: 'b', sessionId: 'S' },
      ]);
      await daemon.spawnChat({ folder, prompt: 'first', chatId: 'log-chat' });
      await new Promise((r) => setTimeout(r, 30));
      // Seqs handed out outside a turn are mirrored nowhere but the log.
      daemon.allocErrorSeq('log-chat');
      daemon.allocErrorSeq('log-chat');
    }
    // No shutdown: meta.json still says 3.
    const metaStore = createMetaStore(home);
    expect(metaStore.read('log-chat')?.nextSeq).toBe(3);
    const { daemon } = makeDaemon(home);
    daemon.hydrate();
    expect(daemon.chatState.get('log-chat')?.nextSeq).toBe(5);
    daemon.shutdown();
  });
});
