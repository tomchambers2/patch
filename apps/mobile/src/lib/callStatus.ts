// Pure wording for the in-chat call bar, the on-call pill and the voice
// overlays (spec/15 § Voice states). Kept out of the components so every
// surface names the same state the same way and the rules are unit-testable.

import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { AudioSessionMode, AudioSessionStateName } from '@patch/wire/audio';
import { deriveChatTitle } from './labels';

/** `m:ss` for a duration in ms (never negative — a skewed clock reads 0:00). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/** The session's mode, named plainly: what makes it respond. */
export function callModeLabel(mode: AudioSessionMode): string {
  return mode === 'hands-free' ? 'Hands-free' : 'Call';
}

/**
 * What the line is doing right now. `connecting` is its own state — a
 * session that has not reached the host is not listening, and saying
 * "Listening" before it is would be a lie about a dead mic.
 */
export function callPhaseLabel(phase: AudioSessionStateName): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting';
    case 'listening':
      return 'Listening';
    case 'transcribing':
      return 'Hearing you';
    case 'thinking':
      return 'Thinking';
    case 'speaking':
      return 'Speaking';
  }
}

/**
 * The one-line hint under a hands-free bar: what makes it respond. Only
 * hands-free needs one — in a call every utterance is a turn. Null when no
 * hint applies.
 */
export function handsFreeHint(mode: AudioSessionMode, addressWord: string | null): string | null {
  if (mode !== 'hands-free') return null;
  const word = addressWord?.trim();
  return word
    ? `Start with “${word}” — or reply within 30s of it speaking`
    : 'Start with your address word — or reply within 30s of it speaking';
}

/** The name a call pill shows for the chat the call is on. */
export function callChatName(
  chatId: string,
  row: { name: string | null; chatId: string; folder: string } | undefined,
): string {
  if (chatId === SPECIAL_THREAD_IDS.manager) return 'Manager';
  if (chatId === SPECIAL_THREAD_IDS.speakers) return 'Speakers';
  return row ? deriveChatTitle(row) : 'Chat';
}
