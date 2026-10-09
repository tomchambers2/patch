// Composer dictation, end to end through the REAL `lib/dictation.ts`.
//
// The rest of the dictation coverage is split either side of a seam:
// `Composer.voice.test.tsx` drives the Composer against a FAKE session
// (`Props.dictationFactory`), and `dictation.test.ts` drives the real session
// with no Composer. Neither can see a break in the join between them — which
// is exactly where "Voice input broken in mobile patch" lived: the gesture
// handler ended a session the capture module was still filling, and the empty
// result it produced was swallowed on the way back.
//
// So this file wires the real Composer to the real session and fakes only what
// cannot exist under Node: the native mic (`lib/voiceMic`), the REST client,
// and the audio WSS. A touch gesture goes in; a draft (or a named failure)
// comes out.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as FileSystem from 'expo-file-system';
import { encodeAudio } from '@patch/wire/audio';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { findHost, byLabel, byType, renderRN, actAsync, flush } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';

const voiceTranscribeMock = vi.fn(async (_uri: string) => ({
  ok: true as const,
  transcript: 'buy oat milk and some bread',
}));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn(async () => ({ skills: [] })),
    uploadAttachment: vi.fn(),
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
    voiceTranscribe: (uri: string) => voiceTranscribeMock(uri),
  },
}));

let micOnFrame: ((pcm: Int16Array) => void) | undefined;
const startMicCaptureMock = vi.fn(async (onFrame: (pcm: Int16Array) => void) => {
  micOnFrame = onFrame;
});
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: (onFrame: (pcm: Int16Array) => void, onError: (m: string) => void) =>
    startMicCaptureMock(onFrame, onError),
  stopMicCapture: () => stopMicCaptureMock(),
}));

import { Composer } from '../src/components/Composer';
import { __resetDictationAudio } from '../src/lib/dictation';
import { useComposerDraftStore } from '../src/lib/composerDraft';

/** One native PatchVoiceMic frame: 640 samples of PCM16 @ 16 kHz = 40ms. */
const FRAME_SAMPLES = 640;
/** Feed `ms` of audio as whole native frames. */
function speak(ms: number): void {
  for (let i = 0; i < Math.round(ms / 40); i++) micOnFrame!(new Int16Array(FRAME_SAMPLES));
}
/** Samples in the WAV that was actually uploaded (44-byte RIFF header + PCM16). */
async function uploadedSamples(uri: string): Promise<number> {
  const b64 = await FileSystem.readAsStringAsync(uri);
  return (Buffer.from(b64, 'base64').length - 44) / 2;
}

const mic = (r: ReturnType<typeof renderRN>): Record<string, (e?: unknown) => void> =>
  findHost(r.root, byLabel('Dictate into message')).props as Record<string, (e?: unknown) => void>;
const draft = (r: ReturnType<typeof renderRN>): string =>
  findHost(r.root, byType('TextInput')).props['value'] as string;
const placeholder = (r: ReturnType<typeof renderRN>): string | undefined =>
  findHost(r.root, byType('TextInput')).props['placeholder'] as string | undefined;

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The composer now restores the open chat's unsent text (spec/15 §
  // Composer), and the MMKV stub's registry is shared by every test in the
  // file — without this each test starts holding the previous one's draft.
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  installFakeWebSocket();
  vi.clearAllMocks();
  micOnFrame = undefined;
  __resetDictationAudio();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
  restoreWebSocket();
});

/** Mount, and let the mount-time audio warm-up settle. */
async function mountWarm(): Promise<ReturnType<typeof renderRN>> {
  const r = renderRN(<Composer chatId="c1" folder="work" />);
  await flush();
  return r;
}

