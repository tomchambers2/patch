// Device control-plane wire codec (spec/16 §Wire protocol). Verifies the
// frame shapes match the firmware's hand-rolled C encoder/decoder exactly and
// that the codec fails loud on garbage (no silent coercion).

import { describe, it, expect } from 'vitest';
import {
  decodeDeviceControl,
  encodeDeviceControl,
  DeviceControlInbound,
  DeviceSessionStartFrame,
  type DeviceControlOutbound,
} from '../src/device-control.js';

describe('device-control wire codec', () => {
  it('decodes every device → host frame the firmware emits', () => {
    const frames = [
      { type: 'hello', deviceId: 'kitchen', fwVersion: 'mock-0.1.0', muted: false },
      { type: 'wake_detected' },
      { type: 'session_end', reason: 'vad-timeout' },
      { type: 'session_end', reason: 'user-button' },
      { type: 'session_end', reason: 'agent-finished' },
      { type: 'ring_accepted' },
      { type: 'ring_dismissed' },
      { type: 'mute_changed', muted: true },
    ];
    for (const f of frames) {
      expect(decodeDeviceControl(JSON.stringify(f))).toEqual(f);
    }
  });

  it('rejects an unknown frame type (no fallback)', () => {
    expect(() => decodeDeviceControl(JSON.stringify({ type: 'nope' }))).toThrow();
  });

  it('rejects a session_end with an out-of-spec reason', () => {
    expect(() =>
      decodeDeviceControl(JSON.stringify({ type: 'session_end', reason: 'meh' })),
    ).toThrow();
  });

  it('rejects extra keys (strict schema)', () => {
    expect(() =>
      decodeDeviceControl(JSON.stringify({ type: 'wake_detected', extra: 1 })),
    ).toThrow();
  });

  it('decodes from a Buffer too (ws delivers Buffers)', () => {
    const buf = Buffer.from(JSON.stringify({ type: 'ring_accepted' }), 'utf8');
    expect(decodeDeviceControl(buf)).toEqual({ type: 'ring_accepted' });
  });

  it('encodes host → device frames the firmware decoder accepts', () => {
    const start: DeviceControlOutbound = {
      type: 'session_start',
      sessionId: 's1',
      voiceToken: 'claims.sig',
      // accountId is REQUIRED on session_start (spec/16 §Wire protocol): the
      // host hands the device the identity the audio WSS expects, so the
      // device can declare it on audio.session_start without decoding the
      // opaque voice token. The audio server rejects a mismatch.
      accountId: 'acct_1',
      chatId: 'thread_speakers',
      conversational: true,
    };
    const encoded = encodeDeviceControl(start);
    const reparsed = JSON.parse(encoded);
    // Firmware requires sessionId + voiceToken on session_start; the host
    // additionally binds accountId + chatId so the audio WSS can validate them
    // against the voice-token claims.
    expect(reparsed.sessionId).toBe('s1');
    expect(reparsed.voiceToken).toBe('claims.sig');
    expect(reparsed.accountId).toBe('acct_1');
    expect(reparsed.chatId).toBe('thread_speakers');
    // Round-trips through the outbound schema.
    expect(DeviceSessionStartFrame.parse(reparsed)).toEqual(start);
  });

  it('the inbound union is closed (discriminated on type)', () => {
    // A host→device frame (ring) is NOT a valid inbound device→host frame.
    expect(
      DeviceControlInbound.safeParse({ type: 'ring', chatId: 'c', conversational: false }).success,
    ).toBe(false);
  });
});
