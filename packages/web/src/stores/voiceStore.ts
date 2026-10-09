// voiceStore — surface-side voice UX state (spec/07 ## Voice-input modes).
//
// Three modes, one capsule overlay vocabulary:
//   1. voice-note (single turn)  — PTT hold OR Superwhisper-style toggle.
//   2. voice-call (persistent)   — bidirectional, like a phone call.
//   3. focus-follow (chat header)— special case of #2 scoped to a chat.
//
// Plus the agent-initiated incoming-call banner (spec/14 ## Manager
// incoming-call UX) and the mid-voice permission prompt (spec/07 ## Permission
// prompts during voice).
//
// The store owns the live UI state; the audio plane itself lives in
// lib/audioSession.ts (the host-side STT/TTS pipeline is E1). The store
// holds an opaque handle to the live AudioSession so the overlays can mute /
// end / read its sessionId without importing the audio module.

import { create } from 'zustand';
import type { AudioSession } from '../lib/audioSession.js';
import type { AudioSessionMode, AudioSessionStateName } from '@patch/wire/audio';

export interface IncomingCall {
  callId: string;
  chatId: string;
  message: string | undefined;
  /** Time we received the request. Drives the optional 30s timeout fallback. */
  receivedAt: number;
}

/** Which gesture started the voice-note overlay. */
export type VoiceNoteGesture = 'ptt' | 'toggle';

/** Voice-note overlay state (mode 1). Null when no note is in flight. */
export interface VoiceNoteState {
  /** Target chat the utterance commits to. */
  chatId: string;
  gesture: VoiceNoteGesture;
  /** Live STT transcript (italic, updates as the user speaks). */
  transcript: string;
  /** Smoothed input level 0..1 for the waveform visualiser. */
  level: number;
  /** True once the user has released/⏎ and we're committing the turn. */
  sending: boolean;
  /**
   * Text already typed into the composer the note was started from (spec/07
   * § 1. Voice note). It leads the committed turn and the transcript is appended
   * to it. Empty for every note started somewhere with no composer — a sidebar
   * row, the hotkeys, the menu bar.
   */
  prefix: string;
}

/** Speaker attribution for the call overlay's last-spoken line. */
export type Speaker = 'YOU' | 'MANAGER' | 'KITCHEN' | string;

/** Voice-call overlay state (modes 2 & 3). Null when not on a call. */
export interface VoiceCallState {
  /** Target chat (focus-follow updates this mid-call). */
  chatId: string;
  startedAt: number;
  muted: boolean;
  /** Last spoken line + who said it (YOU while listening, agent while speaking). */
  lastLine: string;
  speaker: Speaker;
  /** True while the agent's TTS is playing (drives the green ripple). */
  agentSpeaking: boolean;
  /** Live partial transcript of the user's current utterance. */
  transcript: string;
  level: number;
  /**
   * Session mode (spec/07 § Session modes) — `call`, `waiting`, or the
   * locked-phone `working`.
   */
  mode: AudioSessionMode;
  /**
   * The last thing the mic heard in an address-gated session that was NOT
   * addressed to Patch, so was heard but not sent. Rendered greyed, and cleared by the next
   * utterance — it exists to show the mic is alive and to say why nothing
   * happened, not to accumulate a log of the room.
   */
  unaddressed: string | null;
  /**
   * Live turn-cycle phase, driven by the host's `audio.state` frames. The
   * hands-free bar reads it to say what the line is doing right now
   * (listening / transcribing / thinking / speaking) instead of looking dead
   * between utterances (spec/07 § Session modes).
   */
  phase: AudioSessionStateName;
}

/** Mid-voice permission prompt (spec/07 ## Permission prompts during voice). */
export interface VoicePermission {
  requestId: string;
  chatId: string;
  /** Human-readable summary of what's being requested. */
  summary: string;
}

interface VoiceState {
  incomingCall: IncomingCall | null;
  note: VoiceNoteState | null;
  /**
   * Text a note OWES BACK to a composer: what was typed before the note was
   * started, for a note that then failed or was cancelled (spec/07 § 1. Voice
   * note). The composer for `chatId` takes it back into its input and clears
   * this.
   *
   * NO FALLBACK: starting a note lifts the typed text out of the composer and
   * into the pending turn, so a note that never delivers has to hand it back or
   * the words are simply gone — which is the bug this whole path exists to fix.
   * It lives in the store rather than being passed back through a callback
   * because the composer that owed it is usually NOT the composer that gets it:
   * the new-chat composer unmounts on the navigation into the chat it created.
   */
  composerRestore: { chatId: string; text: string } | null;
  call: VoiceCallState | null;
  permission: VoicePermission | null;
  /** Opaque handle to the live audio session (set by the gesture handlers). */
  session: AudioSession | null;
  /**
   * Physical voice devices (HA Voice PE) currently mid-session, keyed by
   * deviceId → user-given name ("kitchen"). Driven by `device.session` wire
   * events (`16-voice-device.md`). Backs the Speakers-row pill in the sidebar.
   */
  activeDevices: Record<string, string>;

