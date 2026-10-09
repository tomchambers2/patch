// G5 — surface-side voice gesture + lifecycle logic (spec/07 ## Voice-input
// modes / ## Barge-in / ## Focus-follow).
//
// NOTES (mode 1) use the RECORD-AND-UPLOAD path (D1): startVoiceNote records the
// mic locally, sendVoiceNote uploads the clip to POST /api/voice/note and echoes
// the transcript the HTTP response returns. Tests inject a fake recorder factory
// + stub `api.voiceNote`, so no real audio/network is touched.
//
// CALLS (modes 2 & 3) still use the streaming audio session (lib/audioSession),
// stubbed via the audio-opener seam.

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { playCallSound } from '../lib/callSound.js';
vi.mock('../lib/callSound.js', () => ({ playCallSound: vi.fn() }));

import {
  __setAudioOpenerForTests,
  __setRecorderFactoryForTests,
  startVoiceNote,
  sendVoiceNote,
  cancelVoiceNote,
  promoteNoteToToggle,
  releaseVoiceNoteHold,
  TAP_THRESHOLD_MS,
  startVoiceCall,
  toggleCallMute,
  endVoiceCall,
  describeCallError,
} from '../lib/voiceController.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';
import type {
  AudioSession,
  AudioSessionCallbacks,
  OpenAudioSessionOpts,
} from '../lib/audioSession.js';

// --- call (audio-session) stub -------------------------------------------
let lastCallbacks: AudioSessionCallbacks | null = null;
let endSpy: ReturnType<typeof vi.fn>;
let muteSpy: ReturnType<typeof vi.fn>;

function stubOpener(opts: OpenAudioSessionOpts): Promise<AudioSession> {
  lastCallbacks = opts.callbacks;
  let muted = false;
  return Promise.resolve({
    sessionId: 'sess-1',
    chatId: opts.chatId,
    setMuted: (m: boolean) => {
      muted = m;
      muteSpy(m);
    },
    isMuted: () => muted,
    setSessionMode: () => {},
    speak: () => {},
    sendPcm: () => {},
    end: (reason?: string) => endSpy(reason),
  });
}

// --- note (recorder) stub -------------------------------------------------
let recStopSpy: ReturnType<typeof vi.fn>;
let recCancelSpy: ReturnType<typeof vi.fn>;
let lastLevelCb: ((l: number) => void) | null = null;
let voiceNoteSpy: MockInstance<typeof api.voiceNote>;

function stubRecording(): VoiceRecording {
  return {
    onLevel: (cb) => {
      lastLevelCb = cb;
    },
    onPcm: () => {},
    stop: async () => {
      recStopSpy();
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    },
    cancel: () => recCancelSpy(),
  };
}

