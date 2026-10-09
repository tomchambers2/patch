// lib/voiceCall.ts — the CONNECTING state is distinct and can fail loudly
// (spec/15 § Voice states): a session that never hears the host's first
// `audio.state` is declared failed after CALL_CONNECT_TIMEOUT_MS with its
// audio released and a retry offered; a socket the host drops mid-call says
// so; retry reopens the same chat in the same mode; the timer counts from
// connection, not from the tap; the address word the session opened with is
// what the hands-free hint names.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';

vi.mock('../src/api/rest', () => ({
  api: {
    me: vi.fn(async () => ({
      account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
      surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
    })),
    voiceToken: vi.fn(async () => ({
      token: 'tok1',
      sessionId: 'sess-1',
      audioUrl: '/audio/sess-1',
      expiresAt: 0,
    })),
  },
}));
const { stopVoiceAudioServiceMock, stopMicCaptureMock, stopTtsPlaybackMock, prefs } = vi.hoisted(
  () => ({
    stopVoiceAudioServiceMock: vi.fn(async () => undefined),
    stopMicCaptureMock: vi.fn(async () => undefined),
    stopTtsPlaybackMock: vi.fn(async () => undefined),
    prefs: { addressWord: 'patch' as string | null },
  }),
);
vi.mock('../src/lib/voiceAudioService', () => ({
  startVoiceAudioService: vi.fn(async () => undefined),
  stopVoiceAudioService: stopVoiceAudioServiceMock,
  updateVoiceAudioService: vi.fn(async () => undefined),
  onVoiceServiceAction: vi.fn(() => () => undefined),
}));
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: vi.fn(async () => undefined),
  stopMicCapture: stopMicCaptureMock,
}));
vi.mock('../src/lib/voiceTts', () => ({
  startTtsPlayback: vi.fn(async () => undefined),
  writeTtsPcm: vi.fn(),
  flushTtsPlayback: vi.fn(async () => undefined),
  stopTtsPlayback: stopTtsPlaybackMock,
}));
vi.mock('../src/lib/preferences', () => ({
  addressWordOrNull: () => prefs.addressWord,
  voiceConfigOrNull: () => null,
}));

import {
  CALL_CONNECT_TIMEOUT_MS,
  endVoiceCall,
  retryVoiceCall,
  startVoiceCall,
} from '../src/lib/voiceCall';

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function stateFrame(state: string): string {
  return JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state });
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
  vi.clearAllMocks();
  prefs.addressWord = 'patch';
  useVoiceStore.setState({
    activeSession: null,
    callMuted: false,
    callError: null,
    callPhase: 'connecting',
    callTranscriptPartial: '',
    callMode: 'call',
    callConnectedAt: null,
    callAddressWord: null,
  });
  useUiStore.setState({ errors: [] });
});

afterEach(async () => {
  await endVoiceCall();
  restoreWebSocket();
  vi.useRealTimers();
});

describe('connecting → failed after the timeout', () => {
  it('stays "connecting" (no error) until the timeout, then fails loudly and releases audio', async () => {
    startVoiceCall('c1');
    await flush();
    FakeWebSocket.last().emitOpen();
    await flush();
    vi.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS - 1);
    expect(useVoiceStore.getState().callPhase).toBe('connecting');
    expect(useVoiceStore.getState().callError).toBeNull();

    vi.advanceTimersByTime(1);
    await flush();
    const st = useVoiceStore.getState();
    expect(st.callError).toBe('Could not connect — no answer from the host after 15s');
    // The bar stays up (activeSession kept) so the error and Retry show.
    expect(st.activeSession).not.toBeNull();
    expect(FakeWebSocket.last().close).toHaveBeenCalled();
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(stopTtsPlaybackMock).toHaveBeenCalled();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'voice call: no answer from the host after 15s',
    );
  });

  it('the host’s first audio.state disarms the timeout and starts the call clock', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    expect(useVoiceStore.getState().callConnectedAt).toBeNull();
    vi.setSystemTime(new Date('2026-09-24T10:00:03Z'));
    sock.emitMessage(stateFrame('listening'));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
    expect(useVoiceStore.getState().callConnectedAt).toBe(
      new Date('2026-09-24T10:00:03Z').getTime(),
    );
    vi.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS * 2);
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('a setup failure already on screen is not overwritten by the timeout', async () => {
    const { api } = await import('../src/api/rest');
    vi.mocked(api.voiceToken).mockRejectedValueOnce(new Error('token mint failed'));
    startVoiceCall('c1');
    await flush();
    expect(useVoiceStore.getState().callError).toBe('token mint failed');
    vi.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
    expect(useVoiceStore.getState().callError).toBe('token mint failed');
  });

  it('an ended call’s stale timeout does nothing', async () => {
    startVoiceCall('c1');
    await flush();
    await endVoiceCall();
    vi.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(useVoiceStore.getState().callError).toBeNull();
  });
});

describe('a dropped call says so', () => {
  it('an unexpected socket close mid-call sets "Call dropped"', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('listening'));
    sock.emitClose(1006);
    expect(useVoiceStore.getState().callError).toBe('Call dropped — the audio connection closed');
  });

  it('a close with an error already showing keeps the real reason', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    await flush();
    useVoiceStore.getState().setError('audio.error: kokoro missing');
    sock.emitClose(1011);
    expect(useVoiceStore.getState().callError).toBe('audio.error: kokoro missing');
  });

  it('hanging up is not a drop — no error', async () => {
    startVoiceCall('c1');
    await flush();
    FakeWebSocket.last().emitOpen();
    await flush();
    await endVoiceCall();
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(useVoiceStore.getState().callError).toBeNull();
  });
});

describe('retryVoiceCall', () => {
  it('reopens the same chat in the same mode, back in a clean connecting state', async () => {
    startVoiceCall('c7', 'hands-free');
    await flush();
    vi.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
    await flush();
    expect(useVoiceStore.getState().callError).not.toBeNull();
    const before = FakeWebSocket.instances.length;

    await retryVoiceCall();
    const st = useVoiceStore.getState();
    expect(st.activeSession?.chatId).toBe('c7');
    expect(st.callMode).toBe('hands-free');
    expect(st.callError).toBeNull();
    expect(st.callPhase).toBe('connecting');
    await flush();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('with no call open it does nothing', async () => {
    await retryVoiceCall();
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });
});

describe('address word', () => {
  it('records the address word the session opened with', () => {
    startVoiceCall('c1', 'hands-free');
    expect(useVoiceStore.getState().callAddressWord).toBe('patch');
  });

  it('records null when the preferences have not loaded', () => {
    prefs.addressWord = null;
    startVoiceCall('c1', 'hands-free');
    expect(useVoiceStore.getState().callAddressWord).toBeNull();
  });
});