  setIncoming(call: IncomingCall | null): void;
  setSession(session: AudioSession | null): void;

  // --- voice-note (mode 1) ---
  startNote(chatId: string, gesture: VoiceNoteGesture, prefix?: string): void;
  /** Promote an in-flight PTT note to a sustained toggle session (tap gesture). */
  setNoteGesture(gesture: VoiceNoteGesture): void;
  setNoteTranscript(text: string): void;
  setNoteLevel(level: number): void;
  setNoteSending(sending: boolean): void;
  endNote(): void;
  /** Hand `text` back to `chatId`'s composer (a note failed/was cancelled). */
  restoreComposerText(chatId: string, text: string): void;
  /** The composer has taken the owed text back — drop it. */
  clearComposerRestore(): void;

  // --- voice-call (modes 2 & 3) ---
  startCall(chatId: string, mode?: AudioSessionMode): void;
  setCallMode(mode: AudioSessionMode): void;
  setCallUnaddressed(text: string | null): void;
  setCallPhase(phase: AudioSessionStateName): void;
  /** Focus-follow: route subsequent utterances to a different chat mid-call. */
  setCallChat(chatId: string): void;
  setCallMuted(muted: boolean): void;
  setCallLine(speaker: Speaker, line: string): void;
  setCallSpeaking(speaking: boolean): void;
  setCallTranscript(text: string): void;
  setCallLevel(level: number): void;
  endCall(): void;

  // --- permission-during-voice ---
  setPermission(p: VoicePermission | null): void;

  /** Apply a `device.session` event: add on active, remove on end. */
  setDeviceSession(deviceId: string, name: string, active: boolean): void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  incomingCall: null,
  note: null,
  composerRestore: null,
  call: null,
  permission: null,
  session: null,
  activeDevices: {},

  setIncoming(call) {
    set({ incomingCall: call });
  },
  setSession(session) {
    set({ session });
  },

  startNote(chatId, gesture, prefix = '') {
    set({
      note: { chatId, gesture, transcript: '', level: 0, sending: false, prefix },
    });
  },
  setNoteGesture(gesture) {
    set((s) => (s.note ? { note: { ...s.note, gesture } } : {}));
  },
  setNoteTranscript(text) {
    set((s) => (s.note ? { note: { ...s.note, transcript: text } } : {}));
  },
  setNoteLevel(level) {
    set((s) => (s.note ? { note: { ...s.note, level } } : {}));
  },
  setNoteSending(sending) {
    set((s) => (s.note ? { note: { ...s.note, sending } } : {}));
  },
  endNote() {
    // Deliberately leaves `composerRestore` alone: the failure paths set the
    // owed text and THEN end the note (in a `finally`), so clearing it here
    // would throw the user's words away at the last moment.
    set({ note: null });
  },
  restoreComposerText(chatId, text) {
    if (text.length === 0) return; // nothing was typed; nothing is owed
    set({ composerRestore: { chatId, text } });
  },
  clearComposerRestore() {
    set({ composerRestore: null });
  },

  startCall(chatId, mode = 'call') {
    set({
      call: {
        chatId,
        startedAt: Date.now(),
        muted: false,
        lastLine: '',
        speaker: 'YOU',
        agentSpeaking: false,
        transcript: '',
        level: 0,
        mode,
        unaddressed: null,
        phase: 'connecting',
      },
    });
  },
  setCallMode(mode) {
    set((s) => (s.call ? { call: { ...s.call, mode } } : {}));
  },
  setCallUnaddressed(text) {
    set((s) => (s.call ? { call: { ...s.call, unaddressed: text } } : {}));
  },
  setCallPhase(phase) {
    set((s) => (s.call ? { call: { ...s.call, phase } } : {}));
  },
  setCallChat(chatId) {
    set((s) => (s.call ? { call: { ...s.call, chatId } } : {}));
  },
  setCallMuted(muted) {
    set((s) => (s.call ? { call: { ...s.call, muted } } : {}));
  },
  setCallLine(speaker, line) {
    set((s) => (s.call ? { call: { ...s.call, speaker, lastLine: line } } : {}));
  },
  setCallSpeaking(speaking) {
    set((s) => (s.call ? { call: { ...s.call, agentSpeaking: speaking } } : {}));
  },
  setCallTranscript(text) {
    set((s) => (s.call ? { call: { ...s.call, transcript: text } } : {}));
  },
  setCallLevel(level) {
    set((s) => (s.call ? { call: { ...s.call, level } } : {}));
  },
  endCall() {
    set({ call: null });
  },

  setPermission(p) {
    set({ permission: p });
  },

  setDeviceSession(deviceId, name, active) {
    set((state) => {
      const next = { ...state.activeDevices };
      if (active) {
        next[deviceId] = name;
      } else {
        delete next[deviceId];
      }
      return { activeDevices: next };
    });
  },
}));
