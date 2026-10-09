// voiceController — bridges the voice gestures (mode 1/2/3) to the audio plane
// (lib/audioSession.ts) and the voiceStore. Components call these functions;
// the controller owns the AudioSession lifecycle and routes audio-plane
// callbacks into the store so the overlays render live state.
//
// spec/07 ## Voice-input modes / ## Barge-in / ## Permission prompts during
// voice / ## Focus-follow.

import { playCallSound } from './callSound.js';
import { openAudioSession, type AudioSessionDeps } from './audioSession.js';
import type { AudioSessionMode } from '@patch/wire/audio';
import { startRecording, type VoiceRecording, type VoiceRecorderDeps } from './voiceRecorder.js';
import { api } from '../api/rest.js';
import { useVoiceStore, type VoiceNoteGesture } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { voiceCapability } from './voiceCapability.js';
import { addressWordOrNull } from '../stores/preferencesStore.js';
import { failed } from './errorCopy.js';

/** Test seam: inject the audio-session opener (defaults to the real one). Used
 *  by the CALL path (mode 2/3), which is genuinely bidirectional/streaming. */
type Opener = typeof openAudioSession;
let openImpl: Opener = openAudioSession;
export function __setAudioOpenerForTests(o: Opener | null): void {
  openImpl = o ?? openAudioSession;
}

/** Test seam: inject the mic recorder factory used by the NOTE path (mode 1). */
type RecorderFactory = (deps?: VoiceRecorderDeps) => Promise<VoiceRecording>;
let recorderImpl: RecorderFactory = startRecording;
export function __setRecorderFactoryForTests(r: RecorderFactory | null): void {
  recorderImpl = r ?? startRecording;
}

// The in-flight note recording (null until the mic has finished spinning up).
let activeRecording: VoiceRecording | null = null;

function speakerFor(chatId: string): string {
  const chat = useChatStore.getState().chats[chatId];
  return (chat?.name ?? 'AGENT').toUpperCase();
}

/**
 * Turn an audio-plane error string (`<code>: <message>`) into a user-facing
 * toast. The host plays the agent's replies back as TTS via Kokoro; when that
 * backend isn't running on the agent host it fails the turn with
 * `kokoro_unavailable` — the call then has no talk-back, which is exactly the
 * "call doesn't speak" symptom. Report the INFRA dependency precisely (NO
 * FALLBACK / no faked speech) instead of a cryptic code, so it's actionable.
 */
export function describeCallError(m: string): string {
  if (m.includes('kokoro_unavailable')) {
    return (
      'voice call: text-to-speech is unavailable — the Kokoro TTS service is not running on ' +
      'the agent host, so replies can’t be spoken. Start the kokoro-sidecar (KOKORO_BACKEND=real ' +
      'needs KOKORO_MODEL_PATH set to the kokoro-onnx model on disk; the host then serves it on ' +
      `127.0.0.1:5019). Original error — ${m}`
    );
  }
  return `voice call: ${m}`;
}

// --------------------------------------------------------------------------
// Mode 1 — voice note (single turn)
// --------------------------------------------------------------------------

/**
 * Begin a voice-note overlay targeting `chatId`. `gesture` records whether the
 * user is press-and-holding (release sends) or toggled a Superwhisper-style
 * session (⏎ sends). Starts recording the mic LOCALLY (record-and-upload) — it
 * does NOT open the streaming audio WSS. `sendVoiceNote` uploads the clip and
 * echoes the transcript the HTTP response returns.
 *
 * WHY UPLOAD, NOT WSS-STREAM: the streaming path only rendered the user's own
 * words if the host streamed an `audio.transcript_final` back over the audio
 * WSS and the client echoed it. On prod the audio plane is flaky (Kokoro/STT
 * partials aren't emitted), so the final never arrived and the spoken message
 * NEVER appeared — even though a reply came back. The upload path takes the
 * transcript straight from the `POST /api/voice/note` response, exactly like
 * the reliable mobile path, so it has no such dependency. NO FALLBACK: a failed
 * record/upload is surfaced loudly, never a silent no-op.
 *
 * `prefix` is whatever was already typed into the composer this note was started
 * from: starting a note must never throw those words away, so they lead the
 * committed turn and the transcript is appended to them (spec/07 § 1. Voice
 * note). Notes started where there is no composer pass nothing.
 */
