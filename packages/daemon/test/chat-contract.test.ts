// The chat contracts a SURFACE depends on.
//
// Why this file exists: chat broke in production while ~5,000 unit tests were
// green, because every failure was a contract MISMATCH between two sides that
// were each internally consistent:
//
//   - The web renders an optimistic bubble carrying a `localId`, and reconciles
//     it against the persisted echo on replay. The host emitted that echo with
//     no `localId`, so nothing matched and every first message rendered TWICE.
//     The host's own test used `toMatchObject`, which ignores absent fields;
//     the web's own tests built replay fixtures that already had a `localId`.
//     Both suites proved their own half and neither proved the seam.
//
//   - A turn refused for a missing credential emitted `daemon.unauthenticated`
//     and went idle. Nothing reached the CHAT, so the message sat there with no
//     reply and no reason.
//
// So these assert the host's OUTPUT as a surface actually consumes it, on the
// paths that broke. They use the real Host and the real event stream — the
// mock is only the agent backend, so no network and no credential is needed.

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

function setup(opts: { signedIn?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-contract-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    // The gate under test: a machine whose credential does not resolve.
    resolveOAuth: () =>
      opts.signedIn === false
        ? { ok: false as const, reason: 'Refresh token expired' }
        : { ok: true as const, accessToken: 'fake-token' },
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, folder };
}

const messages = (events: WireEvent[]) =>
  events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message',
  );

describe('the persisted user turn carries the surface’s localId', () => {
  // THE DUPLICATE BUG. The surface renders its own message immediately and
  // reconciles the persisted copy against `localId`. Without it there is nothing
  // to match on, so both copies render and every first message appears twice.
  it('echoes back the localId the surface sent', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'surface-abc' });
    const user = messages(events).filter((m) => m.role === 'user');
    expect(user).toHaveLength(1);
    // NOT toMatchObject: that ignores an absent field, which is exactly how this
    // went unnoticed. The field must be PRESENT and equal.
    expect(user[0]).toHaveProperty('localId', 'surface-abc');
  });

  it('emits the user turn exactly once — the surface adds its own optimistic copy', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'surface-abc' });
    expect(messages(events).filter((m) => m.role === 'user' && m.content === 'hey')).toHaveLength(
      1,
    );
  });

  it('a spawn prompt is also echoed once, and is what the transcript opens with', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: 'first thing' });
    const user = messages(events).filter((m) => m.role === 'user');
    expect(user).toHaveLength(1);
    expect(user[0]?.content).toBe('first thing');
  });
});

describe('a turn that cannot run says so IN THE CHAT', () => {
  // THE SILENT-FAILURE BUG. Settings learned via `daemon.unauthenticated` and
  // the composer unlocked when activity went idle — but the chat showed nothing,
  // which reads as the app being broken rather than a credential to renew.
  it('emits a chat.error naming the machine when the credential will not resolve', async () => {
    const { daemon, events, folder } = setup({ signedIn: false });
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'x' });

    const errors = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.error' }> => e.type === 'chat.error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.chatId).toBe(chatId);
    expect(errors[0]?.error.message).toContain('d1');
    // Actionable, not a provider error code dumped at a person.
    expect(errors[0]?.error.message).toMatch(/sign(ed)? in/i);
  });

  it('still tells Settings, via daemon.unauthenticated', async () => {
    const { daemon, events, folder } = setup({ signedIn: false });
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'x' });
    expect(events.some((e) => e.type === 'daemon.unauthenticated')).toBe(true);
  });

  it('returns the chat to idle so the composer is usable again', async () => {
    const { daemon, events, folder } = setup({ signedIn: false });
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'x' });
    const states = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state',
    );
    expect(states.at(-1)?.activity).toBe('idle');
  });

  it('produces NO assistant message — a refused turn must not look answered', async () => {
    const { daemon, events, folder } = setup({ signedIn: false });
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'x' });
    expect(messages(events).filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});

describe('a turn that CAN run still behaves', () => {
  it('answers, and the reply follows the user turn', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'hey', localId: 'x' });
    const roles = messages(events).map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles.indexOf('user')).toBeLessThan(roles.indexOf('assistant'));
    expect(events.some((e) => e.type === 'chat.error')).toBe(false);
  });

  it('per-chat seq stays monotonic across a turn', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'hey', localId: 'x' });
    const seqs = messages(events)
      .filter((m) => m.chatId === chatId)
      .map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
