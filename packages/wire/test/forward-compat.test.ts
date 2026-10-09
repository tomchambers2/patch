// A surface decoding frames from a NEWER host.
//
// spec/03-wire-protocol.md § Forward compatibility. The scenario these tests
// pin is the one that bit on 2026-09-11: the host shipped new fields on
// `chat.state` and `daemon.account`, and every surface that had not taken the
// matching OTA — a phone that was off during the deploy, a desktop shell that
// had not restarted — dropped the frames and showed a wall of error banners.
// `chat.state` drives the sidebar and the chat view, so that is not degrading,
// that is stopping.
//
// The fields used here are deliberately ones that do NOT exist in the schema
// today. They stand in for whatever the next host adds; if one of them is
// ever really added, pick another invented name rather than deleting the test.

import { describe, test, expect, beforeEach } from 'vitest';
import {
  encode,
  decode,
  decodeCompat,
  wireCompatStats,
  resetWireCompatStats,
  WireDecodeError,
  type WireEvent,
} from '../src/index.js';

/** A `chat.state` exactly as this build knows it. */
const CHAT_STATE: Extract<WireEvent, { type: 'chat.state' }> = {
  type: 'chat.state',
  chatId: 'c1',
  activity: 'running',
  permissionMode: 'bypassPermissions',
  lastUpdated: 1700000000,
};

/** A `daemon.account` exactly as this build knows it. */
const DAEMON_ACCOUNT: Extract<WireEvent, { type: 'daemon.account' }> = {
  type: 'daemon.account',
  daemonId: 'host-a',
  backendId: 'claude-code',
  connected: true,
  accountEmail: 'tom@anthropic.com',
};

/** Frame text as a newer host would put it on the wire. */
function fromNewerDaemon(base: object, extra: object): string {
  return JSON.stringify({ ...base, ...extra });
}

beforeEach(() => {
  resetWireCompatStats();
});

describe('a newer host adds a FIELD', () => {
  test('the surface still renders the frame it understands', () => {
    const frame = fromNewerDaemon(CHAT_STATE, { limitResetsAt: 1789000000000 });

    const result = decodeCompat(frame);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Every field this build knows survives — the point is that the sidebar and
    // the chat view keep working, not merely that nothing threw.
    expect(result.event).toEqual(CHAT_STATE);
    expect(result.tolerated).toEqual(['chat.state.limitResetsAt']);
  });

  test('a NESTED unknown field is tolerated the same way', () => {
    // `usage.session` is a `RateLimitWindow`, one of the nested schemas that
    // really is `.strict()` — a new key there used to take the whole frame down
    // exactly as a top-level one did.
    const frame = fromNewerDaemon(DAEMON_ACCOUNT, {
      organizationTier: 'enterprise',
      usage: {
        session: { status: 'allowed', utilization: 0.4, burstCredits: 12 },
      },
    });

    const result = decodeCompat(frame);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.event).toEqual({
      ...DAEMON_ACCOUNT,
      usage: { session: { status: 'allowed', utilization: 0.4 } },
    });
    expect(result.tolerated).toEqual([
      'daemon.account.organizationTier',
      'daemon.account.usage.session.burstCredits',
    ]);
  });

  test('the tolerated field is counted, so diagnostics can name the drift', () => {
    decodeCompat(fromNewerDaemon(CHAT_STATE, { limitResetsAt: 1 }));
    decodeCompat(fromNewerDaemon(CHAT_STATE, { limitResetsAt: 2 }));

    expect(wireCompatStats().unknownFields).toEqual({ 'chat.state.limitResetsAt': 2 });
    expect(wireCompatStats().unknownTypes).toEqual({});
  });
});

describe('a newer host adds an EVENT TYPE', () => {
  test('the frame is dropped quietly — no throw, no banner', () => {
    const frame = JSON.stringify({ type: 'chat.vibes', chatId: 'c1', mood: 'chipper', seq: 3 });

    const result = decodeCompat(frame);

    expect(result).toEqual({ ok: false, reason: 'unknown-type', type: 'chat.vibes' });
  });

  test('it is counted by type, which is what tells the user to update', () => {
    decodeCompat(JSON.stringify({ type: 'chat.vibes', chatId: 'c1' }));
    decodeCompat(JSON.stringify({ type: 'chat.vibes', chatId: 'c2' }));
    decodeCompat(JSON.stringify({ type: 'host.telepathy', daemonId: 'host-a' }));

    expect(wireCompatStats().unknownTypes).toEqual({ 'chat.vibes': 2, 'host.telepathy': 1 });
  });

  test('an absurdly long type cannot blow up a counter key or a log line', () => {
    decodeCompat(JSON.stringify({ type: `chat.${'x'.repeat(500)}` }));

    const keys = Object.keys(wireCompatStats().unknownTypes);
    expect(keys).toHaveLength(1);
    expect((keys[0] as string).length).toBeLessThanOrEqual(65);
    expect(keys[0]).toMatch(/…$/);
  });
});

describe('forward compatibility is not a fallback', () => {
  test('a missing required field still throws', () => {
    const incomplete: Record<string, unknown> = { ...CHAT_STATE };
    delete incomplete['lastUpdated'];
    expect(() => decodeCompat(JSON.stringify(incomplete))).toThrow(WireDecodeError);
  });

  test('a bad enum value still throws', () => {
    expect(() => decodeCompat(JSON.stringify({ ...CHAT_STATE, activity: 'vibing' }))).toThrow(
      WireDecodeError,
    );
  });

  test('invalid JSON still throws', () => {
    expect(() => decodeCompat('{not json')).toThrow(WireDecodeError);
  });

  test('an unknown key riding along with a REAL error throws — the bug does not hide', () => {
    const frame = JSON.stringify({ ...CHAT_STATE, activity: 'vibing', limitResetsAt: 1 });

    expect(() => decodeCompat(frame)).toThrow(WireDecodeError);
    // And nothing was counted as tolerated: the frame was refused outright.
    expect(wireCompatStats()).toEqual({ unknownTypes: {}, unknownFields: {} });
  });

  test('a frame this build fully understands is untouched and uncounted', () => {
    const result = decodeCompat(encode(CHAT_STATE));

    expect(result).toEqual({ ok: true, event: CHAT_STATE, tolerated: [] });
    expect(wireCompatStats()).toEqual({ unknownTypes: {}, unknownFields: {} });
  });
});

describe('INGRESS is unchanged — the server still refuses what it does not know', () => {
  test('strict decode rejects the newer host’s extra field', () => {
    expect(() => decode(fromNewerDaemon(CHAT_STATE, { limitResetsAt: 1 }))).toThrow(
      WireDecodeError,
    );
  });

  test('strict decode rejects the newer host’s unknown event type', () => {
    expect(() => decode(JSON.stringify({ type: 'chat.vibes', chatId: 'c1' }))).toThrow(
      WireDecodeError,
    );
  });
});