export async function startVoiceNote(
  chatId: string,
  gesture: VoiceNoteGesture,
  prefix: string = '',
  deps?: VoiceRecorderDeps,
): Promise<void> {
  const store = useVoiceStore.getState();
  if (store.note || store.call) return; // already in a voice interaction
  store.startNote(chatId, gesture, prefix);
  activeRecording = null;
  await (async () => {
    try {
      const rec = await recorderImpl(deps);
      // The overlay may have been cancelled while the mic was spinning up.
      if (useVoiceStore.getState().note === null) {
        rec.cancel();
        return;
      }
      rec.onLevel((l) => useVoiceStore.getState().setNoteLevel(l));
      activeRecording = rec;
    } catch (err) {
      activeRecording = null;
      useUiStore.getState().pushError(failed('voice note'), undefined, (err as Error).message);
      useVoiceStore.getState().endNote();
    }
  })();
}

/**
 * Commit the in-flight voice note: stop the mic, upload the clip to
 * `POST /api/voice/note` (the server transcribes it via the host's Whisper
 * and injects the turn), then echo the RETURNED transcript into the timeline.
 *
 * Echoing the HTTP-returned transcript — rather than a value the host streamed
 * over the audio WSS — is the real fix: the host streams back ONLY the
 * assistant reply, never a live echo of the user's own input, and the audio
 * plane is flaky on prod. Reuses the typed-input path (addLocalMessage) with a
 * localId, so the persisted `[voice • web]` copy reconciles against it by
 * content on replay (chatStore.stripVoicePrefix) instead of duplicating.
 */
export async function sendVoiceNote(): Promise<void> {
  const store = useVoiceStore.getState();
  const note = store.note;
  if (!note) return;
  const chatId = note.chatId;
  store.setNoteSending(true);
  const rec = activeRecording;
  activeRecording = null;
  if (!rec) {
    // The gesture was released before the mic finished spinning up, so there is
    // no clip to send. Never drop a send silently; tell the user to hold longer.
    // (endNote also makes the still-in-flight start cancel its late recording —
    // it re-checks `note === null` once the mic is ready.)
    useUiStore
      .getState()
      .pushError('voice note: nothing recorded (released too quickly?). Hold a beat longer.');
    // The turn is never going to be delivered, so the text this note lifted out
    // of the composer goes straight back into it (NO FALLBACK — a note that does
    // not send must not cost the user the words he had already typed).
    useVoiceStore.getState().restoreComposerText(chatId, note.prefix);
    useVoiceStore.getState().endNote();
    return;
  }
  // APPEAR LIVE (Tom, patch/todo.md): drop the message bubble into the timeline
  // the INSTANT the user finishes speaking, in a live "Transcribing…" state, so
  // it shows immediately rather than only after the upload + Whisper round-trip
  // (a long dead gap on slow/train internet). The same bubble (keyed by localId)
  // fills in with the recognised text when the upload returns.
  const localId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chat = useChatStore.getState();
  chat.addTranscribingMessage(chatId, localId);
  try {
    const clip = await rec.stop();
    // `text` is the turn the server actually injected — the typed prefix plus
    // the transcript. Echoing THAT (not the bare transcript) is what lets the
    // persisted `[voice • web]` copy reconcile by content instead of duplicating.
    const { text } = await api.voiceNote(chatId, clip, note.prefix);
    // Fill (or, for an empty transcript, drop) the live bubble in place. Keeps
    // the localId so the persisted `[voice • web]` copy reconciles by content on
    // replay instead of duplicating; the upload returned 200 (turn delivered),
    // so it never lingers as "Sending…".
    useChatStore.getState().resolveTranscription(chatId, localId, text);
  } catch (err) {
    // NO orphaned live placeholder: remove the transcribing bubble and surface
    // the failure loudly (NO FALLBACK), never a silent stuck "Transcribing…".
    useChatStore.getState().cancelTranscription(chatId, localId);
    useUiStore.getState().pushError(failed('voice note'), undefined, (err as Error).message);
    // The typed text rode along as the note's prefix and the turn never landed,
    // so it is owed back to the composer. Without this, a failed upload silently
    // eats a half-written message — the exact loss this change exists to stop
    // (Tom, Todoist: "erases the current content of text when you start a voice
    // note"). It is handed back BEFORE `endNote` in the `finally` below, which
    // deliberately does not clear it.
    useVoiceStore.getState().restoreComposerText(chatId, note.prefix);
  } finally {
    useVoiceStore.getState().endNote();
  }
}

