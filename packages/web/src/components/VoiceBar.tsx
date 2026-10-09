// VoiceBar — the surface of a sustained voice session, in BOTH modes
// (spec/07 § Session modes). Replaces the floating call capsule.
//
// The capsule was a call UI: a pill that appeared over the app and said who
// last spoke. Hands-free is not a call — it is a mode you switch on and leave
// on, and in it most of what the mic hears is deliberately dropped (only an
// addressed utterance is a turn). Presented in the capsule that read as a call
// that ignored you: you spoke, the words were discarded at the host for want
// of the address word, and nothing on screen said so.
//
// So a sustained session takes a strip of the window instead, in flow at the
// top of the shell, and that strip always states what the line is doing:
//
//   connecting   Connecting…
//   waiting      hands-free: Waiting for you to say “patch”   ·  call: Listening
//   hearing      Hearing you — the words themselves are in the chat, as your bubble
//   heard        what it heard, greyed — dropped, because it wasn't addressed
//   thinking     Thinking…
//   speaking     Speaking — the reply streams into the chat
//
// Same bar, same controls, one mode switch between them.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Ear, Mic, MicOff, MessageSquare, PhoneOff } from 'lucide-react';
import type { AudioSessionMode } from '@patch/wire/audio';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { toggleCallMute, endVoiceCall, setCallMode } from '../lib/voiceController.js';

/** How long a dropped utterance stays on the bar before it returns to waiting. */
export const HEARD_LINGER_MS = 8_000;

const MODE_HEAD: Record<AudioSessionMode, string> = {
  call: 'ON CALL',
  'hands-free': 'HANDS-FREE',
};
const NEXT_MODE: Record<AudioSessionMode, AudioSessionMode> = {
  call: 'hands-free',
  'hands-free': 'call',
};

export function VoiceBar(): JSX.Element | null {
  const call = useVoiceStore((s) => s.call);
  const chats = useChatStore((s) => s.chats);
  const addressWord = usePreferencesStore((s) => s.preferences.addressWord);
  const [now, setNow] = useState(() => Date.now());

  // Tick off the stable startedAt, NOT the whole `call` object: `call` mutates
  // on every audio frame (level/transcript updates fire many times a second),
  // so depending on it here would clear and recreate the interval before it
  // ever reached 1000ms, freezing the timer at 00:00.
  const startedAt = call?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // A dropped utterance is feedback ("it heard you, it did not send it"), not a
  // log: show it, then go back to saying what the line is waiting for.
  const unaddressed = call?.unaddressed ?? null;
  useEffect(() => {
    if (unaddressed === null) return;
    const id = window.setTimeout(
      () => useVoiceStore.getState().setCallUnaddressed(null),
      HEARD_LINGER_MS,
    );
    return () => window.clearTimeout(id);
  }, [unaddressed]);

  if (!call) return null;

  const chat = chats[call.chatId];
  // A chat with no title yet reads "New chat" — never its raw id.
  const name = chat?.name ?? 'New chat';
  const word = addressWord.trim() === '' ? 'patch' : addressWord.trim();
  const next = NEXT_MODE[call.mode];
  const { tag, text, state } = describeLine(call, name, word);

  return (
    <div
      className="voice-bar"
      data-testid="voice-bar"
      data-mode={call.mode}
      data-state={state}
      role="status"
    >
      <span className="vb-mode" data-testid="voice-bar-head">
        {call.mode === 'hands-free' ? <Ear size={14} aria-hidden /> : <Mic size={14} aria-hidden />}
        {MODE_HEAD[call.mode]}
      </span>
      <span className="vb-chat" data-testid="voice-bar-chat">
        {name}
      </span>
      <span className="vb-line" data-testid="voice-bar-line">
        {tag === null ? null : <span className="vb-tag">{tag}</span>}
        <span className="vb-text">{text}</span>
      </span>
      <span className="vb-timer" data-testid="voice-bar-timer">
        {formatElapsed(Math.max(0, now - call.startedAt))}
      </span>
      <button
        type="button"
        className={`vb-action ${call.muted ? 'muted' : ''}`}
        data-testid="voice-bar-mute"
        aria-label={call.muted ? 'unmute' : 'mute'}
        onClick={toggleCallMute}
      >
        {call.muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
      </button>
      {/* One control switches the two modes without tearing the session down. */}
      <button
        type="button"
        className="vb-action"
        data-testid="voice-bar-mode"
        aria-label={`switch to ${MODE_HEAD[next].toLowerCase()}`}
        title={
          next === 'hands-free'
            ? `Switch to hands-free — it then only answers when you say “${word}”`
            : 'Switch to a call — it answers everything you say'
        }
        onClick={() => setCallMode(next)}
      >
        {next === 'hands-free' ? (
          <Ear size={16} aria-hidden />
        ) : (
          <MessageSquare size={16} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="vb-action end"
        data-testid="voice-bar-end"
        aria-label="end voice session"
        onClick={endVoiceCall}
      >
        <PhoneOff size={16} aria-hidden />
      </button>
    </div>
  );
}

interface Line {
  /** Short left-hand label, or null when the text speaks for itself. */
  tag: string | null;
  text: string;
  /** Drives the bar's styling, and what a test asserts on. */
  state: 'connecting' | 'waiting' | 'hearing' | 'heard' | 'thinking' | 'speaking';
}

interface LineInput {
  mode: AudioSessionMode;
  phase: string;
  agentSpeaking: boolean;
  transcript: string;
  unaddressed: string | null;
  lastLine: string;
}

/**
 * What the bar says right now. Ordered by precedence: what the line is DOING
 * (speaking / thinking / hearing) beats what it last did (heard), which beats
 * the resting state — and the resting state is the one that differs by mode,
 * because in hands-free it has to name the word that wakes it.
 */
export function describeLine(call: LineInput, _chatName: string, addressWord: string): Line {
  if (call.agentSpeaking || call.phase === 'speaking') {
    return { tag: null, text: 'Speaking', state: 'speaking' };
  }
  if (call.phase === 'thinking') return { tag: null, text: 'Thinking…', state: 'thinking' };
  if (call.transcript !== '') return { tag: null, text: 'Hearing you', state: 'hearing' };
  if (call.unaddressed !== null) {
    return {
      tag: 'HEARD',
      text: `${call.unaddressed} — not addressed, so not sent`,
      state: 'heard',
    };
  }
  if (call.phase === 'connecting') {
    return { tag: null, text: 'Connecting…', state: 'connecting' };
  }
  if (call.mode === 'hands-free') {
    return { tag: null, text: `Waiting for you to say “${addressWord}”`, state: 'waiting' };
  }
  return { tag: null, text: 'Listening', state: 'waiting' };
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