describe('voiceController', () => {
  beforeEach(() => {
    endSpy = vi.fn();
    muteSpy = vi.fn();
    recStopSpy = vi.fn();
    recCancelSpy = vi.fn();
    lastCallbacks = null;
    lastLevelCb = null;
    useVoiceStore.setState({ note: null, call: null, session: null, permission: null });
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'Manager',
        folder: 'm',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
      {
        chatId: 'c2',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'kitchen',
        folder: 'h',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 2,
      },
    ]);
    __setAudioOpenerForTests(stubOpener);
    __setRecorderFactoryForTests(async () => stubRecording());
    // Default: the upload resolves with a canned transcript.
    voiceNoteSpy = vi
      .spyOn(api, 'voiceNote')
      .mockResolvedValue({ ok: true, transcript: 'check the oven', text: 'check the oven' });
  });
  afterEach(() => {
    __setAudioOpenerForTests(null);
    __setRecorderFactoryForTests(null);
    voiceNoteSpy.mockRestore();
  });

  // ========================= VOICE NOTES (D1) =============================

  it('PTT voice note: start records the gesture; the recorder starts', async () => {
    await startVoiceNote('c1', 'ptt');
    const note = useVoiceStore.getState().note;
    expect(note?.chatId).toBe('c1');
    expect(note?.gesture).toBe('ptt');
    // A live recording is in flight (level callback wired for the waveform).
    expect(lastLevelCb).toBeTypeOf('function');
  });

  it('REAL PATH (D1 fidelity): the user message renders from the UPLOAD RESPONSE — no onTranscriptFinal is ever delivered', async () => {
    // This is the exact prod scenario the previous "fix" missed: the host
    // never streams an `audio.transcript_final` back over the audio WSS. The
    // ONLY source of the user's transcript is the POST /api/voice/note response.
    voiceNoteSpy.mockResolvedValue({ ok: true, transcript: 'buy oat milk', text: 'buy oat milk' });
    await startVoiceNote('c1', 'ptt');
    // Note: NOTHING feeds a transcript into the store here — no session, no
    // onTranscriptFinal. Under the old live-session code the echo read
    // `note.transcript` (still empty) and the message never appeared.
    await sendVoiceNote();
    expect(recStopSpy).toHaveBeenCalledOnce();
    expect(voiceNoteSpy).toHaveBeenCalledWith('c1', expect.any(Blob), '');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const echoed = tl.find((e) => e.role === 'user' && e.content === 'buy oat milk');
    expect(echoed).toBeDefined();
    // localId lets the persisted [voice • web] copy reconcile on replay; the turn
    // is delivered (upload 200) so it renders as sent, not a perpetual "Sending…".
    expect(echoed?.localId).toBeTruthy();
    expect(echoed?.deliveryPending).toBeFalsy();
    expect(useVoiceStore.getState().note).toBeNull();
  });

  it('APPEARS LIVE: the voice message shows a transcribing bubble the instant sending begins, then fills in when the upload returns', async () => {
    // The point of "appear live" (Tom, patch/todo.md): the bubble must show the
    // moment the user finishes speaking — NOT only after the (slow, on train
    // wifi) upload + Whisper round-trip. We hold the upload open to prove the
    // bubble is already in the timeline while it is still in flight.
    let resolveUpload!: (v: { ok: true; transcript: string; text: string }) => void;
    voiceNoteSpy.mockReturnValue(
      new Promise((res) => {
        resolveUpload = res;
      }),
    );
    // Clean timeline so we assert purely on this note's bubble (beforeEach
    // hydrates rows but does not clear timelines).
    useChatStore.setState({ timelines: { c1: [] } });
    await startVoiceNote('c1', 'ptt');
    const p = sendVoiceNote();
    // The optimistic insert happens synchronously before the upload await.
    await Promise.resolve();
    const mid = useChatStore.getState().timelines['c1'] ?? [];
    const pending = mid.find((e) => e.role === 'user' && e.transcribing === true);
    expect(pending).toBeDefined();
    expect(pending?.localId).toBeTruthy();
    expect(pending?.content ?? '').toBe(''); // no transcript yet — it's live/transcribing
    // Upload returns → the SAME bubble fills in, transcribing cleared.
    resolveUpload({ ok: true, transcript: 'check the oven', text: 'check the oven' });
    await p;
    const done = useChatStore.getState().timelines['c1'] ?? [];
    const users = done.filter((e) => e.role === 'user');
    expect(users.length).toBe(1); // no duplicate bubble
    expect(users[0]?.localId).toBe(pending?.localId);
    expect(users[0]?.content).toBe('check the oven');
    expect(users[0]?.transcribing).toBeFalsy();
    expect(useVoiceStore.getState().note).toBeNull();
  });

  it('APPEARS LIVE: a failed upload removes the transcribing bubble (NO orphaned live placeholder)', async () => {
    useUiStore.getState().clearToasts();
    // Start from a clean timeline so we assert purely on this note's bubble.
    useChatStore.setState({ timelines: { c1: [] } });
    voiceNoteSpy.mockRejectedValue(new Error('groq 500'));
    await startVoiceNote('c1', 'ptt');
    await sendVoiceNote();
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => e.transcribing === true)).toBe(false);
    expect(tl.some((e) => e.role === 'user')).toBe(false);
    expect(useUiStore.getState().errors[0]?.message).toBe('Voice note failed. Try again.');
  });

  it('sendVoiceNote does NOT echo an empty/whitespace-only returned transcript', async () => {
    voiceNoteSpy.mockResolvedValue({ ok: true, transcript: '   ', text: '' });
    await startVoiceNote('c1', 'toggle');
    const before = (useChatStore.getState().timelines['c1'] ?? []).length;
    await sendVoiceNote();
    const after = (useChatStore.getState().timelines['c1'] ?? []).length;
    expect(after).toBe(before);
    expect(useVoiceStore.getState().note).toBeNull();
  });

  it('a failed upload surfaces a toast and clears the note (NO silent drop)', async () => {
    useUiStore.getState().clearToasts();
    voiceNoteSpy.mockRejectedValue(new Error('groq 500'));
    await startVoiceNote('c1', 'ptt');
    await sendVoiceNote();
    expect(useVoiceStore.getState().note).toBeNull();
    expect(useUiStore.getState().errors[0]?.message).toBe('Voice note failed. Try again.');
  });

  it('a failed recorder start surfaces a toast and clears the note', async () => {
    useUiStore.getState().clearToasts();
    __setRecorderFactoryForTests(async () => {
      throw new Error('mic denied');
    });
    await startVoiceNote('c1', 'ptt');
    expect(useVoiceStore.getState().note).toBeNull();
    expect(useUiStore.getState().errors[0]?.message).toBe('Voice note failed. Try again.');
  });

  it('sendVoiceNote with nothing recorded (released before the mic started) surfaces a toast', async () => {
    useUiStore.getState().clearToasts();
    // A recorder factory that never resolves → no activeRecording when we send.
    __setRecorderFactoryForTests(() => new Promise<VoiceRecording>(() => {}));
    void startVoiceNote('c1', 'ptt');
    await sendVoiceNote();
    expect(useVoiceStore.getState().note).toBeNull();
    expect(useUiStore.getState().errors[0]?.message).toContain('nothing recorded');
    expect(voiceNoteSpy).not.toHaveBeenCalled();
  });

  it('tap-toggle: promote retags the note to a toggle session; ⏎ then uploads', async () => {
    await startVoiceNote('c2', 'ptt');
    expect(useVoiceStore.getState().note?.gesture).toBe('ptt');
    promoteNoteToToggle();
    expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
    expect(useVoiceStore.getState().note?.chatId).toBe('c2');
    await sendVoiceNote();
    expect(useVoiceStore.getState().note).toBeNull();
    expect(recStopSpy).toHaveBeenCalledOnce();
    const tl = useChatStore.getState().timelines['c2'] ?? [];
    expect(tl.some((e) => e.role === 'user' && e.content === 'check the oven')).toBe(true);
  });

  // --- hotkey/mic release: tap vs genuine press-and-hold (spec/07 § mode 1) ---
  //
  // THE ⌘; BUG: the hotkey committed on every keyup regardless of how briefly
  // the chord was held, so a ~100ms keypress uploaded a ~100ms clip and the note
  // died instantly with "transcription failed". A press that short is a tap, and
  // a tap opens a sustained session instead.

  it('release under the tap threshold opens a sustained session instead of committing', async () => {
    useUiStore.setState({ errors: [] });
    await startVoiceNote('c2', 'ptt');
    releaseVoiceNoteHold(TAP_THRESHOLD_MS - 1);
    // Still listening, now on the toggle gesture (⏎ sends, esc cancels).
    expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
    expect(useVoiceStore.getState().note?.chatId).toBe('c2');
    // Nothing was uploaded: no clip, no failed transcription, no error toast.
    expect(recStopSpy).not.toHaveBeenCalled();
    expect(voiceNoteSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('release after a genuine press-and-hold commits the utterance', async () => {
    await startVoiceNote('c2', 'ptt');
    releaseVoiceNoteHold(TAP_THRESHOLD_MS);
    await vi.waitFor(() => expect(useVoiceStore.getState().note).toBeNull());
    expect(recStopSpy).toHaveBeenCalledOnce();
    const tl = useChatStore.getState().timelines['c2'] ?? [];
    expect(tl.some((e) => e.role === 'user' && e.content === 'check the oven')).toBe(true);
  });

  it('release does not commit a note already promoted to a toggle session', async () => {
    await startVoiceNote('c1', 'ptt');
    promoteNoteToToggle();
    // A late/duplicate keyup (macOS drops keyups while ⌘ is held) must not
    // commit the session the user is still dictating into.
    releaseVoiceNoteHold(5_000);
    expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
    expect(voiceNoteSpy).not.toHaveBeenCalled();
  });

  it('release is a no-op when there is no in-flight note', () => {
    expect(() => releaseVoiceNoteHold(10)).not.toThrow();
    expect(useVoiceStore.getState().note).toBeNull();
    expect(voiceNoteSpy).not.toHaveBeenCalled();
  });

  it('Esc cancels a voice note WITHOUT uploading (recorder cancelled, no echo)', async () => {
    await startVoiceNote('c1', 'toggle');
    cancelVoiceNote();
    expect(useVoiceStore.getState().note).toBeNull();
    expect(recCancelSpy).toHaveBeenCalledOnce();
    expect(recStopSpy).not.toHaveBeenCalled();
    expect(voiceNoteSpy).not.toHaveBeenCalled();
  });

  it('live level updates the overlay waveform as the user speaks', async () => {
    await startVoiceNote('c1', 'ptt');
    lastLevelCb?.(0.42);
    expect(useVoiceStore.getState().note?.level).toBe(0.42);
  });

  it('if the note is cancelled while the recorder is still starting, the late recording is cancelled', async () => {
    let resolveStart: ((r: VoiceRecording) => void) | undefined;
    __setRecorderFactoryForTests(
      () =>
        new Promise<VoiceRecording>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const p = startVoiceNote('c1', 'ptt');
    cancelVoiceNote();
    expect(useVoiceStore.getState().note).toBeNull();
    const late = stubRecording();
    resolveStart!(late);
    await p;
    // The late recorder is cancelled rather than left running.
    expect(recCancelSpy).toHaveBeenCalled();
  });

  it('sendVoiceNote is a no-op when there is no in-flight note', async () => {
    await sendVoiceNote();
    expect(recStopSpy).not.toHaveBeenCalled();
    expect(voiceNoteSpy).not.toHaveBeenCalled();
  });

  it('promoteNoteToToggle is a no-op when there is no in-flight note', () => {
    expect(() => promoteNoteToToggle()).not.toThrow();
    expect(useVoiceStore.getState().note).toBeNull();
  });

  it('does not start a second voice interaction while one is in flight', async () => {
    await startVoiceNote('c1', 'ptt');
    await startVoiceNote('c2', 'ptt');
    expect(useVoiceStore.getState().note?.chatId).toBe('c1');
  });

  it('does not start a voice note while already on a call', async () => {
    await startVoiceCall('c1');
    await startVoiceNote('c2', 'ptt');
    expect(useVoiceStore.getState().note).toBeNull();
  });

  // ========================= VOICE CALLS ==================================

  it('voice call: mute toggles the session mute; end tears it down', async () => {
    await startVoiceCall('c1');
    expect(useVoiceStore.getState().call?.chatId).toBe('c1');
    toggleCallMute();
    expect(useVoiceStore.getState().call?.muted).toBe(true);
    expect(muteSpy).toHaveBeenLastCalledWith(true);
    endVoiceCall();
    expect(useVoiceStore.getState().call).toBeNull();
    expect(endSpy).toHaveBeenCalledWith('ended');
  });

  it('a call sounds when it connects and again when it ends, from either end', async () => {
    const sound = vi.mocked(playCallSound);
    sound.mockClear();
    await startVoiceCall('c1');
    expect(sound.mock.calls).toEqual([['pickup']]);
    endVoiceCall();
    expect(sound.mock.calls).toEqual([['pickup'], ['hangup']]);
    // The other end hanging up sounds too, and a call that is not live makes no sound.
    await startVoiceCall('c1');
    lastCallbacks?.onClose();
    expect(sound.mock.calls.map((c) => c[0])).toEqual(['pickup', 'hangup', 'pickup', 'hangup']);
    endVoiceCall();
    expect(sound).toHaveBeenCalledTimes(4);
  });

  it('barge-in: while the agent speaks, a user utterance flips the call back to listening', async () => {
    await startVoiceCall('c1');
    lastCallbacks?.onTtsStart();
    expect(useVoiceStore.getState().call?.agentSpeaking).toBe(true);
    lastCallbacks?.onBargeIn();
    expect(useVoiceStore.getState().call?.agentSpeaking).toBe(false);
    expect(useVoiceStore.getState().call?.speaker).toBe('YOU');
  });

  it('startVoiceCall surfaces a failed open() as a toast and clears the call', async () => {
    useUiStore.getState().clearToasts();
    __setAudioOpenerForTests(async () => {
      throw new Error('mic denied');
    });
    await startVoiceCall('c1');
    expect(useVoiceStore.getState().call).toBeNull();
    expect(useUiStore.getState().errors[0]?.message).toBe('Voice call failed. Try again.');
  });

  it('D3: a kokoro_unavailable audio error reports the TTS infra dependency and ends the call', async () => {
    useUiStore.getState().clearToasts();
    await startVoiceCall('c1');
    lastCallbacks?.onError('kokoro_unavailable: ECONNREFUSED 127.0.0.1:5019');
    expect(useVoiceStore.getState().call).toBeNull();
    expect(endSpy).toHaveBeenCalledWith('ended');
    const msg = useUiStore.getState().errors[0]?.message ?? '';
    expect(msg).toContain('text-to-speech is unavailable');
    expect(msg).toContain('kokoro-sidecar');
    expect(msg).toContain('127.0.0.1:5019');
  });

  it('a non-TTS onError from the call session pushes the generic toast and ends the call', async () => {
    useUiStore.getState().clearToasts();
    await startVoiceCall('c1');
    lastCallbacks?.onError('backend unavailable');
    expect(useVoiceStore.getState().call).toBeNull();
    expect(endSpy).toHaveBeenCalledWith('ended');
    expect(useUiStore.getState().errors[0]?.message).toBe('voice call: backend unavailable');
  });

  it('if the call is ended while the session is still opening, the late session is ended immediately', async () => {
    let resolveOpen: ((s: AudioSession) => void) | undefined;
    __setAudioOpenerForTests(
      (opts) =>
        new Promise((resolve) => {
          lastCallbacks = opts.callbacks;
          resolveOpen = resolve;
        }),
    );
    const p = startVoiceCall('c1');
    endVoiceCall();
    expect(useVoiceStore.getState().call).toBeNull();
    resolveOpen!({
      sessionId: 'late-call',
      chatId: 'c1',
      setMuted: () => {},
      setSessionMode: () => {},
      speak: () => {},
      sendPcm: () => {},
      isMuted: () => false,
      end: (reason?: string) => endSpy(reason),
    });
    await p;
    expect(endSpy).toHaveBeenCalledWith('cancelled');
  });

  it('toggleCallMute and endVoiceCall are no-ops when there is no active call', () => {
    expect(() => toggleCallMute()).not.toThrow();
    expect(() => endVoiceCall()).not.toThrow();
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('a call stays on the chat it was started on: starting one from another chat does not move it', async () => {
    await startVoiceCall('c1');
    await startVoiceCall('c2');
    expect(useVoiceStore.getState().call?.chatId).toBe('c1');
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('starting a call ends any in-flight voice note first', async () => {
    await startVoiceNote('c1', 'ptt');
    expect(useVoiceStore.getState().note).not.toBeNull();
    await startVoiceCall('c1');
    expect(useVoiceStore.getState().note).toBeNull();
    expect(useVoiceStore.getState().call).not.toBeNull();
  });

  it('onTranscriptPartial updates the live call transcript and last line', async () => {
    await startVoiceCall('c1');
    lastCallbacks?.onTranscriptPartial('check on');
    expect(useVoiceStore.getState().call?.transcript).toBe('check on');
    expect(useVoiceStore.getState().call?.lastLine).toBe('check on');
    expect(useVoiceStore.getState().call?.speaker).toBe('YOU');
  });

  it('onTranscriptFinal echoes a non-empty trimmed turn into the chat timeline', async () => {
    await startVoiceCall('c1');
    lastCallbacks?.onTranscriptFinal('  hello there  ', true);
    expect(useVoiceStore.getState().call?.transcript).toBe('');
    expect(useVoiceStore.getState().call?.lastLine).toBe('  hello there  ');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => 'content' in e && e.content === 'hello there')).toBe(true);
  });

  it('onTranscriptFinal does not echo an empty/whitespace-only turn', async () => {
    await startVoiceCall('c1');
    const before = (useChatStore.getState().timelines['c1'] ?? []).length;
    lastCallbacks?.onTranscriptFinal('   ', true);
    const after = (useChatStore.getState().timelines['c1'] ?? []).length;
    expect(after).toBe(before);
  });

  it('onTtsStart labels the speaker from the target chat name', async () => {
    await startVoiceCall('c2');
    lastCallbacks?.onTtsStart();
    expect(useVoiceStore.getState().call?.speaker).toBe('KITCHEN');
    lastCallbacks?.onTtsEnd(false);
    expect(useVoiceStore.getState().call?.agentSpeaking).toBe(false);
  });

  it('onTtsStart falls back to "AGENT" when the target chat is unknown', async () => {
    await startVoiceCall('unknown-chat');
    lastCallbacks?.onTtsStart();
    expect(useVoiceStore.getState().call?.speaker).toBe('AGENT');
  });

  it('onLevel updates the call level meter', async () => {
    await startVoiceCall('c1');
    lastCallbacks?.onLevel(0.77);
    expect(useVoiceStore.getState().call?.level).toBe(0.77);
  });

  it('the call session onClose stub runs without error', async () => {
    await startVoiceCall('c1');
    expect(() => lastCallbacks?.onClose()).not.toThrow();
  });

  it('onTranscriptFinal/onTtsStart resolve the target chat from the closure when the call has already ended (race)', async () => {
    await startVoiceCall('c1');
    const cb = lastCallbacks!;
    endVoiceCall();
    expect(useVoiceStore.getState().call).toBeNull();
    expect(() => {
      cb.onTranscriptFinal('late text', true);
      cb.onTtsStart();
    }).not.toThrow();
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => 'content' in e && e.content === 'late text')).toBe(true);
  });

  // ========================= D3 error mapping =============================

  it('describeCallError names the Kokoro TTS infra dependency for kokoro_unavailable', () => {
    const out = describeCallError('kokoro_unavailable: connect ECONNREFUSED 127.0.0.1:5019');
    expect(out).toContain('text-to-speech is unavailable');
    expect(out).toContain('KOKORO_MODEL_PATH');
    expect(out).toContain('127.0.0.1:5019');
    expect(out).toContain('ECONNREFUSED');
  });

  it('describeCallError passes through a generic error unchanged (prefixed)', () => {
    expect(describeCallError('concurrency_cap: too many sessions')).toBe(
      'voice call: concurrency_cap: too many sessions',
    );
  });
});