describe('composer dictation (real session) — a hold gesture end to end', () => {
  it('press, speak, lift: the transcript lands in the draft editable and nothing is sent', async () => {
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    // Warm audio plane, so the mic opened in the same tick as the gesture.
    expect(startMicCaptureMock).toHaveBeenCalledTimes(1);

    speak(600);
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();

    expect(draft(r)).toBe('buy oat milk and some bread');
    expect(submitSpy).not.toHaveBeenCalled();
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('a drift-out mid-sentence does not truncate the clip: the whole utterance is uploaded on the lift', async () => {
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });

    speak(400); // first half of the sentence
    // The finger slides off the 44px button and comes back — RN reports that
    // as onPressOut/onPressIn, and it must NOT end the session.
    await actAsync(() => {
      mic(r)['onPressOut']!();
    });
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    speak(400); // second half, still being captured

    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();

    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
    const uri = voiceTranscribeMock.mock.calls[0]![0];
    // 800ms at 16 kHz — both halves, not just the part before the drift.
    expect(await uploadedSamples(uri)).toBe(20 * FRAME_SAMPLES);
    expect(draft(r)).toBe('buy oat milk and some bread');
  });

  it('drops the placeholder while dictating, so it cannot paint under the live text', async () => {
    // Tom, Todoist 6hVPGMcWfgcW6256: "when voice note is recording, placeholder
    // should disappear, its writing on top in patch". The preview mirror sits
    // exactly on top of the TextInput, so on an empty draft the placeholder
    // renders THROUGH it and the two strings overlap.
    const r = await mountWarm();
    expect(placeholder(r)).toBe('Message');

    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    await flush();
    const sock = FakeWebSocket.last();
    await actAsync(() => {
      sock.emitOpen();
    });
    speak(400);
    await actAsync(() => {
      sock.emitMessage(
        encodeAudio({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'buy oat' }),
      );
    });
    // The mirror is up and the placeholder is gone — nothing to overlap with.
    expect(r.root.findByProps({ testID: 'dictation-preview' })).toBeTruthy();
    expect(placeholder(r)).toBeUndefined();

    // It comes back once the dictation is over.
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();
    expect(placeholder(r)).toBe('Message');
  });

  it('renders the host interim transcript legibly in the input while the hold is live', async () => {
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    await flush(); // token mint + WS construction
    const sock = FakeWebSocket.last();
    await actAsync(() => {
      sock.emitOpen();
    });
    speak(400);
    await actAsync(() => {
      sock.emitMessage(
        encodeAudio({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'buy oat' }),
      );
    });
    expect(r.root.findByProps({ testID: 'dictation-preview' })).toBeTruthy();
    expect(
      r.root.findAll(
        (i) => typeof i.type === 'string' && i.props['testID'] === 'dictation-live-words',
      )[0]?.props['children'],
    ).toBe('buy oat');
    // The listening strip is up while the mic is live.
    expect(r.root.findAllByProps({ testID: 'dictation-status' }).length).toBeGreaterThan(0);

    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();
    // The session is always ended as cancelled — dictation never auto-sends.
    const end = sock.sent
      .map((s) =>
        typeof s === 'string' ? (JSON.parse(s) as { type?: string; reason?: string }) : null,
      )
      .find((s) => s?.type === 'audio.session_end');
    expect(end).toMatchObject({ reason: 'cancelled' });
    expect(r.root.findAllByProps({ testID: 'dictation-preview' })).toHaveLength(0);
    expect(draft(r)).toBe('buy oat milk and some bread');
  });
});

describe('composer dictation (real session) — an empty result is never silent', () => {
  it('a stab at the mic button reports too short, with the real clip length, and never uploads', async () => {
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    speak(80); // two native frames
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();

    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.at(-1)?.message).toBe(
      'voice: too short to transcribe (0.1s)',
    );
    expect(draft(r)).toBe('');
  });

  it('a lift before the native mic delivered a single frame reports nothing recorded', async () => {
    startMicCaptureMock.mockImplementationOnce(async () => {
      // Native start never delivers a frame before the gesture ends.
    });
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();

    expect(voiceTranscribeMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.at(-1)?.message).toBe(
      'voice: nothing recorded — the mic never started',
    );
  });

  it('a clip Whisper hears nothing in reports no speech recognised', async () => {
    voiceTranscribeMock.mockResolvedValueOnce({ ok: true, transcript: '' });
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    speak(600);
    await actAsync(() => {
      mic(r)['onTouchEnd']!();
    });
    await flush();

    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().errors.at(-1)?.message).toBe('voice: no speech recognised');
    expect(draft(r)).toBe('');
  });
});

describe('composer dictation (real session) — the press path does no permission work', () => {
  it('mounting warms the audio plane, so the gesture itself makes no permission/audio-mode round trip', async () => {
    const { Audio } = await import('expo-av');
    const r = await mountWarm();
    const requestSpy = vi.spyOn(Audio, 'requestPermissionsAsync');
    const modeSpy = vi.spyOn(Audio, 'setAudioModeAsync');

    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    expect(startMicCaptureMock).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(modeSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a denied permission still reaches the user (warming is not a bypass)', async () => {
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'getPermissionsAsync').mockResolvedValue({ granted: false });
    vi.spyOn(Audio, 'requestPermissionsAsync').mockResolvedValue({ granted: false });
    const r = await mountWarm();
    await actAsync(() => {
      mic(r)['onPressIn']!();
    });
    await actAsync(() => {
      mic(r)['onLongPress']!();
    });
    await flush();

    expect(startMicCaptureMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.at(-1)?.message).toBe(
      'voice: dictation setup failed: mic permission denied',
    );
    vi.restoreAllMocks();
  });
});
