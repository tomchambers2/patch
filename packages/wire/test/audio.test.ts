// Codec round-trip + rejection tests for the @patch/wire/audio subpath.

import { describe, test, expect } from 'vitest';
import {
  AUDIO_EVENT_SCHEMAS,
  decodeAudio,
  encodeAudio,
  validateDeviceIdCoupling,
  voiceCellFor,
  modesShareVoiceEngine,
  voiceKeyMissingMessage,
  voiceSurfacesMissingKey,
  voiceKeyHostStatus,
  DEFAULT_VOICE_CONFIG,
  type AudioEvent,
  type AudioEventType,
  type AudioSessionStartEvent,
} from '../src/audio.js';
import { decode, encode, type WireEvent } from '../src/index.js';

const FIXTURES: { [K in AudioEventType]: Extract<AudioEvent, { type: K }> } = {
  'audio.session_start': {
    type: 'audio.session_start',
    sessionId: 'sess1',
    accountId: 'acct1',
    surfaceId: 'surf1',
    surfaceKind: 'web',
    chatId: 'chat1',
    role: 'voice-call',
    token: 'aaaa.bbbb',
    surfaceHasAec: true,
  },
  'audio.session_end': { type: 'audio.session_end', sessionId: 'sess1', reason: 'user' },
  'audio.mode': { type: 'audio.mode', sessionId: 'sess1', mode: 'hands-free' },
  'audio.speak': { type: 'audio.speak', sessionId: 'sess1', text: 'the bus chat is blocked' },
  'audio.pcm16': { type: 'audio.pcm16', ts: 1, sampleRate: 16000, samples: 480 },
  'audio.transcript_partial': {
    type: 'audio.transcript_partial',
    sessionId: 'sess1',
    text: 'hel',
  },
  'audio.transcript_final': {
    type: 'audio.transcript_final',
    sessionId: 'sess1',
    text: 'hello',
    sttLatencyMs: 200,
  },
  'audio.tts_chunk': {
    type: 'audio.tts_chunk',
    sessionId: 'sess1',
    samples: 240,
    firstFrameLatencyMs: 150,
  },
  'audio.tts_end': { type: 'audio.tts_end', sessionId: 'sess1', bargedIn: false },
  'audio.state': { type: 'audio.state', sessionId: 'sess1', state: 'listening' },
  'audio.barge_in': { type: 'audio.barge_in', sessionId: 'sess1', at: 12345 },
  'audio.error': {
    type: 'audio.error',
    code: 'concurrency_cap',
    message: 'too many sessions',
    sessionId: 'sess1',
  },
};

