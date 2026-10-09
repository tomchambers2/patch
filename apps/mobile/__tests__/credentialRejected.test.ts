// A credential the server REJECTS is not a connection problem (spec/10 § Surface,
// spec/12 § Surface connection state model).
//
// The phone treated it as one: the hub closes 4401 on a bad credential, the
// client saw a closed socket, set `reconnecting`, and retried for ever. The app
// sat there saying it was trying to connect while the server had already
// refused it — leaving the user to work out for themselves that the answer was
// to link the device again. Retrying cannot fix a refusal.
//
// So a 4401 (or an `auth.revoked` frame) ends the session: stop dialling, drop
// the dead credential, say what happened, and put the app back at pairing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PatchWs, resetWs } from '../src/api/ws';
import { saveCredential, loadCredential, clearCredential } from '../src/lib/credential';
import { usePresenceStore } from '../src/stores/presenceStore';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';

beforeEach(() => {
  installFakeWebSocket();
  vi.useFakeTimers();
  saveCredential('a.b.c');
  usePresenceStore.getState().setConnection('connecting');
  usePresenceStore.getState().setAuthRejected(null);
});

afterEach(() => {
  resetWs();
  restoreWebSocket();
  FakeWebSocket.reset();
  vi.useRealTimers();
  clearCredential();
});

function connect(): PatchWs {
  const ws = new PatchWs('ws://test/ws');
  ws.connect();
  FakeWebSocket.last().emitOpen();
  return ws;
}

describe('a credential the server rejects', () => {
  it('stops dialling — a refusal is not something a retry can fix', () => {
    connect();
    const before = FakeWebSocket.instances.length;
    FakeWebSocket.last().emitClose(4401, 'invalid credential');

    // Well past every backoff step.
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it('says it is signed out, not "reconnecting"', () => {
    connect();
    FakeWebSocket.last().emitClose(4401, 'invalid credential');
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
    expect(usePresenceStore.getState().authRejected).toBe('invalid credential');
  });

  it('drops the dead credential so the app returns to pairing', () => {
    connect();
    FakeWebSocket.last().emitClose(4401, 'invalid credential');
    expect(loadCredential()).toBeNull();
  });

  it('does the same for an auth.revoked frame, without waiting for the close', () => {
    connect();
    FakeWebSocket.last().emitMessage(
      JSON.stringify({ type: 'auth.revoked', reason: 'surface revoked' }),
    );
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
    expect(usePresenceStore.getState().authRejected).toBe('surface revoked');
    expect(loadCredential()).toBeNull();
  });

  it('keeps retrying an ORDINARY drop — that IS what a retry fixes', () => {
    connect();
    const before = FakeWebSocket.instances.length;
    FakeWebSocket.last().emitClose(1006, '');
    expect(usePresenceStore.getState().connection).toBe('reconnecting');
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    expect(loadCredential()).not.toBeNull();
  });

  it('leaves an EXPIRED session alone — it aged out, it was not refused', () => {
    // spec/10: expiry is transient and must not wipe the credential or force
    // a re-pair.
    connect();
    FakeWebSocket.last().emitMessage(
      JSON.stringify({ type: 'auth.expired', reason: 'token aged out' }),
    );
    expect(usePresenceStore.getState().connection).not.toBe('unauthenticated');
    expect(loadCredential()).not.toBeNull();
  });
});

// The OTHER way a surface ends up unauthenticated, and the one that leaves no
// trace on the server at all: it has no credential to send.
//
// `openOnce` THREW here — "no credential — pair this surface first" — with a
// comment saying the caller should redirect to pairing. No caller did.
// `bootstrap()` calls `connect()` as fire-and-forget, so the throw went nowhere,
// no socket was ever opened, and the app sat on its connecting/reconnecting
// treatment for ever while the server never heard from it. Nothing on the wire
// to diagnose, because nothing ever went out.
describe('a surface with no credential at all', () => {
  beforeEach(() => {
    clearCredential();
  });

  it('says it is not linked instead of throwing into nowhere', () => {
    const ws = new PatchWs('ws://test/ws');
    expect(() => ws.connect()).not.toThrow();
    expect(usePresenceStore.getState().connection).toBe('unauthenticated');
    expect(usePresenceStore.getState().authRejected).toMatch(/link/i);
  });

  it('opens no socket — there is nothing to send', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('does not sit there retrying something that cannot work', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(0);
  });
});
