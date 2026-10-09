// Voice-note commit path (spec/07 § End-to-end voice transport — "Voice note",
// Mobile). These guard the two properties the vanished-note regression taught
// us to pin:
//
//   1) a mobile note commits via the UPLOAD path — `api.voiceNote(chatId, uri)`
//      — NOT a per-frame WSS PCM stream (the streaming rewrite silently dropped
//      notes because the production STT backend isn't streaming);
//   2) a note released BEFORE the mic was ready surfaces a loud error instead
//      of a silent no-op (NO FALLBACK).
//
// The expo-av Recording is the aliased test stub (__tests__/stubs/expo-av.ts):
// prepare/start/stop all succeed and `getURI()` returns a fixed file:// uri.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';
import { useChatStore } from '../src/stores/chatStore';
import { Audio } from 'expo-av';

// Mock the REST surface with a spy for `voiceNote` so we can assert the upload
// call without opening a socket or hitting the network.
const { voiceNoteSpy } = vi.hoisted(() => ({ voiceNoteSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: { voiceNote: voiceNoteSpy } }));

import { startVoiceNote, endVoiceNote } from '../src/lib/voiceNote';

beforeEach(async () => {
  useVoiceStore.setState({
    incomingCall: null,
    activeSession: null,
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
    callMuted: false,
    callError: null,
  });
  useUiStore.setState({ errors: [] });
  // Flush any module-level recording left behind by a previous test so each
  // case starts with a clean recorder.
  await endVoiceNote(false);
  useVoiceStore.setState({ voiceNoteChatId: null, voiceNoteState: 'idle' });
  voiceNoteSpy.mockReset();
  voiceNoteSpy.mockResolvedValue({ ok: true, transcript: 'hello world' });
});

describe('voice note — upload path', () => {
  it('commits a held note via api.voiceNote(chatId, uri), NOT a WSS stream', async () => {
    startVoiceNote('c1', 'hold');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');
    // Release-to-send: endVoiceNote awaits the in-flight prepare, stops the
    // recording, and uploads the captured clip.
    await endVoiceNote(true);

    expect(voiceNoteSpy).toHaveBeenCalledTimes(1);
    const [chatId, uri] = voiceNoteSpy.mock.calls[0] as [string, string];
    expect(chatId).toBe('c1');
    expect(uri).toMatch(/^file:\/\//); // the local clip uri from expo-av
    // The overlay stays up showing the whole transcript (spec/15 § Voice
    // states) — it closes itself after a reading pause.
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c1');
    expect(useVoiceStore.getState().voiceNoteState).toBe('done');
    expect(useVoiceStore.getState().voiceNoteTranscript).toBe('hello world');
  });

  it('a note that transcribes to nothing says so and closes (never a silent close)', async () => {
    voiceNoteSpy.mockResolvedValueOnce({ ok: true, transcript: '   ' });
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);

    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors).toContain('voice note: no speech recognised');
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
    expect(useVoiceStore.getState().voiceNoteState).toBe('idle');
  });

  it('shows "sending" while the clip uploads, then the transcript', async () => {
    let resolveUpload!: (v: { ok: true; transcript: string }) => void;
    voiceNoteSpy.mockReturnValueOnce(
      new Promise((res) => {
        resolveUpload = res;
      }),
    );
    startVoiceNote('c1', 'hold');
    const done = endVoiceNote(true);
    await vi.waitFor(() => expect(voiceNoteSpy).toHaveBeenCalled());
    expect(useVoiceStore.getState().voiceNoteState).toBe('sending');
    resolveUpload({ ok: true, transcript: 'call the plumber' });
    await done;
    expect(useVoiceStore.getState().voiceNoteState).toBe('done');
    expect(useVoiceStore.getState().voiceNoteTranscript).toBe('call the plumber');
  });

  it('a newer note that replaced this one during the upload is left alone', async () => {
    let resolveUpload!: (v: { ok: true; transcript: string }) => void;
    voiceNoteSpy.mockReturnValueOnce(
      new Promise((res) => {
        resolveUpload = res;
      }),
    );
    startVoiceNote('c1', 'hold');
    const done = endVoiceNote(true);
    await vi.waitFor(() => expect(voiceNoteSpy).toHaveBeenCalled());
    // A second note starts on another chat while the first is uploading.
    useVoiceStore.getState().startVoiceNote('c2', 'tap');
    resolveUpload({ ok: true, transcript: 'first note' });
    await done;
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c2');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');
    expect(useVoiceStore.getState().voiceNoteTranscript).toBe('');
  });

  it('surfaces the upload failure loudly (no silent swallow) and clears the overlay', async () => {
    voiceNoteSpy.mockRejectedValueOnce(new Error('server 500'));
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);

    expect(voiceNoteSpy).toHaveBeenCalledTimes(1);
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /voice note failed: server 500/.test(m))).toBe(true);
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('a stopAndUnloadAsync failure on commit surfaces an error and never uploads', async () => {
    vi.spyOn(Audio.Recording.prototype, 'stopAndUnloadAsync').mockRejectedValueOnce(
      new Error('hardware went away'),
    );
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);
    expect(voiceNoteSpy).not.toHaveBeenCalled();
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /recording stop failed: hardware went away/.test(m))).toBe(true);
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('a null getURI() (nothing actually captured) surfaces an error and never uploads', async () => {
    vi.spyOn(Audio.Recording.prototype, 'getURI').mockReturnValueOnce(null);
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);
    expect(voiceNoteSpy).not.toHaveBeenCalled();
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /no audio captured/.test(m))).toBe(true);
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });
});

