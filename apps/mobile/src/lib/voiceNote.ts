// Voice-note overlay backend (spec/07 § End-to-end voice transport — "Voice
// note (single utterance)", Mobile).
//
// On mobile a note does NOT commit via a per-frame streaming PCM tap. A note is
// recorded locally with expo-av and, on the gesture-end commit, uploaded as ONE
// m4a file to `POST /api/voice/note`. The server hands the clip to the host
// (the Whisper owner) via `patch.voice_note.transcribe_request`, then injects
// the transcript as the chat's next user turn tagged
// `source: { kind: 'voice-app', surfaceKind: 'mobile' }` — the reply streams
// back into the timeline over the main WS.
//
// WHY UPLOAD, NOT WSS-STREAM: the earlier streaming rewrite depended on the
// brand-new `PatchVoiceMic` native module AND on the host emitting live STT
// partials — but the production Groq backend is NOT streaming (whisper.ts:
// "Streaming partials are out-of-scope"), so the live transcript was always
// blank, and a quick hold/release raced the async WSS-open so `session_start` /
// `session_end` were never sent and the note SILENTLY vanished (worst on the
// Manager raised-tab, the fastest gesture). The upload path has no such race
// (the recording is captured locally and flushed on release) and no dependence
// on the unproven native mic. NO FALLBACK: a failed record/upload is surfaced
// loudly, never a silent no-op.
//
// IMPORTANT: the overlay MUST appear the instant the gesture fires. Mic
// permission + expo-av prepare are async (seconds on a loaded device, or
// reject), so we flip the store FIRST — synchronously — to mount the overlay,
// THEN prepare/start recording in the background.

import { Audio } from 'expo-av';
import { Keyboard } from 'react-native';
import { api } from '../api/rest';
import { useVoiceStore, type VoiceNoteMode } from '../stores/voiceStore';
import { useUiStore } from '../stores/uiStore';
import { useChatStore } from '../stores/chatStore';
import { voiceKeyRefusal } from './voiceKeys';

let _recording: Audio.Recording | null = null;
// Resolves when the async prepare/start settles (recording live, superseded, or
// failed). `endVoiceNote` AWAITS this so a quick hold-release still catches the
// recording instead of racing past a half-prepared mic (the old silent no-op).
let _prepare: Promise<void> | null = null;
// Bumped each time a note starts; a stale async prepare (or a release that
// arrives before prepare finished) checks it and bails without clobbering a
// newer note.
let _noteGen = 0;

export function startVoiceNote(chatId: string, mode: VoiceNoteMode = 'tap'): void {
  // 0) A note on a dictation backend this chat's host has no key for would be
  // recorded and then refused on upload — say so at the press instead.
  const refusal = voiceKeyRefusal(chatId, 'dictation');
  if (refusal !== null) {
    console.log(`[patch-voice] note refused: ${refusal}`);
    useUiStore.getState().pushError(`voice note: ${refusal}`);
    return;
  }
  // 1) Mount the overlay synchronously — no await before this point.
  const gen = ++_noteGen;
  // The recording overlay is a VOICE surface — never leave the composer's soft
  // keyboard up over it (spec/15 § Voice states). Dismiss it as recording begins.
  Keyboard.dismiss();
  useVoiceStore.getState().startVoiceNote(chatId, mode);
  // Diagnostic (surfaces in logcat as ReactNativeJS) — proves the gesture
  // handler fired and the overlay state flipped synchronously.
  console.log(`[patch-voice] note start chatId=${chatId} mode=${mode} overlay=recording`);

  // 2) Prepare + start recording in the background.
  _prepare = (async () => {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) throw new Error('mic permission denied');
    if (gen !== _noteGen) return; // released/replaced during permission prompt
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    if (gen !== _noteGen) return;
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await rec.startAsync();
    if (gen !== _noteGen) {
      // Released during prepare — tear the just-started recording down.
      await rec.stopAndUnloadAsync().catch(() => undefined);
      return;
    }
    _recording = rec;
    console.log('[patch-voice] note recording live (expo-av AudioRecorder)');
  })();
  _prepare.catch((e: unknown) => {
    if (gen !== _noteGen) return;
    useVoiceStore.getState().endVoiceNote();
    useUiStore
      .getState()
      .pushError(`voice note: could not start recording: ${(e as Error).message}`);
  });
}

/**
 * `onPressOut` handler for the hold-to-talk callers (Voice tab, chat-row mic,
 * Manager row, composer mic): send the note IFF it was started by a press-and-
 * HOLD (mode `hold`) for this chat. A tap-started (mode `tap`) note is untouched
 * — it sends via a second tap / the overlay Send, never on finger-release.
 */
