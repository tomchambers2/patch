// The phone on every voice backend × every surface it opens (spec/07 § Voice —
// a config matrix): call, hands-free and dictation, each on local, gemini and
// openai. The phone never talks to a provider — the host relays Gemini Live /
// OpenAI Realtime over the same audio WSS — so what this pins is that:
//   - every backend opens the SAME session (same token route, same
//     session_start, same PCM up and down) — nothing on the phone is local-only
//     and no provider key or token is ever asked for;
//   - the call bar names a hosted engine, and a hosted engine's failure lands
//     on it loudly, naming the engine — never a quiet local call instead;
//   - a mode switch that crosses engines opens a fresh session;
//   - dictation uploads to the one transcribe route whatever the backend, and a
//     hosted backend's refusal reaches the user.
// No provider is reached: the audio WSS is FakeWebSocket and the REST API is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import {
  DEFAULT_VOICE_CONFIG,
  voiceKeyMissingMessage,
  type AudioSessionMode,
  type VoiceBackend,
  type VoiceConfig,
  type VoiceLayer,
} from '@patch/wire/audio';
import type { SettingsResponse } from '../src/api/rest';

const { meMock, voiceTokenMock, voiceTranscribeMock, seq } = vi.hoisted(() => {
  const seq = { n: 0 };
  return {
    seq,
    meMock: vi.fn(async () => ({
      account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
      surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
    })),
    voiceTokenMock: vi.fn(async () => {
      seq.n += 1;
      return {
        token: `tok${seq.n}`,
        sessionId: `sess-${seq.n}`,
        audioUrl: `/audio/sess-${seq.n}`,
        expiresAt: 0,
      };
    }),
    voiceTranscribeMock: vi.fn(async () => ({ ok: true as const, transcript: 'hello world' })),
  };
});
vi.mock('../src/api/rest', () => ({
  api: { me: meMock, voiceToken: voiceTokenMock, voiceTranscribe: voiceTranscribeMock },
}));

vi.mock('../src/lib/voiceAudioService', () => ({
  startVoiceAudioService: vi.fn(async () => undefined),
  stopVoiceAudioService: vi.fn(async () => undefined),
  updateVoiceAudioService: vi.fn(async () => undefined),
  onVoiceServiceAction: vi.fn(() => () => undefined),
}));

let micOnFrame: ((pcm: Int16Array) => void) | undefined;
const startMicCaptureMock = vi.fn(async (onFrame: (pcm: Int16Array) => void) => {
  micOnFrame = onFrame;
});
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: startMicCaptureMock,
  stopMicCapture: stopMicCaptureMock,
}));

const startTtsPlaybackMock = vi.fn(async () => undefined);
const writeTtsPcmMock = vi.fn();
const stopTtsPlaybackMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceTts', () => ({
  startTtsPlayback: startTtsPlaybackMock,
  writeTtsPcm: writeTtsPcmMock,
  flushTtsPlayback: vi.fn(async () => undefined),
  stopTtsPlayback: stopTtsPlaybackMock,
}));

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function seedConfig(voiceConfig: VoiceConfig): void {
  useSettingsStore.setState({
    data: {
      devices: [],
      push: { tokenCount: 0 },
      telegram: { connected: false, chatId: null, botUsername: null },
      google: { configured: false, connected: false, scope: null },
      preferences: { addressWord: 'patch', voiceConfig },
    } as unknown as SettingsResponse,
    error: null,
  });
}

function withCell(mode: AudioSessionMode, backend: VoiceBackend, layer: VoiceLayer): VoiceConfig {
  const key = mode === 'hands-free' ? 'handsFree' : 'call';
  return { ...DEFAULT_VOICE_CONFIG, [key]: { backend, layer } };
}

async function openCall(chatId: string, mode: AudioSessionMode): Promise<FakeWebSocket> {
  const { startVoiceCall } = await import('../src/lib/voiceCall');
  startVoiceCall(chatId, mode);
  await flush();
  const sock = FakeWebSocket.last();
  sock.emitOpen();
  await flush();
  return sock;
}

beforeEach(() => {
  installFakeWebSocket();
  FakeWebSocket.reset();
  vi.clearAllMocks();
  seq.n = 0;
  useVoiceStore.setState({
    activeSession: null,
    callMuted: false,
    callError: null,
    callPhase: 'connecting',
    callTranscriptPartial: '',
    callMode: 'call',
    callEngine: null,
  });
  useUiStore.setState({ errors: [] });
  useSettingsStore.setState({ data: null, error: null });
});

afterEach(async () => {
  const { endVoiceCall } = await import('../src/lib/voiceCall');
  await endVoiceCall();
  restoreWebSocket();
});