/**
 * Tap (not hold) gesture: a press released quickly was NOT a press-and-hold —
 * promote the in-flight note to a Superwhisper-style sustained toggle session
 * (spec/07 ## Voice-input modes — mode 1, gesture b). The overlay stays up in
 * persistent LISTENING mode; the audio session keeps streaming; the user sends
 * with ⏎ (or by tapping the control again) and cancels with Esc. The audio
 * plane is identical to PTT — only the commit trigger differs — so there is
 * nothing to re-open; we just re-tag the gesture.
 */
export function promoteNoteToToggle(): void {
  const store = useVoiceStore.getState();
  if (!store.note) return;
  store.setNoteGesture('toggle');
}

/**
 * A press shorter than this is a "tap" (opens a sustained toggle session), not
 * a press-and-hold (release commits). Shared by every control that can start a
 * note — the composer/sidebar mic buttons and the ⌘; / ⌃Space hotkeys — so the
 * gesture means the same thing whichever one the user reached for.
 */
export const TAP_THRESHOLD_MS = 220;

/**
 * End a press-and-hold gesture that lasted `heldMs`: commit the note, or, if
 * the press was too short to be one, promote it to a sustained toggle session
 * (spec/07 ## Voice-input modes — mode 1).
 *
 * The keyboard hotkeys NEED the threshold as much as the mic buttons do. ⌘; is
 * a chord: it is struck and released in ~100ms, which is shorter than any
 * utterance. Committing on the bare keyup uploaded a ~100ms clip and the note
 * died instantly on a failed transcription — the hotkey could not be used at
 * all. Below the threshold the session therefore stays OPEN and keeps
 * listening; ⏎ commits it and esc drops it.
 *
 * Only a `ptt` note is ever committed here. A note already retagged `toggle` is
 * the user's open dictation session, and a keyup that arrives late (macOS does
 * not deliver one for a character key while ⌘ is held, so it lands whenever the
 * modifier is finally released) must not end it under them.
 */
export function releaseVoiceNoteHold(heldMs: number): void {
  const note = useVoiceStore.getState().note;
  if (!note || note.gesture !== 'ptt') return;
  if (heldMs < TAP_THRESHOLD_MS) {
    promoteNoteToToggle();
    return;
  }
  void sendVoiceNote();
}

/** Esc / abort: drop the note WITHOUT uploading the recorded clip. */
export function cancelVoiceNote(): void {
  activeRecording?.cancel();
  activeRecording = null;
  // Cancelling the NOTE cancels the note, not the message the user had already
  // written. Anything the note carried as its prefix goes back to the composer.
  const note = useVoiceStore.getState().note;
  if (note) useVoiceStore.getState().restoreComposerText(note.chatId, note.prefix);
  // Clearing the note first also makes a still-in-flight start (notePrepare)
  // cancel its late recording (it checks `note === null` after the mic spins up).
  useVoiceStore.getState().endNote();
}

// --------------------------------------------------------------------------
// Mode 2 & 3 — voice call (persistent) / focus-follow
// --------------------------------------------------------------------------

/**
 * Open a persistent bidirectional voice call on `chatId`.
 *
 * `mode` (spec/07 § Session modes) is what the session opens in: `call` is the
 * phone call, `waiting` is a call with gaps, `working` is the locked-phone mode
 * that stays open and silent until it has something to say. All three are the
 * SAME session; `setCallMode` moves between them without tearing anything down.
 */
