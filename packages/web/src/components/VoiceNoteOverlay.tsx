// VoiceNoteOverlay — mode 1 (voice note, single turn), web/desktop.
//
// Per spec/07 ## Voice-input modes this is JUST the live transcript: one
// bottom-centred line, `…` until words arrive, dimmed while the utterance
// commits. No mic glyph, no chat-name/LISTENING label, no waveform, no
// `⏎ send · esc cancel` hint — a single-turn note must not look like an
// ongoing sustained session (that belongs to the top VoiceBar).
//
// Does NOT steal focus from the underlying app (pointer-events:none) — it is
// pure visual feedback while the user speaks. Driven entirely from
// voiceStore.note; the audio plane (lib/audioSession.ts) streams the transcript
// into the store via the voiceController.

import type { JSX } from 'react';
import { useVoiceStore } from '../stores/voiceStore.js';

/** Input-level bucket (0–4) for the placeholder's live-mic feedback. Buckets,
 *  not the raw float, so the line breathes rather than jittering per frame. */
const LEVEL_STEPS = [0.03, 0.08, 0.16, 0.3];
function levelBucket(level: number): number {
  let bucket = 0;
  for (const step of LEVEL_STEPS) {
    if (level >= step) bucket++;
  }
  return bucket;
}

export function VoiceNoteOverlay(): JSX.Element | null {
  const note = useVoiceStore((s) => s.note);
  if (!note) return null;
  // Web records the whole clip and uploads it on commit, so no words arrive
  // while the user is still speaking: an unchanging `…` is indistinguishable
  // from a dead mic (Tom — "voice note … does not record"). Until there IS a
  // transcript, the same single line tracks the mic level instead (spec/07).
  const level = note.transcript ? 0 : levelBucket(note.level);
  return (
    <div className="voice-note-overlay" data-testid="voice-note-overlay" role="status">
      <div
        className="vn-transcript"
        data-testid="voice-note-transcript"
        data-sending={note.sending ? 'true' : 'false'}
        data-level={String(level)}
      >
        {note.transcript || '…'}
      </div>
    </div>
  );
}