const ENGINE_LABEL: Record<VoiceBackend, (layer: VoiceLayer) => string | null> = {
  local: () => null,
  gemini: (l) => `Gemini Live · ${l === 'heavy' ? 'heavy' : 'light'}`,
  openai: (l) => `OpenAI Realtime · ${l === 'heavy' ? 'heavy' : 'light'}`,
};

const FAILURE: Record<Exclude<VoiceBackend, 'local'>, { code: string; engine: string }> = {
  gemini: { code: 'gemini_unavailable', engine: 'Gemini Live' },
  openai: { code: 'openai_unavailable', engine: 'OpenAI Realtime' },
};

for (const mode of ['call', 'hands-free'] as const) {
  for (const backend of ['local', 'gemini', 'openai'] as const) {
    const layers: VoiceLayer[] = backend === 'local' ? ['direct'] : ['direct', 'light', 'heavy'];
    for (const layer of layers) {
      describe(`${mode} on ${backend}/${layer}`, () => {
        it('opens the same host session as every other backend and plays its audio', async () => {
          seedConfig(withCell(mode, backend, layer));
          const sock = await openCall('c1', mode);
          expect(voiceTokenMock).toHaveBeenCalledWith('c1', 'voice-call');
          expect(sock.url).toContain('/audio/sess-1');
          const start = JSON.parse(sock.sent[0] as string) as Record<string, unknown>;
          // Backend-agnostic: the phone names no engine and carries no provider credential.
          expect(Object.keys(start).sort()).toEqual(
            [
              'accountId',
              'addressWord',
              'chatId',
              'mode',
              'role',
              'sessionId',
              'surfaceHasAec',
              'surfaceId',
              'surfaceKind',
              'token',
              'type',
            ].sort(),
          );
          expect(start).toMatchObject({ role: 'voice-call', mode, token: 'tok1' });
          // Mic up.
          micOnFrame!(new Int16Array(640));
          expect(sock.sent).toHaveLength(3);
          // Hosted audio comes down as the same 24 kHz PCM and plays.
          sock.emitMessage(
            JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' }),
          );
          sock.emitMessage(new ArrayBuffer(960));
          expect(writeTtsPcmMock).toHaveBeenCalledTimes(1);
          expect(useVoiceStore.getState().callPhase).toBe('listening');
        });

        it('names the engine on the call bar only when it is hosted', async () => {
          seedConfig(withCell(mode, backend, layer));
          await openCall('c1', mode);
          expect(useVoiceStore.getState().callEngine).toBe(ENGINE_LABEL[backend](layer));
        });

        if (backend !== 'local') {
          it('no key for it on the host: the call bar says exactly which key and where to switch', async () => {
            seedConfig(withCell(mode, backend, layer));
            const sock = await openCall('c1', mode);
            const message = voiceKeyMissingMessage(mode, backend);
            sock.emitMessage(
              JSON.stringify({ type: 'audio.error', code: 'voice_key_missing', message }),
            );
            sock.emitClose(4400, 'refused');
            await flush();
            expect(useVoiceStore.getState().callError).toBe(message);
            expect(useUiStore.getState().errors.at(-1)?.message).toBe(`voice call: ${message}`);
            // Nothing reopened a session on another engine.
            expect(voiceTokenMock).toHaveBeenCalledTimes(1);
            expect(FakeWebSocket.instances).toHaveLength(1);
          });

          it('a hosted engine failure lands on the call bar naming the engine — no local fallback', async () => {
            seedConfig(withCell(mode, backend, layer));
            const sock = await openCall('c1', mode);
            const { code, engine } = FAILURE[backend];
            sock.emitMessage(
              JSON.stringify({
                type: 'audio.error',
                code,
                message: 'closed the session (code 1011)',
                sessionId: 'sess-1',
              }),
            );
            // The host ends the session behind a fatal engine failure.
            sock.emitClose(4400, 'closed');
            await flush();
            const st = useVoiceStore.getState();
            expect(st.callError).toBe(`${engine} failed — closed the session (code 1011)`);
            expect(
              useUiStore.getState().errors.at(-1)?.message ?? useUiStore.getState().errors.at(-1),
            ).toEqual(expect.stringContaining(`${engine} failed`));
            // Audio released; nothing reopened a session on another engine.
            expect(stopMicCaptureMock).toHaveBeenCalled();
            expect(stopTtsPlaybackMock).toHaveBeenCalled();
            expect(voiceTokenMock).toHaveBeenCalledTimes(1);
            expect(FakeWebSocket.instances).toHaveLength(1);
          });
        }
      });
    }
  }
}

