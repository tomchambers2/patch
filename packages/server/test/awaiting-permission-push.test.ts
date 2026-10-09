// Blocked-on-the-user push, end to end through the real assembled server
// (spec/09 § Waiting on you).
//
// The unit test beside this one covers the notifier's decision in isolation.
// This one wires the actual `build()` app to a real push-shaped backend and
// pushes the frames a host really emits when a turn parks on the user, so the
// whole chain — host frames → wire decode → chat registry → notifier →
// router → presence suppression → push payload — is exercised as one piece.
//
// It is the test that fails on the code as it was before this feature: a turn
// that stops to ask never reaches `idle`, so chat completion never fired for it
// and an agent could wait on Tom for ever while his phone said nothing.

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
  const dir = mkdtempSync(join(tmpdir(), 'patch-awaiting-perm-'));
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

/**
 * The frames a host emits when a turn blocks on the user, in the order
 * `chatRunner.ts`'s `handlePermissionEnvelope` emits them: the request, then
 * the state that parks the chat.
 */
function blockTurn(
  link: InProcessDaemonLink,
  chatId: string,
  request: { tool: string; args?: unknown; description?: string },
  over: Record<string, unknown> = {},
): void {
  link.emit(state(chatId, { activity: 'running', ...over }));
  link.emit({
    type: 'chat.permission_request',
    chatId,
    requestId: `req-${chatId}`,
    request: { args: {}, ...request },
    seq: 3,
    ts: 0,
  } as WireEvent);
  link.emit(state(chatId, { activity: 'awaiting-permission', ...over }));
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('blocked-on-the-user push, end to end (spec/09 § Waiting on you)', () => {
  it('pushes to the registered phone when a turn stops for permission', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      blockTurn(
        link,
        'c1',
        { tool: 'Bash', description: 'Run: rm -rf build' },
        { name: 'bed planner', turnOrigin: 'user' },
      );
      await settle();

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]?.tokens).toEqual(['fcm-phone-token']);
      expect(push.sent[0]?.payload.body).toBe('bed planner needs permission: Run: rm -rf build');
      expect(push.sent[0]?.payload.data?.['chatId']).toBe('c1');
    } finally {
      await app.close();
    }
  });

  it('pushes the question text when the agent asks one', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      blockTurn(
        link,
        'c1',
        {
          tool: 'AskUserQuestion',
          args: {
            questions: [
              {
                header: 'Beds',
                question: 'Which bed should the beans go in?',
                options: [
                  { label: 'North', description: '' },
                  { label: 'South', description: '' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        { name: 'bed planner', turnOrigin: 'user' },
      );
      await settle();

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]?.payload.body).toBe(
        'bed planner asks: Which bed should the beans go in?',
      );
    } finally {
      await app.close();
    }
  });

  // The inverse of chat completion's rule, and the case the feature is really
  // for: an unattended job stops to ask, and nobody is watching its chat.
  it('pushes for a machine-started turn — chat completion would not have', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      blockTurn(
        link,
        'c1',
        { tool: 'Bash', description: 'Run: git push' },
        { name: 'nightly job', turnOrigin: 'machine' },
      );
      await settle();

      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]?.payload.body).toBe('nightly job needs permission: Run: git push');
    } finally {
      await app.close();
    }
  });

  it('pushes once, not once per re-emitted state frame', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      blockTurn(
        link,
        'c1',
        { tool: 'Bash', description: 'Run: git push' },
        { name: 'bed planner', turnOrigin: 'user' },
      );
      for (let i = 0; i < 4; i++) {
        link.emit(state('c1', { activity: 'awaiting-permission', name: 'bed planner' }));
      }
      await settle();

      expect(push.sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // Snoozed means "not now", and it means that for a block as much as for a
  // completion. Asserted here rather than only in the unit test because this is
  // the path that reads the wall clock rather than an injected one.
  it('does not push for a snoozed chat', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      blockTurn(
        link,
        'c1',
        { tool: 'Bash', description: 'Run: git push' },
        { name: 'bed planner', turnOrigin: 'user', snoozedUntil: Date.now() + 3_600_000 },
      );
      await settle();

      expect(push.sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // Answering it must not ring again, and the settle-to-idle afterwards is a
  // normal completion handled by the other notifier.
  it('does not push when the permission is answered and the chat runs on', async () => {
    const { app, link, push } = await harness();
    try {
      link.emit(spawned('c1'));
      blockTurn(
        link,
        'c1',
        { tool: 'Bash', description: 'Run: git push' },
        { name: 'bed planner', turnOrigin: 'machine' },
      );
      await settle();
      push.sent.length = 0;

      link.emit(state('c1', { activity: 'running', name: 'bed planner', turnOrigin: 'machine' }));
      link.emit(state('c1', { activity: 'idle', name: 'bed planner', turnOrigin: 'machine' }));
      await settle();

      expect(push.sent).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