describe('voice note — optimistic echo into the transcript (the bug fix)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('echoes the transcribed turn into the chat timeline (the host streams back only the reply)', async () => {
    voiceNoteSpy.mockResolvedValueOnce({ ok: true, transcript: 'walk the dog at five' });
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const echoed = tl.find(
      (e) => e.kind === 'message' && e.role === 'user' && e.content === 'walk the dog at five',
    );
    expect(echoed).toBeDefined();
    // Carries a localId so it can reconcile against the persisted [voice • mobile] copy.
    expect(echoed?.localId).toBeTruthy();
    // The upload returned 200 → rendered as delivered, not a perpetual "Sending…".
    expect(echoed?.deliveryPending).toBeFalsy();
  });

  it('does NOT echo an empty/whitespace-only transcript', async () => {
    voiceNoteSpy.mockResolvedValueOnce({ ok: true, transcript: '   ' });
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => e.kind === 'message' && e.role === 'user')).toBe(false);
  });

  it('does NOT echo anything when the upload/transcription fails (no fallback)', async () => {
    voiceNoteSpy.mockRejectedValueOnce(new Error('server 500'));
    startVoiceNote('c1', 'hold');
    await endVoiceNote(true);
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => e.kind === 'message' && e.role === 'user')).toBe(false);
    expect(useUiStore.getState().errors.some((e) => /voice note failed/i.test(e.message))).toBe(
      true,
    );
  });
});

describe('voice note — released before the mic was ready', () => {
  it('surfaces an error instead of a silent no-op, and never uploads', async () => {
    // Drive the overlay to a "recording" state via the STORE action directly —
    // this is the state after a gesture fires but BEFORE the async mic prepare
    // has captured a Recording. A commit here must not vanish silently.
    useVoiceStore.getState().startVoiceNote('c1', 'hold');
    expect(useVoiceStore.getState().voiceNoteState).toBe('recording');

    await endVoiceNote(true);

    // No recording was captured, so no upload happened...
    expect(voiceNoteSpy).not.toHaveBeenCalled();
    // ...but the user was told (NO SILENT NO-OP).
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /nothing recorded/i.test(m))).toBe(true);
    // Overlay cleared.
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('a released-before-ready CANCEL (send=false) clears quietly with no error', async () => {
    useVoiceStore.getState().startVoiceNote('c1', 'hold');
    await endVoiceNote(false);
    expect(voiceNoteSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors).toHaveLength(0);
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });
});