export async function startVoiceCall(
  chatId: string,
  mode: AudioSessionMode = 'call',
  deps?: AudioSessionDeps,
): Promise<void> {
  // Voice happens on a MACHINE (plan H1): the chat's own. Refuse before opening
  // an audio session that would fail at the moment of speaking, and name both
  // the machine and what it needs — the machine is the thing the user can't see.
  // Only refuse on what is KNOWN: a machine that has reported and is missing
  // the speech components. A machine that has not reported yet is not blocked —
  // presence may simply not have arrived, and the audio session fails loudly on
  // its own if voice really is unavailable. Refusing on "unknown" would stop a
  // legitimate call every time the greeting was slow.
  const chatRow = useChatStore.getState().chats[chatId];
  const host = chatRow ? usePresenceStore.getState().hosts[chatRow.daemonId] : undefined;
  if (host?.host) {
    const cap = voiceCapability(host);
    if (!cap.available) {
      useUiStore.getState().pushError(cap.reason);
      return;
    }
  }
  const store = useVoiceStore.getState();
  if (store.call) {
    // Already on a call: it stays on the chat it was started on, wherever the user goes.
    return;
  }
  store.endNote();
  store.startCall(chatId, mode);
  const addressWord = addressWordOrNull();
  try {
    const session = await openImpl({
      chatId,
      role: 'voice-call',
      mode,
      ...(addressWord !== null ? { addressWord } : {}),
      deps: deps ?? {},
      callbacks: {
        onTranscriptPartial: (t) => {
          const s = useVoiceStore.getState();
          s.setCallTranscript(t);
          s.setCallLine('YOU', t);
        },
        onTranscriptFinal: (t, addressed) => {
          const s = useVoiceStore.getState();
          s.setCallTranscript('');
          // Heard but not sent (spec/07 § Session modes): show it greyed so the
          // user can see the mic is alive and see why nothing happened, and do
          // NOT echo it into the chat — it never became a turn.
          if (!addressed) {
            s.setCallUnaddressed(t);
            return;
          }
          s.setCallUnaddressed(null);
          s.setCallLine('YOU', t);
          // Echo the spoken turn into the chat timeline — a call has no composer
          // to render it optimistically, so without this the user never sees
          // what they said. Reuses the typed-input path (addLocalMessage), so it
          // reconciles with the persisted copy on replay by content + localId.
          const text = t.trim();
          if (text) {
            const target = s.call?.chatId ?? chatId;
            const localId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const store = useChatStore.getState();
            store.addLocalMessage(target, text, localId, undefined, undefined, {
              dedupeAgainstPersisted: true,
            });
            // The spoken turn is already committed to the host, and this echo is
            // not deliveryTracker-managed (no live user `chat.message` will clear
            // it), so retire the optimistic "Sending…" mark immediately — otherwise
            // it sticks forever next to a completed reply (same fix as the note path).
            store.clearDelivery(target, localId);
          }
        },
        onState: (st) => useVoiceStore.getState().setCallPhase(st),
        onTtsStart: () => {
          const s = useVoiceStore.getState();
          const target = s.call?.chatId ?? chatId;
          s.setCallSpeaking(true);
          s.setCallLine(speakerFor(target), '');
        },
        onTtsEnd: () => useVoiceStore.getState().setCallSpeaking(false),
        onBargeIn: () => {
          // User spoke over the agent — TTS is cut host-side; reflect the
          // 'listening' state so the user never sees a hung audio session.
          const s = useVoiceStore.getState();
          s.setCallSpeaking(false);
          s.setCallLine('YOU', '');
        },
        onLevel: (l) => useVoiceStore.getState().setCallLevel(l),
        onError: (m) => {
          useUiStore.getState().pushError(describeCallError(m));
          endVoiceCall();
        },
        onClose: () => {
          // The audio socket closed — the host dropped the session, the
          // network went, or the call was ended from the other end. Clear the
          // call state here rather than only in `endVoiceCall`, which is the
          // path a USER-initiated hang-up takes: without this the overlay sits
          // there looking live over a dead socket, and — because a live call
          // defers the post-deploy reload (lib/liveUpdate.ts) — the surface
          // silently stops taking updates for as long as it is stuck.
          //
          // Clear the store directly instead of calling `endVoiceCall`: the
          // socket is already gone, so there is nothing to send `session_end`
          // to, and re-entering the teardown would just close it again.
          const store = useVoiceStore.getState();
          if (store.call === null) return;
          playCallSound('hangup');
          store.setSession(null);
          store.endCall();
        },
      },
    });
    if (useVoiceStore.getState().call === null) {
      session.end('cancelled');
      return;
    }
    useVoiceStore.getState().setSession(session);
    playCallSound('pickup');
  } catch (err) {
    useUiStore.getState().pushError(failed('voice call'), undefined, (err as Error).message);
    useVoiceStore.getState().endCall();
  }
}

/**
 * Move the open session between modes (spec/07 § Session modes). One session,
 * three policies — nothing is torn down or reopened.
 */
export function setCallMode(next: AudioSessionMode): void {
  const store = useVoiceStore.getState();
  if (!store.call) return;
  if (store.call.mode === next) return;
  store.setCallMode(next);
  store.setCallUnaddressed(null);
  store.session?.setSessionMode(next);
}

export function toggleCallMute(): void {
  const store = useVoiceStore.getState();
  if (!store.call) return;
  const next = !store.call.muted;
  store.setCallMuted(next);
  store.session?.setMuted(next);
}

export function endVoiceCall(): void {
  const store = useVoiceStore.getState();
  if (store.call !== null) playCallSound('hangup');
  store.session?.end('ended');
  store.setSession(null);
  store.endCall();
}
