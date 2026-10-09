// Voice store — incoming-call request, active session, voice-note overlay.
// Mirrors the web one. NO FALLBACK: empty audioUrl means "session not yet
// established" and the overlay must surface that to the user.

import { create } from 'zustand';
import type { AudioSessionStateName, AudioSessionMode } from '@patch/wire/audio';

/**
 * Surface-visible call phase (spec/15 § Voice states). Mirrors the host's
 * `audio.state` frame, plus we own `connecting` locally until the WSS session
 * is live. Drives the call overlay's LISTENING → TRANSCRIBING → THINKING →
 * SPEAKING indicator so the user can SEE where the call is.
 */
export type CallPhase = AudioSessionStateName;

export interface IncomingCall {
  callId: string;
  chatId: string;
  message: string | undefined;
  receivedAt: number;
}

export interface ActiveVoiceSession {
  sessionId: string;
  chatId: string;
  audioUrl: string;
  startedAt: number;
}

/**
 * `recording` while the mic is live, `sending` while the clip uploads and is
 * transcribed, `done` while the overlay shows the finished transcript (it
 * clears itself after a reading pause, or on its close control).
 */
export type VoiceNoteState = 'idle' | 'recording' | 'sending' | 'done';

/**
 * How the current voice note was started (spec/15 § Voice states):
 *  - `hold` — press-and-hold, so RELEASE sends (caption "Release to send").
 *  - `tap`  — tap-to-toggle, so the Send control / a second tap sends. Release
 *             must NOT send (nothing is being held).
 */
export type VoiceNoteMode = 'hold' | 'tap';

interface VoiceState {
  incomingCall: IncomingCall | null;
  activeSession: ActiveVoiceSession | null;
  voiceNoteChatId: string | null;
  voiceNoteState: VoiceNoteState;
  voiceNoteMode: VoiceNoteMode;
  voiceNoteTranscript: string;
  /** When the current note's recording began — drives its `0:05` timer. */
  voiceNoteStartedAt: number | null;
  callMuted: boolean;
  callError: string | null;
  /** Live call phase driven by the host `audio.state` frames (+ tts_end → listening). */
  callPhase: CallPhase;
  /** Live (interim) STT transcript for the in-flight call utterance. */
  callTranscriptPartial: string;
  /**
   * Mode of the open session (spec/07 § Session modes). `hands-free` is the
   * line left open for plastering a wall or a long drive: it never ends itself
   * on silence, and only an addressed utterance is a turn.
   */
  callMode: AudioSessionMode;
  /**
   * The last thing the mic heard in a hands-free session that was NOT addressed to
   * Patch, so was heard but not sent. Rendered greyed in the transcript, and
   * cleared by the next utterance.
   */
  callUnaddressed: string | null;
  /**
   * When the session left `connecting` (the host's first `audio.state`). The
   * call timer counts from here, not from the tap, so time spent connecting
   * never reads as time on the call. Null while connecting.
   */
  callConnectedAt: number | null;
  /**
   * The address word the open session was started with, or null when the
   * preferences had not loaded (the host then applies its own default).
   * The hands-free hint names it.
   */
  callAddressWord: string | null;
  /**
   * The hosted engine the open session runs on, named for the call bar
   * (`Gemini Live · heavy`), or null on the local pipeline / config not loaded.
   */
  callEngine: string | null;

  setIncoming(call: IncomingCall | null): void;
  setActive(session: ActiveVoiceSession | null): void;
  startVoiceNote(chatId: string, mode: VoiceNoteMode): void;
  setVoiceNoteState(s: VoiceNoteState): void;
  setVoiceNoteTranscript(t: string): void;
  endVoiceNote(): void;
  setMuted(m: boolean): void;
  setError(msg: string | null): void;
  setCallPhase(p: CallPhase): void;
  setCallTranscriptPartial(t: string): void;
  setCallMode(t: AudioSessionMode): void;
  setCallUnaddressed(t: string | null): void;
  setCallAddressWord(w: string | null): void;
  setCallEngine(e: string | null): void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  incomingCall: null,
  activeSession: null,
  voiceNoteChatId: null,
  voiceNoteState: 'idle',
  voiceNoteMode: 'tap',
  voiceNoteTranscript: '',
  voiceNoteStartedAt: null,
  callMuted: false,
  callError: null,
  callPhase: 'connecting',
  callTranscriptPartial: '',
  callMode: 'call',
  callUnaddressed: null,
  callConnectedAt: null,
  callAddressWord: null,
  callEngine: null,
  setIncoming(call) {
    set({ incomingCall: call });
  },
  setActive(session) {
    set({
      activeSession: session,
      callMuted: false,
      callError: null,
      callPhase: 'connecting',
      callTranscriptPartial: '',
      callUnaddressed: null,
      callConnectedAt: null,
    });
  },
  setError(msg) {
    set({ callError: msg });
  },
  setCallPhase(p) {
    set((st) => ({
      callPhase: p,
      callConnectedAt:
        p !== 'connecting' && st.callConnectedAt === null ? Date.now() : st.callConnectedAt,
    }));
  },
  startVoiceNote(chatId, mode) {
    set({
      voiceNoteChatId: chatId,
      voiceNoteState: 'recording',
      voiceNoteMode: mode,
      voiceNoteTranscript: '',
      voiceNoteStartedAt: Date.now(),
    });
  },
  setVoiceNoteState(s) {
    set({ voiceNoteState: s });
  },
  setVoiceNoteTranscript(t) {
    set({ voiceNoteTranscript: t });
  },
  endVoiceNote() {
    set({
      voiceNoteChatId: null,
      voiceNoteState: 'idle',
      voiceNoteTranscript: '',
      voiceNoteStartedAt: null,
    });
  },
  setMuted(m) {
    set({ callMuted: m });
  },
  setCallTranscriptPartial(t) {
    set({ callTranscriptPartial: t });
  },
  setCallMode(t) {
    set({ callMode: t, callUnaddressed: null });
  },
  setCallUnaddressed(t) {
    set({ callUnaddressed: t });
  },
  setCallAddressWord(w) {
    set({ callAddressWord: w });
  },
  setCallEngine(e) {
    set({ callEngine: e });
  },
}));
