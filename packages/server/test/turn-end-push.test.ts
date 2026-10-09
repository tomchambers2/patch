// Turn-end push, end to end through the real assembled server (spec/09 §
// Chat completion + § Whose turn it was).
//
// The unit tests either side of this one cover the host stamping an origin
// and the notifier's decision in isolation. This one wires the actual `build()`
// app to a real push-shaped backend and pushes `chat.state` frames in the way a
// host does, so the whole chain — host frame → wire decode → chat registry
// → notifier → router → presence suppression → push payload — is exercised as
// one piece. It is the test that would have caught the wire field being dropped
// by a strict schema, which is the failure mode that makes this feature look
// silently fine while notifying nobody.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { generateUserKeypair } from '@patch/auth';
import { Registry } from '../src/registry.js';
import type { PushBackend } from '../src/notifications/router.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { build } from '../src/app.js';

const ACCOUNT = generateUserKeypair(() => new Uint8Array(32).fill(7));

function fakePush(): {
  backend: PushBackend;
  sent: {
    tokens: string[];
    payload: { title: string; body: string; data?: Record<string, string> };
  }[];
} {
  const sent: {
    tokens: string[];
    payload: { title: string; body: string; data?: Record<string, string> };
  }[] = [];
  return {
    sent,
    backend: {
      send: async (tokens, payload) => {
        sent.push({ tokens, payload: payload as (typeof sent)[number]['payload'] });
        return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
      },
    },
  };
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'patch-turn-end-'));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: ACCOUNT });
  // A phone that has registered for push, and nothing foregrounded on a
  // computer — Tom walked away from the machine, which is the whole case.
  registry.registerPushToken({
    surfaceId: 'srf-phone',
    accountId: ACCOUNT.publicKey,
    token: 'fcm-phone-token',
    registeredAt: 1,
  });
  const link = new InProcessDaemonLink();
  const push = fakePush();
  const app = await build({
    dataDir: dir,
    registry,
    daemonLink: link,
    pushBackend: push.backend,
    jobsWatch: false,
  });
  return { app, link, push };
}

function spawned(chatId: string): WireEvent {
  return {
    type: 'chat.spawned',
    chatId,
    daemonId: 'd1',
    folder: '/home/tom/projects/bed-planner',
    seq: 1,
    ts: 0,
  } as WireEvent;
}

function state(chatId: string, over: Record<string, unknown>): WireEvent {
  return {
    type: 'chat.state',
    chatId,
    daemonId: 'd1',
    activity: 'idle',
    permissionMode: 'auto',
    folder: '/home/tom/projects/bed-planner',
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    ...over,
  } as WireEvent;
}

/** Run a whole turn through the link, exactly as a host emits it. */
function runTurn(link: InProcessDaemonLink, chatId: string, over: Record<string, unknown>): void {
  link.emit(state(chatId, { activity: 'running', ...over }));
  link.emit(state(chatId, { activity: 'idle', ...over }));
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('turn-end push, end to end (spec/09 § Chat completion)', () => {
  it('pushes to the registered phone when a user turn ends', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      runTurn(link, 'c1', { name: 'bed planner', turnOrigin: 'user' });
      await settle();

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]?.tokens).toEqual(['fcm-phone-token']);
      expect(push.sent[0]?.payload.body).toContain('bed planner');
    } finally {
      await app.close();
    }
  });

  // The tap has to land in the chat that finished, not just open the app.
  it('carries the chat id so tapping the push opens that chat', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      runTurn(link, 'c1', { name: 'bed planner', turnOrigin: 'user' });
      await settle();

      expect(push.sent[0]?.payload.data?.['chatId']).toBe('c1');
      expect(push.sent[0]?.payload.title).toBe('Patch');
    } finally {
      await app.close();
    }
  });

  // Tom's parenthetical, proven at the level that actually reaches his phone.
  it('stays silent for a machine turn — the watcher loop does not ring', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      for (let i = 0; i < 5; i++) {
        runTurn(link, 'c1', { name: 'site watcher', turnOrigin: 'machine' });
      }
      await settle();

      expect(push.sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('stays silent for an archived chat — the hidden job spawn case', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      runTurn(link, 'c1', { name: 'nightly job', turnOrigin: 'user', status: 'archived' });
      await settle();

      expect(push.sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a user turn in the same chat still pushes after a run of silent ones', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      runTurn(link, 'c1', { name: 'site watcher', turnOrigin: 'machine' });
      runTurn(link, 'c1', { name: 'site watcher', turnOrigin: 'machine' });
      runTurn(link, 'c1', { name: 'site watcher', turnOrigin: 'user' });
      await settle();

      expect(push.sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // The wire schema is strict: a `turnOrigin` the server's zod does not know
  // about would take the WHOLE frame out, and every turn would go silent.
  it('the turnOrigin field survives a real wire decode', async () => {
    const { app, link, push } = await harness();
    try {
      const { ChatStateEvent } = await import('@patch/wire');
      // The payload schema, without the `seq`/`ts` envelope the hub adds.
      const decoded = ChatStateEvent.parse({
        type: 'chat.state',
        chatId: 'c1',
        daemonId: 'd1',
        activity: 'idle',
        permissionMode: 'auto',
        folder: '/home/tom/projects/bed-planner',
        lastUpdated: 0,
        turnOrigin: 'machine',
      });
      expect(decoded.turnOrigin).toBe('machine');

      // And a host that predates the field still notifies, rather than
      // silently going quiet.
      link.emit(spawned('c2'));
      runTurn(link, 'c2', { name: 'old host chat' });
      await settle();
      expect(push.sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