export function releaseVoiceNoteIfHeld(chatId: string): void {
  const st = useVoiceStore.getState();
  if (
    st.voiceNoteChatId === chatId &&
    st.voiceNoteState === 'recording' &&
    st.voiceNoteMode === 'hold'
  ) {
    void endVoiceNote(true);
  }
}

/**
 * End the note. `send` stops the recording and uploads the clip to
 * `POST /api/voice/note` (the server injects the transcript as one user turn,
 * whose reply streams into the timeline); `!send` discards it. A sent note
 * that transcribed to words leaves the overlay showing them (state `done`);
 * every other outcome clears it — even if released before the recording
 * finished preparing.
 *
 * NO SILENT NO-OP: if `send` is requested but nothing was captured (e.g. the
 * gesture was released faster than the mic could spin up), the user is told.
 */
export async function endVoiceNote(send: boolean): Promise<void> {
  const chatId = useVoiceStore.getState().voiceNoteChatId;
  // Wait for a still-in-flight prepare so a quick tap/hold-release still has a
  // recording to send (the fix for the vanished-note race). A failed prepare
  // already toasted + cleared the overlay in startVoiceNote.
  const prep = _prepare;
  if (prep) await prep.catch(() => undefined);
  const rec = _recording;
  _recording = null;
  _prepare = null;

  if (!rec) {
    // Prepare failed (already surfaced) or the gesture was released before the
    // mic spun up. Never drop a send silently.
    if (send) {
      useUiStore
        .getState()
        .pushError('voice note: nothing recorded (released too quickly?). Hold a beat longer.');
      console.log('[patch-voice] note commit had NO recording (released before mic ready)');
    }
    useVoiceStore.getState().endVoiceNote();
    return;
  }

  if (!send) {
    await rec.stopAndUnloadAsync().catch(() => undefined);
    useVoiceStore.getState().endVoiceNote();
    console.log('[patch-voice] note cancelled');
    return;
  }

  useVoiceStore.getState().setVoiceNoteState('sending');
  let uri: string | null = null;
  try {
    await rec.stopAndUnloadAsync();
    uri = rec.getURI();
  } catch (e) {
    useUiStore.getState().pushError(`voice note: recording stop failed: ${(e as Error).message}`);
    useVoiceStore.getState().endVoiceNote();
    return;
  }
  if (!uri || !chatId) {
    useUiStore.getState().pushError('voice note: no audio captured');
    useVoiceStore.getState().endVoiceNote();
    return;
  }

  console.log(`[patch-voice] note uploading clip chatId=${chatId} uri=${uri}`);
  try {
    const { transcript } = await api.voiceNote(chatId, uri);
    console.log(`[patch-voice] note transcribed + turn submitted: "${transcript}"`);
    // Echo the transcribed turn into the chat timeline. The host streams back
    // ONLY the assistant reply — never a live echo of the user's own input — so
    // without this the user never sees what they said (the transcript vanished
    // the instant the overlay closed). Mirrors the composer's optimistic send
    // (appendLocalUserMessage + localId); the persisted `[voice • mobile]` copy
    // reconciles against it by content on replay (chatStore.stripVoicePrefix).
    const text = transcript.trim();
    if (text) {
      const localId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const chat = useChatStore.getState();
      chat.appendLocalUserMessage(chatId, text, localId, undefined, {
        dedupeAgainstPersisted: true,
      });
      // The upload already returned 200 — the turn IS delivered (the host
      // injected it). This is not a deliveryTracker-managed typed input and no
      // live user `chat.message` will arrive to reconcile it, so clear the
      // optimistic "Sending…" mark now rather than leaving a perpetual spinner.
      chat.clearDelivery(chatId, localId);
    }
    // Leave the overlay up showing what was heard, in full (spec/15 § Voice
    // states) — the overlay clears itself after a reading pause, or on its
    // close control. A note that a newer one has already replaced is left
    // alone. An empty transcript has nothing to show, so it just closes.
    const st = useVoiceStore.getState();
    if (st.voiceNoteChatId !== chatId || st.voiceNoteState !== 'sending') return;
    if (!text) {
      // Never a silent close: a note that heard nothing says so.
      useUiStore.getState().pushError('voice note: no speech recognised');
      st.endVoiceNote();
      return;
    }
    st.setVoiceNoteTranscript(text);
    st.setVoiceNoteState('done');
  } catch (e) {
    useUiStore.getState().pushError(`voice note failed: ${(e as Error).message}`);
    console.log(`[patch-voice] note upload FAILED: ${(e as Error).message}`);
    useVoiceStore.getState().endVoiceNote();
  }
}
