// spec/04 § Hidden, spec/08 ## Action — a hidden job run that turns out to
// need the user stops being hidden.
//
// `startHidden` spawns a job's chat into Hidden, which is right for a
// five-minute tick whose fires are pure noise. It is wrong the moment that run
// blocks: a hidden chat sits out of the active list, so a permission card or an
// `AskUserQuestion` posted there waits for someone who has no reason to look.
// Reaching `awaiting-permission` therefore un-hides the chat.
//
// One-way, deliberately. Answering does not re-hide it: the chat surfaced
// because it needed the user, and from then on it behaves like any other chat.

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

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-unhide-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-unhide-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, folder, metaStore };
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function pendingRequestId(events: WireEvent[]): string {
  const req = events.find((e) => e.type === 'chat.permission_request');
  expect(req).toBeDefined();
  return (req as unknown as { requestId: string }).requestId;
}

describe('a hidden chat un-hides when it blocks on the user', () => {
  it('a permission request on a hidden job run puts it back in the inbox', async () => {
    const { daemon, events, folder, metaStore } = setup();
    // A `hidden` job fire, running under a mode that blocks an ordinary tool call.
    const chatId = await daemon.spawnChat({
      folder,
      hidden: true,
      permissionMode: 'default',
      prompt: '[[bash-permission]]',
    });
    expect(metaStore.read(chatId)?.hidden).toBe(true);
    await tick();

    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    // Persisted, not only in memory — a host restart must not re-bury it.
    expect(metaStore.read(chatId)?.hidden).toBe(false);
    // And the surfaces were told, so the row moves without a reload.
    const last = events.filter((e) => e.type === 'chat.state' && e.chatId === chatId).at(-1);
    expect((last as { hidden?: boolean }).hidden).toBe(false);
  });

  it('an AskUserQuestion on a hidden job run puts it back in the inbox', async () => {
    const { daemon, events, folder, metaStore } = setup();
    // No blocking mode needed: a question reaches the gate under every mode,
    // so this is the case a `hidden` + `auto` job actually hits.
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    expect(metaStore.read(chatId)?.hidden).toBe(true);
    // Not awaited: the turn parks on the question, so this settles only once
    // the answer comes back.
    void daemon.sendInput({ chatId, message: '[[ask-user-question]]', localId: 'L1' });
    await tick();

    const req = events.find((e) => e.type === 'chat.permission_request') as
      | { request: { tool: string } }
      | undefined;
    expect(req?.request.tool).toBe('AskUserQuestion');
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(metaStore.read(chatId)?.hidden).toBe(false);
  });

  it('stays in the list after the question is answered', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({
      folder,
      hidden: true,
      prompt: '[[ask-user-question]]',
    });
    await tick();
    daemon.submitPermissionResponse({
      requestId: pendingRequestId(events),
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which date library should we use?': 'date-fns' }),
    });
    await tick();

    // The turn ran on and settled…
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('awaiting-permission');
    // …and the chat stayed where the user can see it — neither hidden again
    // nor archived.
    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(metaStore.read(chatId)?.status).toBe('active');
  });

  it('stays in the list after the permission is denied', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({
      folder,
      hidden: true,
      permissionMode: 'default',
      prompt: '[[bash-permission]]',
    });
    await tick();
    daemon.submitPermissionResponse({ requestId: pendingRequestId(events), decision: 'deny' });
    await tick();

    expect(daemon.chatState.get(chatId)?.hidden).toBe(false);
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(metaStore.read(chatId)?.status).toBe('active');
  });

  it('a hidden run that never blocks finishes out of the list, in Hidden', async () => {
    const { daemon, folder, metaStore } = setup();
    // The ordinary hidden-job case: a run under `auto` that never asks
    // anything must stay out of the inbox.
    const chatId = await daemon.spawnChat({
      folder,
      hidden: true,
      permissionMode: 'auto',
      prompt: '[[bash-permission]]',
    });
    await tick();

    expect(daemon.chatState.get(chatId)?.activity).not.toBe('awaiting-permission');
    // Never came into the list, and finishing does not archive it: a job chat
    // is never in Archived, so a later ask_human only has to un-hide it.
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
    expect(metaStore.read(chatId)?.status).toBe('active');
    expect(metaStore.read(chatId)?.hidden).toBe(true);
  });
});
