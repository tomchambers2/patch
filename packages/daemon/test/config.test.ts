// Config: the inverted link requires PATCH_SERVER_WS_URL + PATCH_SERVER_URL.
// NO FALLBACK — loadConfig throws when either is missing.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { defaultHostName, loadConfig } from '../src/config.js';

const base: NodeJS.ProcessEnv = {
  PATCH_SERVER_WS_URL: 'ws://server:3000/ws',
  PATCH_SERVER_URL: 'http://server:3000',
  PATCH_INTERNAL_TOKEN: 'voice-hmac-secret',
  // Unit tests select the mock SDK explicitly — loadConfig has no silent default.
  SDK_BACKEND: 'mock',
};

describe('loadConfig', () => {
  it('loads server URLs from env', () => {
    const cfg = loadConfig({ env: { ...base } });
    expect(cfg.serverWsUrl).toBe('ws://server:3000/ws');
    expect(cfg.serverUrl).toBe('http://server:3000');
    expect(cfg.internalToken).toBe('voice-hmac-secret');
  });

  it('throws when PATCH_SERVER_WS_URL is missing (NO FALLBACK)', () => {
    const env = { ...base };
    delete env.PATCH_SERVER_WS_URL;
    expect(() => loadConfig({ env })).toThrow(/PATCH_SERVER_WS_URL/);
  });

  it('throws when PATCH_SERVER_URL is missing (NO FALLBACK)', () => {
    const env = { ...base };
    delete env.PATCH_SERVER_URL;
    expect(() => loadConfig({ env })).toThrow(/PATCH_SERVER_URL/);
  });

  it('throws when PATCH_INTERNAL_TOKEN is missing (voice HMAC, NO FALLBACK)', () => {
    const env = { ...base };
    delete env.PATCH_INTERNAL_TOKEN;
    expect(() => loadConfig({ env })).toThrow(/PATCH_INTERNAL_TOKEN/);
  });

  it('defaults audio.relayHost to loopback at the audio port when co-located with the server (PATCH_SERVER_WS_URL itself is loopback)', () => {
    const local = { ...base, PATCH_SERVER_WS_URL: 'ws://127.0.0.1:3000/ws' };
    expect(loadConfig({ env: local }).audio.relayHost).toBe('127.0.0.1:3003');
    expect(loadConfig({ env: { ...local, PATCH_DAEMON_AUDIO_PORT: '4004' } }).audio.relayHost).toBe(
      '127.0.0.1:4004',
    );
  });

  it('defaults audio.relayHost to undefined when NOT co-located (no PATCH_DAEMON_AUDIO_RELAY_HOST needed — voice relays over the host link instead)', () => {
    // `base`'s PATCH_SERVER_WS_URL names a real host ("server"), not loopback —
    // this host and the server are not provably the same machine, so no
    // direct address is assumed. Audio still works: the server tunnels the
    // session over this host's own outbound link (spec/03 § Audio relay
    // over the host link).
    expect(loadConfig({ env: { ...base } }).audio.relayHost).toBeUndefined();
  });

  it('honours PATCH_DAEMON_AUDIO_RELAY_HOST as an optional direct-path optimisation, even when not co-located', () => {
    const cfg = loadConfig({
      env: { ...base, PATCH_DAEMON_AUDIO_RELAY_HOST: 'toms-macbook-pro.taild3063d.ts.net:3003' },
    });
    expect(cfg.audio.relayHost).toBe('toms-macbook-pro.taild3063d.ts.net:3003');
  });

  it('does not read removed PATCH_DAEMON_WS_PORT/HOST', () => {
    const cfg = loadConfig({ env: { ...base } }) as unknown as Record<string, unknown>;
    expect(cfg['wsPort']).toBeUndefined();
    expect(cfg['wsHost']).toBeUndefined();
  });

  it('throws when SDK_BACKEND is unset (no silent default, NO FALLBACK)', () => {
    const env = { ...base };
    delete env.SDK_BACKEND;
    expect(() => loadConfig({ env })).toThrow(/SDK_BACKEND/);
  });

  it('defaults VAD backend to silero (internal/free) and reads silero + model path from env', () => {
    expect(loadConfig({ env: { ...base } }).audio.vadBackend).toBe('silero');
    const cfg = loadConfig({
      env: { ...base, VAD_BACKEND: 'silero', VAD_MODEL_PATH: '/models/vad/silero_vad.onnx' },
    });
    expect(cfg.audio.vadBackend).toBe('silero');
    expect(cfg.audio.vadModelPath).toBe('/models/vad/silero_vad.onnx');
  });

  it('rejects an invalid VAD_BACKEND (NO FALLBACK)', () => {
    expect(() => loadConfig({ env: { ...base, VAD_BACKEND: 'whisper' } })).toThrow(/VAD_BACKEND/);
  });

  it('reads WHISPER_MODEL_PATH for the local spawned-sidecar path', () => {
    const cfg = loadConfig({
      env: { ...base, WHISPER_BACKEND: 'local', WHISPER_MODEL_PATH: '/models/whisper/medium.en' },
    });
    expect(cfg.audio.whisperModelPath).toBe('/models/whisper/medium.en');
  });

  it('throws on a non-numeric/out-of-range int override (NO FALLBACK)', () => {
    expect(() =>
      loadConfig({ env: { ...base, PATCH_DAEMON_HEALTHZ_PORT: 'not-a-number' } }),
    ).toThrow(/Invalid PATCH_DAEMON_HEALTHZ_PORT/);
    expect(() => loadConfig({ env: { ...base, PATCH_DAEMON_HEALTHZ_PORT: '-1' } })).toThrow(
      /Invalid PATCH_DAEMON_HEALTHZ_PORT/,
    );
    expect(() => loadConfig({ env: { ...base, PATCH_DAEMON_HEALTHZ_PORT: '0' } })).toThrow(
      /Invalid PATCH_DAEMON_HEALTHZ_PORT/,
    );
  });

  // spec/11: the host "installs and runs on a machine carrying only an OS".
  // Voice is an optional component and the artifact ships no STT credential and
  // no TTS weights, so defaulting these to a real backend made every fresh
  // install abort at boot on a missing GROQ_API_KEY. Unset means the component
  // is not installed — not a quiet downgrade to a stub.
  it('leaves voice off when no backend is named, so a bare machine can boot', () => {
    const cfg = loadConfig({ env: { ...base } });
    expect(cfg.audio.whisperBackend).toBe('off');
    expect(cfg.audio.kokoroBackend).toBe('off');
  });

  it('still aborts when a voice backend IS named but its credential is absent', () => {
    const env = { ...base, WHISPER_BACKEND: 'groq' };
    delete env['GROQ_API_KEY'];
    const cfg = loadConfig({ env });
    expect(cfg.audio.whisperBackend).toBe('groq');
    // The eager boot check is what aborts; config still reports the choice.
    expect(cfg.audio.groqApiKey).toBeUndefined();
  });

  it('rejects an invalid WHISPER_BACKEND (NO FALLBACK)', () => {
    expect(() => loadConfig({ env: { ...base, WHISPER_BACKEND: 'bogus' } })).toThrow(
      /Invalid WHISPER_BACKEND/,
    );
  });

  it('rejects an invalid KOKORO_BACKEND (NO FALLBACK)', () => {
    expect(() => loadConfig({ env: { ...base, KOKORO_BACKEND: 'bogus' } })).toThrow(
      /Invalid KOKORO_BACKEND/,
    );
  });

  it('defaults claudeProjectsRoot under ~/.claude/projects for the real SDK backend', () => {
    const cfg = loadConfig({ env: { ...base, SDK_BACKEND: 'real' } });
    expect(cfg.sdkBackend).toBe('real');
    expect(cfg.claudeProjectsRoot.endsWith(join('.claude', 'projects'))).toBe(true);
  });

  it('falls back to process.env when no `env` option is supplied', () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(base)) {
      saved[key] = process.env[key];
      process.env[key] = base[key];
    }
    try {
      const cfg = loadConfig();
      expect(cfg.serverWsUrl).toBe('ws://server:3000/ws');
    } finally {
      for (const key of Object.keys(base)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

// spec/02 § Control IPC: "The host is the only party that mints that key."
// It is deliberately NOT read from the environment — a key supplied from
// outside would outlive restarts and be readable wherever that config lives,
// neither of which is true of one generated on each start. This asserts the
// config surface has no seam for it.
describe('the local control key is not configuration', () => {
  it('loadConfig exposes no localKey, even with the env var set', () => {
    const cfg = loadConfig({
      env: { ...base, PATCH_DAEMON_LOCAL_KEY: 'smuggled-in-from-outside' },
    });
    expect('localKey' in cfg).toBe(false);
  });
});

describe('defaultHostName (spec/02 § Host identity)', () => {
  it('a Mac is called what its owner named it, not its numbered network hostname', () => {
    expect(defaultHostName('darwin', () => "Tom's MacBook Pro\n", 'Toms-MacBook-Pro-7.local')).toBe(
      "Tom's MacBook Pro",
    );
  });
  it('anywhere else it is the hostname without its domain', () => {
    expect(defaultHostName('linux', () => 'unused', 'box.example.com')).toBe('box');
    expect(defaultHostName('linux', () => 'unused', 'ubuntu-4gb-hel1-1')).toBe('ubuntu-4gb-hel1-1');
  });
  it('a Mac with no Computer Name set keeps its hostname, minus .local', () => {
    expect(defaultHostName('darwin', () => '', 'Toms-MacBook-Pro-7.local')).toBe(
      'Toms-MacBook-Pro-7',
    );
  });
});