describe('switching mode', () => {
  it('within one engine flips in place — no new session', async () => {
    seedConfig({
      ...DEFAULT_VOICE_CONFIG,
      call: { backend: 'openai', layer: 'light', handoff: 'auto' },
      handsFree: { backend: 'openai', layer: 'light', handoff: 'auto' },
    });
    const sock = await openCall('c1', 'call');
    const { setCallMode } = await import('../src/lib/voiceCall');
    setCallMode('hands-free');
    await flush();
    expect(JSON.parse(sock.sent.at(-1) as string)).toEqual({
      type: 'audio.mode',
      sessionId: 'sess-1',
      mode: 'hands-free',
    });
    expect(voiceTokenMock).toHaveBeenCalledTimes(1);
  });

  it('across engines ends the session and opens a fresh one in the new mode, on the new engine', async () => {
    seedConfig({
      ...DEFAULT_VOICE_CONFIG,
      call: { backend: 'gemini', layer: 'heavy', handoff: 'auto' },
      handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
    });
    const first = await openCall('c1', 'call');
    expect(useVoiceStore.getState().callEngine).toBe('Gemini Live · heavy');
    const { setCallMode } = await import('../src/lib/voiceCall');
    setCallMode('hands-free');
    await flush(40);
    // The old session was ended, not re-moded.
    expect(first.sent.map((f) => JSON.parse(f as string).type)).toContain('audio.session_end');
    expect(
      first.sent.map((f) => (typeof f === 'string' ? JSON.parse(f).type : 'bin')),
    ).not.toContain('audio.mode');
    expect(voiceTokenMock).toHaveBeenCalledTimes(2);
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    second.emitOpen();
    await flush();
    expect(JSON.parse(second.sent[0] as string)).toMatchObject({
      type: 'audio.session_start',
      mode: 'hands-free',
      sessionId: 'sess-2',
    });
    const st = useVoiceStore.getState();
    expect(st.callMode).toBe('hands-free');
    expect(st.callEngine).toBeNull();
    expect(st.activeSession?.chatId).toBe('c1');
  });

  it('with the config not loaded, tries in place and shows the host refusal', async () => {
    const sock = await openCall('c1', 'call');
    expect(useVoiceStore.getState().callEngine).toBeNull();
    const { setCallMode } = await import('../src/lib/voiceCall');
    setCallMode('hands-free');
    expect(JSON.parse(sock.sent.at(-1) as string).type).toBe('audio.mode');
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.error',
        code: 'voice_config_not_implemented',
        message: 'hands-free is configured for a different voice engine than call',
        sessionId: 'sess-1',
      }),
    );
    expect(useVoiceStore.getState().callError).toBe(
      'Not available with this voice setting — hands-free is configured for a different voice engine than call',
    );
  });
});

describe('dictation on every backend', () => {
  for (const backend of ['local', 'gemini', 'openai'] as const) {
    it(`${backend}: records locally and uploads to the one transcribe route`, async () => {
      seedConfig({ ...DEFAULT_VOICE_CONFIG, dictation: { backend } });
      const { startDictation, __resetDictationAudio } = await import('../src/lib/dictation');
      __resetDictationAudio();
      const onError = vi.fn();
      const handle = startDictation('c1', vi.fn(), onError);
      await flush();
      for (let i = 0; i < 10; i++) micOnFrame!(new Int16Array(640));
      expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'hello world' });
      expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    });

    if (backend !== 'local') {
      it(`${backend}: a host with no key for it refuses at the press — mic stopped, nothing uploaded`, async () => {
        seedConfig({ ...DEFAULT_VOICE_CONFIG, dictation: { backend } });
        const message = voiceKeyMissingMessage('dictation', backend);
        const { startDictation, __resetDictationAudio } = await import('../src/lib/dictation');
        __resetDictationAudio();
        const onError = vi.fn();
        const handle = startDictation('c1', vi.fn(), onError);
        await flush();
        const sock = FakeWebSocket.last();
        sock.emitOpen();
        micOnFrame!(new Int16Array(640));
        // The host refuses the session the moment it starts.
        sock.emitMessage(
          JSON.stringify({ type: 'audio.error', code: 'voice_key_missing', message }),
        );
        await flush();
        expect(onError).toHaveBeenCalledWith(message);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(stopMicCaptureMock).toHaveBeenCalled();
        expect(await handle.finish(true)).toEqual({ kind: 'discarded' });
        expect(voiceTranscribeMock).not.toHaveBeenCalled();
      });

      it(`${backend}: a refusal on upload carries the same sentence`, async () => {
        seedConfig({ ...DEFAULT_VOICE_CONFIG, dictation: { backend } });
        const message = voiceKeyMissingMessage('dictation', backend);
        voiceTranscribeMock.mockRejectedValueOnce(new Error(message));
        const { startDictation, __resetDictationAudio } = await import('../src/lib/dictation');
        __resetDictationAudio();
        const handle = startDictation('c1', vi.fn(), vi.fn());
        await flush();
        for (let i = 0; i < 10; i++) micOnFrame!(new Int16Array(640));
        await expect(handle.finish(true)).rejects.toThrow(message);
      });
    }
  }
});
