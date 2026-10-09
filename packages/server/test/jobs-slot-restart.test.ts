// A job's concurrency slot across a server restart (spec/08 ## Concurrency).
// The server restores what it last knew about each chat, so a chat last known
// to have finished gives its slot back at once, a chat last known to be working
// keeps it, and only a chat the server genuinely knows nothing about waits for
// the bounded timeout.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import type { Job } from '../src/jobs/types.js';

const logger = pino({ level: 'debug' });
const JOB_ID = 'j_00000000000000000000000012';

const job: Job = {
  id: JOB_ID,
  name: 'app updates',
  enabled: true,
  trigger: { type: 'todoist' },
  filter: null,
  action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
  createdAt: 1,
  updatedAt: 1,
  concurrency: 1,
};

const seqIds = (): (() => string) => {
  let n = 0;
  return () => `id${++n}`;
};

const spawned = (chatId: string): WireEvent =>
  ({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' }) as WireEvent;
const state = (chatId: string, activity: string, over: Record<string, unknown> = {}): WireEvent =>
  ({
    type: 'chat.state',
    chatId,
    daemonId: 'd1',
    activity,
    permissionMode: 'bypassPermissions',
    lastUpdated: 1,
    ...over,
  }) as WireEvent;
/** What a host reports for a chat that took its first message and has been idle since a while after the slot began. */
const finishedReport = (chatId: string): WireEvent =>
  state(chatId, 'idle', { preview: 'go', lastUpdated: Date.now() + 60_000 });
const foldersList = (): WireEvent =>
  ({ type: 'folders.list', daemonId: 'd1', roots: [], recent: [] }) as WireEvent;

const spawnRequests = (link: InProcessDaemonLink): string[] =>
  link.sent
    .filter((s) => s.event.type === 'chat.spawn_request')
    .map((s) => (s.event.type === 'chat.spawn_request' ? s.event.chatId : ''));

describe('a job slot across a server restart', () => {
  let dir: string;
  let registryPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-slotrestart-'));
    registryPath = join(dir, 'chat-registry.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One server process: a registry, a dispatcher and the link between them, wired as app.ts does. */
  function boot() {
    const link = new InProcessDaemonLink();
    const registry = new ChatRegistry({
      logger,
      persistPath: registryPath,
      jobChatLinks: { get: () => JOB_ID },
    });
    link.onEvent((e) => registry.observe(e));
    const dispatcher = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger,
      idGenerator: seqIds(),
      chatActivity: (chatId) => registry.get(chatId)?.activity ?? null,
      chatHasWorked: (chatId, since) => registry.hasWorkedSince(chatId, since),
    });
    return { link, registry, dispatcher };
  }

  /** The state a first process leaves behind: a fire running in a chat, one more waiting. */
  async function firstProcess(
    lastKnown: 'running' | 'idle' | 'errored' | 'never-ran',
  ): Promise<string> {
    const p = boot();
    expect(p.dispatcher.dispatch(job, { n: 1 }, 'todoist').status).toBe('sent');
    expect(p.dispatcher.dispatch(job, { n: 2 }, 'todoist').status).toBe('queued');
    const chatId = spawnRequests(p.link)[0] as string;
    p.link.emit(spawned(chatId));
    // A chat that has only been announced reports idle, before its first turn.
    if (lastKnown !== 'never-ran') p.link.emit(state(chatId, 'running'));
    // What the registry last knew. The dispatcher goes down before it sees the
    // chat finish, which is how a slot is left behind for a chat that is done.
    if (lastKnown !== 'running' && lastKnown !== 'never-ran') {
      p.registry.observe(state(chatId, lastKnown));
    }
    p.registry.flush();
    // A dispatcher acts once on startup, a tick after it is built. Let that happen
    // before this process "stops", or it would run against the next one's files.
    await Promise.resolve();
    p.dispatcher.close();
    return chatId;
  }

  it('a chat last known to have finished gives its slot back at once, without waiting for the timeout', async () => {
    await firstProcess('idle');
    const p = boot();
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });

    p.link.setStatus('offline');
    p.link.setStatus('online'); // the host comes back: slots are checked against what the server knew

    expect(spawnRequests(p.link)).toHaveLength(1); // the waiting fire went out
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });
    p.dispatcher.close();
  });

  it('a chat last known to have errored gives its slot back too', async () => {
    await firstProcess('errored');
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    expect(spawnRequests(p.link)).toHaveLength(1);
    p.dispatcher.close();
  });

  it('a chat last known to be working keeps its slot, and frees it when it finishes', async () => {
    const chatId = await firstProcess('running');
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    expect(spawnRequests(p.link)).toHaveLength(0);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });

    // The host reports it finished: the slot goes, once.
    p.link.emit(state(chatId, 'idle'));
    expect(spawnRequests(p.link)).toHaveLength(1);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });
    p.dispatcher.close();
  });

  it('a chat the server knows nothing about keeps its slot, and the host closing its list does not free it', async () => {
    await firstProcess('idle');
    rmSync(registryPath); // nothing was saved: the server really does not know this chat
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    p.link.emit(foldersList()); // the host reports, and does not mention that chat
    await Promise.resolve();
    expect(spawnRequests(p.link)).toHaveLength(0);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    p.dispatcher.close();
  });

  it('with nothing saved, the host telling the server the chat is idle frees the slot as soon as its list closes', async () => {
    const chatId = await firstProcess('idle');
    rmSync(registryPath); // the first start after this change, or a lost file
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    expect(spawnRequests(p.link)).toHaveLength(0); // unknown for now

    // The host re-announces: the chat exists and is idle, then its list closes.
    p.link.emit(spawned(chatId));
    p.link.emit(finishedReport(chatId));
    p.link.emit(foldersList());
    await Promise.resolve();

    expect(spawnRequests(p.link)).toHaveLength(1);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 0 });
    p.dispatcher.close();
  });

  it('with nothing saved, a chat the host reports as still working keeps its slot', async () => {
    const chatId = await firstProcess('idle');
    rmSync(registryPath);
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    p.link.emit(spawned(chatId));
    p.link.emit(state(chatId, 'running'));
    p.link.emit(foldersList());
    await Promise.resolve();
    expect(spawnRequests(p.link)).toHaveLength(0);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    p.dispatcher.close();
  });

  it('a chat last known idle that was never seen working keeps its slot: it may not have started yet', async () => {
    const chatId = await firstProcess('never-ran');
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    expect(spawnRequests(p.link)).toHaveLength(0);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });

    // Once it does run and finish, the slot goes.
    p.link.emit(state(chatId, 'running'));
    p.link.emit(state(chatId, 'idle'));
    expect(spawnRequests(p.link)).toHaveLength(1);
    p.dispatcher.close();
  });

  it('with nothing saved, a chat the host reports idle only just after its slot began keeps it', async () => {
    const chatId = await firstProcess('idle');
    rmSync(registryPath);
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    p.link.emit(spawned(chatId));
    p.link.emit(state(chatId, 'idle', { preview: 'go', lastUpdated: Date.now() + 1_000 }));
    p.link.emit(foldersList());
    await Promise.resolve();
    expect(spawnRequests(p.link)).toHaveLength(0);
    expect(p.dispatcher.counts(JOB_ID)).toEqual({ inFlight: 1, queued: 1 });
    p.dispatcher.close();
  });

  it('with nothing saved, a chat the host reports idle with no first message accepted keeps its slot', async () => {
    const chatId = await firstProcess('idle');
    rmSync(registryPath);
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    p.link.emit(spawned(chatId));
    p.link.emit(state(chatId, 'idle', { lastUpdated: Date.now() + 60_000 }));
    p.link.emit(foldersList());
    await Promise.resolve();
    expect(spawnRequests(p.link)).toHaveLength(0);
    p.dispatcher.close();
  });

  it('an errored chat gives its slot back whether or not it was seen working', async () => {
    const chatId = await firstProcess('never-ran');
    const p = boot();
    p.link.setStatus('offline');
    p.link.setStatus('online');
    expect(spawnRequests(p.link)).toHaveLength(0);
    p.link.emit(state(chatId, 'errored'));
    expect(spawnRequests(p.link)).toHaveLength(1);
    p.dispatcher.close();
  });
});