describe('startVoiceNote — background prepare chain', () => {
  it('a denied mic permission surfaces an error and clears the overlay', async () => {
    vi.spyOn(Audio, 'requestPermissionsAsync').mockResolvedValueOnce({ granted: false });
    startVoiceNote('c1', 'hold');
    await vi.waitFor(() =>
      expect(
        useUiStore
          .getState()
          .errors.some((e) => /could not start recording: mic permission denied/.test(e.message)),
      ).toBe(true),
    );
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
  });

  it('a note superseded (new gesture) while the permission prompt is open bails silently — no error, no clobber of the new note', async () => {
    let resolvePerm!: (p: { granted: boolean }) => void;
    vi.spyOn(Audio, 'requestPermissionsAsync').mockReturnValueOnce(
      new Promise((r) => {
        resolvePerm = r;
      }),
    );
    startVoiceNote('c1', 'hold'); // gen 1, stuck awaiting permission
    await vi.waitFor(() => expect(Audio.requestPermissionsAsync).toHaveBeenCalled());
    startVoiceNote('c2', 'tap'); // gen 2 — supersedes gen 1
    resolvePerm({ granted: true }); // gen 1's permission finally resolves, stale
    await new Promise((r) => setTimeout(r, 0));
    expect(useUiStore.getState().errors).toHaveLength(0);
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c2'); // untouched by the stale gen-1 continuation
  });

  it('a REJECTED prepare chain from an already-superseded note is swallowed, not surfaced', async () => {
    // Distinct from the case above: there the stale gen-1 continuation
    // resolved cleanly and hit its OWN early-return guard. Here gen-1's
    // chain actually THROWS (permission denied) after being superseded —
    // the `.catch()` handler's gen-check must still swallow it silently
    // rather than clobbering the newer note's state with a stale error.
    let resolvePerm!: (p: { granted: boolean }) => void;
    vi.spyOn(Audio, 'requestPermissionsAsync').mockReturnValueOnce(
      new Promise((r) => {
        resolvePerm = r;
      }),
    );
    startVoiceNote('c1', 'hold'); // gen 1
    await vi.waitFor(() => expect(Audio.requestPermissionsAsync).toHaveBeenCalled());
    startVoiceNote('c2', 'tap'); // gen 2 — supersedes gen 1
    resolvePerm({ granted: false }); // gen 1 rejects (mic permission denied), now stale
    await new Promise((r) => setTimeout(r, 0));
    expect(useUiStore.getState().errors).toHaveLength(0);
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c2');
  });

  it('a note superseded after the audio mode is set (but before the recorder starts) also bails silently', async () => {
    let resolveMode!: () => void;
    vi.spyOn(Audio, 'setAudioModeAsync').mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveMode = r;
      }),
    );
    startVoiceNote('c1', 'hold');
    await vi.waitFor(() => expect(Audio.setAudioModeAsync).toHaveBeenCalled());
    startVoiceNote('c2', 'tap');
    resolveMode();
    await new Promise((r) => setTimeout(r, 0));
    expect(useVoiceStore.getState().voiceNoteChatId).toBe('c2');
  });

  it('a note superseded right after the recorder starts tears the just-started recording down', async () => {
    let resolveStart!: () => void;
    vi.spyOn(Audio.Recording.prototype, 'startAsync').mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveStart = r;
      }),
    );
    const stopSpy = vi.spyOn(Audio.Recording.prototype, 'stopAndUnloadAsync');
    startVoiceNote('c1', 'hold');
    await vi.waitFor(() => expect(Audio.Recording.prototype.startAsync).toHaveBeenCalled());
    startVoiceNote('c2', 'tap');
    resolveStart();
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());
  });
});