describe('@patch/wire/audio codec', () => {
  for (const [type, ev] of Object.entries(FIXTURES) as [AudioEventType, AudioEvent][]) {
    test(`round-trips ${type}`, () => {
      expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
    });
  }

  test('AUDIO_EVENT_SCHEMAS catalogues every variant', () => {
    const fixtureKeys = Object.keys(FIXTURES).sort();
    const schemaKeys = Object.keys(AUDIO_EVENT_SCHEMAS).sort();
    expect(fixtureKeys).toEqual(schemaKeys);
  });

  test('strict() rejects unknown fields on session_start', () => {
    const bad = {
      ...FIXTURES['audio.session_start'],
      sneaky: true,
    };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('rejects pcm16 with non-16k/24k sample rate', () => {
    const bad = { type: 'audio.pcm16', ts: 1, sampleRate: 22050, samples: 100 };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('rejects audio.error with unknown code', () => {
    const bad = { type: 'audio.error', code: 'mystery', message: 'x' };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('accepts audio.error with sdk_error code (group 14 DX-M1)', () => {
    const ev = {
      type: 'audio.error' as const,
      code: 'sdk_error' as const,
      message: 'turn failed: SdkAbortError',
      sessionId: 'sess1',
    };
    expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
  });

  test("accepts session_start with surfaceKind: 'device' (B-23 voice device)", () => {
    const ev: AudioEvent = {
      type: 'audio.session_start',
      sessionId: 'sess-dev',
      accountId: 'acct1',
      surfaceId: 'surf-dev',
      surfaceKind: 'device',
      chatId: 'chat1',
      role: 'voice-device-conv',
      token: 'aaaa.bbbb',
      surfaceHasAec: false,
    };
    expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
  });

  test('accepts session_start with optional voiceToken (daemon-pushed, B-23-3)', () => {
    const ev: AudioEvent = {
      type: 'audio.session_start',
      sessionId: 'sess-dev',
      accountId: 'acct1',
      surfaceId: 'surf-dev',
      surfaceKind: 'device',
      chatId: 'chat1',
      role: 'voice-device-conv',
      token: '',
      surfaceHasAec: false,
      voiceToken: 'cccc.dddd',
    };
    const decoded = decodeAudio(encodeAudio(ev));
    expect(decoded).toEqual(ev);
    if (decoded.type !== 'audio.session_start') throw new Error('unexpected variant');
    expect(decoded.voiceToken).toBe('cccc.dddd');
  });

  test("rejects session_start with bad surfaceKind ('fridge')", () => {
    const bad = {
      ...FIXTURES['audio.session_start'],
      surfaceKind: 'fridge',
    };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('rejects session_start with non-string voiceToken', () => {
    const bad = {
      ...FIXTURES['audio.session_start'],
      voiceToken: 123,
    };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('decodeAudio accepts a Uint8Array frame', () => {
    const ev = FIXTURES['audio.session_end'];
    const bytes = new TextEncoder().encode(encodeAudio(ev));
    expect(decodeAudio(bytes)).toEqual(ev);
  });

  test('decodeAudio accepts an ArrayBuffer frame', () => {
    const ev = FIXTURES['audio.session_end'];
    const bytes = new TextEncoder().encode(encodeAudio(ev));
    // Slice to a plain ArrayBuffer (not a Uint8Array) to hit that branch.
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decodeAudio(buf)).toEqual(ev);
  });

  test('decodeAudio throws on an unsupported frame type', () => {
    expect(() => decodeAudio(12345 as unknown as string)).toThrow(
      'decodeAudio: unsupported frame type',
    );
  });
});

describe('validateDeviceIdCoupling', () => {
  const base: AudioSessionStartEvent = {
    type: 'audio.session_start',
    sessionId: 'sess1',
    accountId: 'acct1',
    surfaceId: 'surf1',
    surfaceKind: 'web',
    chatId: 'chat1',
    role: 'voice-call',
    token: 'aaaa.bbbb',
    surfaceHasAec: true,
  };

  test('returns null when a device session carries a deviceId', () => {
    const start: AudioSessionStartEvent = { ...base, surfaceKind: 'device', deviceId: 'kitchen' };
    expect(validateDeviceIdCoupling(start)).toBeNull();
  });

  test('returns null when a non-device session has no deviceId', () => {
    expect(validateDeviceIdCoupling(base)).toBeNull();
  });

  test('errors when a device session is missing deviceId', () => {
    const start: AudioSessionStartEvent = { ...base, surfaceKind: 'device' };
    expect(validateDeviceIdCoupling(start)).toBe(
      "deviceId is required when surfaceKind === 'device'",
    );
  });

  test('errors when a non-device session carries a deviceId', () => {
    const start: AudioSessionStartEvent = { ...base, deviceId: 'kitchen' };
    expect(validateDeviceIdCoupling(start)).toBe(
      "deviceId is only valid when surfaceKind === 'device'",
    );
  });
});

describe('chat.input.source — voice-app discriminator (group 13)', () => {
  test('round-trips with voice-app source', () => {
    const ev: WireEvent = {
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'turn the lights off',
      localId: 'lid-va-1',
      source: { kind: 'voice-app', surfaceKind: 'mobile', sessionId: 'sess-x' },
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  test('rejects voice-app source missing surfaceKind', () => {
    const bad = {
      type: 'chat.input',
      chatId: 'c1',
      message: 'hi',
      localId: 'l',
      source: { kind: 'voice-app', sessionId: 's' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow();
  });

  test('rejects voice-app source with bad surfaceKind', () => {
    const bad = {
      type: 'chat.input',
      chatId: 'c1',
      message: 'hi',
      localId: 'l',
      source: { kind: 'voice-app', surfaceKind: 'fridge', sessionId: 's' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow();
  });
});

describe('voiceCellFor / modesShareVoiceEngine (spec/07 § Voice — a config matrix)', () => {
  const config = {
    ...DEFAULT_VOICE_CONFIG,
    dictation: { backend: 'openai' as const },
    call: { backend: 'gemini' as const, layer: 'light' as const, handoff: 'auto' as const },
    handsFree: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
  };
  test('each surface reads its own cell', () => {
    expect(voiceCellFor(config, 'dictation')).toEqual({ backend: 'openai' });
    expect(voiceCellFor(config, 'call')).toEqual({
      backend: 'gemini',
      layer: 'light',
      handoff: 'auto',
    });
    expect(voiceCellFor(config, 'hands-free')).toEqual({
      backend: 'local',
      layer: 'direct',
      handoff: 'auto',
    });
    expect(voiceCellFor(config, 'device')).toEqual({
      backend: 'local',
      layer: 'direct',
      handoff: 'auto',
    });
  });
  test('modes on different engines cannot switch in place', () => {
    expect(modesShareVoiceEngine(config, 'call', 'hands-free')).toBe(false);
    expect(modesShareVoiceEngine(config, 'call', 'call')).toBe(true);
  });
  test('a different layer on the same backend is a different engine', () => {
    const c = {
      ...config,
      handsFree: { backend: 'gemini' as const, layer: 'heavy' as const, handoff: 'auto' as const },
    };
    expect(modesShareVoiceEngine(c, 'hands-free', 'call')).toBe(false);
    expect(modesShareVoiceEngine({ ...c, handsFree: config.call }, 'hands-free', 'call')).toBe(
      true,
    );
  });
  test('a different hand-off mode on the same engine cannot switch in place', () => {
    const c = { ...config, handsFree: { ...config.call, handoff: 'always' as const } };
    expect(modesShareVoiceEngine(c, 'hands-free', 'call')).toBe(false);
  });
});

describe('a voice surface whose backend has no key on the host', () => {
  // Tom's live config, 2026-09-24.
  const config = {
    dictation: { backend: 'gemini' as const },
    device: { backend: 'openai' as const, layer: 'light' as const, handoff: 'auto' as const },
    handsFree: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
    call: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
  };
  test('the refusal names the surface, the key and the Settings → Voice fix', () => {
    expect(voiceKeyMissingMessage('dictation', 'gemini')).toBe(
      'Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
        'Switch Dictation to another backend in Settings → Voice.',
    );
    expect(voiceKeyMissingMessage('hands-free', 'openai')).toBe(
      'Hands-free is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ' +
        'Switch Hands-free to another backend in Settings → Voice.',
    );
  });
  test('lists every surface on a provider the host has no key for, and only those', () => {
    expect(voiceSurfacesMissingKey(config, { gemini: false, openai: false })).toEqual([
      { surface: 'dictation', backend: 'gemini', env: 'GEMINI_API_KEY' },
      { surface: 'device', backend: 'openai', env: 'OPENAI_REALTIME_API_KEY' },
    ]);
    expect(voiceSurfacesMissingKey(config, { gemini: true, openai: false })).toEqual([
      { surface: 'device', backend: 'openai', env: 'OPENAI_REALTIME_API_KEY' },
    ]);
    expect(voiceSurfacesMissingKey(DEFAULT_VOICE_CONFIG, { gemini: false, openai: false })).toEqual(
      [],
    );
  });
  test('Settings names each host that cannot run a hosted cell; unreported hosts say nothing', () => {
    const hosts = [
      { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false } },
      { hostName: 'mac', voiceKeys: { gemini: true, openai: false } },
      { hostName: 'old-daemon' },
    ];
    expect(voiceKeyHostStatus('gemini', hosts)).toBe(
      'Not configured on hetzner: GEMINI_API_KEY is missing. Sessions there are refused.',
    );
    expect(voiceKeyHostStatus('openai', hosts)).toBe(
      'Not configured on hetzner, mac: OPENAI_REALTIME_API_KEY is missing. Sessions there are refused.',
    );
    expect(voiceKeyHostStatus('local', hosts)).toBeNull();
    expect(
      voiceKeyHostStatus('gemini', [
        { hostName: 'mac', voiceKeys: { gemini: true, openai: true } },
      ]),
    ).toBeNull();
  });
  test('audio.error carries voice_key_missing', () => {
    const ev = {
      type: 'audio.error' as const,
      code: 'voice_key_missing' as const,
      message: voiceKeyMissingMessage('call', 'openai'),
    };
    expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
  });
});
