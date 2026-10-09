// A DECLARED status outlives the things that would quietly lose it
// (spec/04 § Current status).
//
// `statusSummary`/`statusKind` are ordinarily generated per turn and held in
// memory: cheap, disposable, rebuilt on the next tick. A status the AGENT
// declared is a different kind of fact — it is the chat saying "I am blocked on
// you" or "this one is worth your morning", and it is the only reason a hidden
// job is in the list at all. Three things used to be able to erase it, all of
// them silently, and each has a test here.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

function makeDaemon(home: string, events: WireEvent[]) {
  let id = 0;
  return new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => `chat-${++id}`,
  });
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-declared-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-declared-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const daemon = makeDaemon(home, events);
  const chatId = await daemon.spawnChat({ folder });
  await daemon.setArchived(chatId, true);
  return { home, folder, daemon, chatId, events };
}

describe('a declared status survives what would erase a generated one', () => {
  it('survives a host restart — every deploy performs one', async () => {
    const { home, daemon, chatId } = await setup();
    await daemon.declareStatus(chatId, 'question', 'plug the drive in');
    expect(daemon.chatState.get(chatId)?.status).toBe('active');

    // A second host over the same home is exactly what a deploy leaves behind.
    const restarted = makeDaemon(home, []);
    await restarted.hydrate();
    const state = restarted.chatState.get(chatId);
    expect(state?.declaredStatus).toMatchObject({ kind: 'question', text: 'plug the drive in' });
    expect(state?.statusKind, 'the row must still say what it needs').toBe('question');
    expect(state?.statusSummary).toBe('plug the drive in');
    expect(state?.status, 'and it must not go back into hiding').toBe('active');
  });

  it('is NOT cleared by a machine turn — the chat carrying on is not somebody reading it', async () => {
    const { daemon, chatId } = await setup();
    await daemon.declareStatus(chatId, 'question', 'sign the form');
    await daemon.sendInput({
      chatId,
      message: '[wake] checking again',
      localId: 'm1',
      origin: 'machine',
    });
    const state = daemon.chatState.get(chatId);
    expect(state?.declaredStatus).toMatchObject({ kind: 'question' });
    expect(state?.statusKind).toBe('question');
  });

  it('IS cleared by a user turn — that is the one thing that means they saw it', async () => {
    const { daemon, chatId } = await setup();
    await daemon.declareStatus(chatId, 'report', 'the backup has been failing since Tuesday');
    await daemon.sendInput({ chatId, message: 'ok, looking', localId: 'u1' });
    const state = daemon.chatState.get(chatId);
    expect(state?.declaredStatus).toBeNull();
    expect(state?.statusKind).toBeNull();
  });

  it('outranks the per-turn summariser, which cannot demote it to complete', async () => {
    // The real path: a turn settles, the generator reads the exchange and says
    // `complete`, and the host applies it. A declared status has to make that
    // apply a no-op — otherwise the agent says "I am blocked on you" and a model
    // reading the transcript a second later drops the chat back out of the list.
    const home = mkdtempSync(join(tmpdir(), 'patch-declared-gen-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-declared-gen-folder-')));
    mkdirSync(folder, { recursive: true });
    let id = 0;
    let generated = 0;
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: () => {},
      logger: silent,
      now: () => NOW,
      generateChatId: () => `chat-${++id}`,
      generateStatus: () => {
        generated += 1;
        return Promise.resolve({ kind: 'complete' as const, summary: 'all done here' });
      },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.declareStatus(chatId, 'question', 'plug the drive in');

    sdk.enqueue([
      { type: 'assistant', content: 'carrying on with what I can' },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    await daemon.sendInput({
      chatId,
      message: '[wake] anything else possible?',
      localId: 'm1',
      origin: 'machine',
    });
    // The generator is fired async off the settle; give it a turn of the loop.
    await new Promise((r) => setTimeout(r, 50));

    const state = daemon.chatState.get(chatId);
    expect(generated, 'the generator still runs — this is a guard on the WRITE').toBeGreaterThan(0);
    expect(state?.statusKind).toBe('question');
    expect(state?.statusSummary).toBe('plug the drive in');
  });

  it('a report on an already-active chat still lands, without an un-archive', async () => {
    const { daemon, folder } = await setup();
    const activeChat = await daemon.spawnChat({ folder });
    await daemon.declareStatus(activeChat, 'report', 'found three duplicates');
    const state = daemon.chatState.get(activeChat);
    expect(state?.status).toBe('active');
    expect(state?.statusKind).toBe('report');
    expect(state?.statusSummary).toBe('found three duplicates');
  });
});
