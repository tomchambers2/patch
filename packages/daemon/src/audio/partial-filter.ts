// Hallucination filter for LIVE (interim) transcripts.
//
// A live transcript over a request/response STT is produced by re-transcribing
// the growing utterance prefix. The first passes therefore hand Whisper a
// fraction of a second of speech, often mostly room tone — and Whisper does not
// answer that with an empty string. It answers with the stock phrases its
// training data is saturated with: YouTube sign-offs, subtitle credits, and the
// bare filler token "you". Painting those into the user's composer is worse
// than showing nothing, because they read as words the user said.
//
// This filter is for PARTIALS ONLY. The final transcript is the user's actual
// words and is never touched by it — a note that genuinely is "Thank you."
// still lands in the input, it just does not flicker up as a preview first.
//
// The match is on the WHOLE normalised utterance, not a substring, so a real
// sentence that happens to contain one of these phrases ("thanks for watching
// the dog while we were away") passes through untouched. Only the subtitle
// credits below are matched loosely, because no dictation ever contains them.

/**
 * Lowercase, collapse whitespace, and drop surrounding punctuation and the
 * musical-note glyphs Whisper emits for non-speech audio.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:'"\-–—*_()[\]♪♫…`]+/, '')
    .replace(/[\s.,!?;:'"\-–—*_()[\]♪♫…`]+$/, '')
    .trim();
}

/**
 * Whole-utterance stock answers. Every one of these is something Whisper
 * returns for silence or a fragment, and none of them is worth showing as a
 * guess at what the user is part-way through saying. Ordinary disfluencies
 * ("um", "so", "yeah") are deliberately NOT here: they are real speech, and a
 * partial that shows them is right rather than hallucinated.
 */
const STOCK_PHRASES: ReadonlySet<string> = new Set([
  'thank you',
  'thank you very much',
  'thank you so much',
  'thank you for watching',
  'thank you for watching this video',
  'thanks',
  'thanks for watching',
  'thanks a lot',
  'you',
  'bye',
  'bye bye',
  'goodbye',
  'blank_audio',
  'silence',
  'music',
  'applause',
  'inaudible',
  'no audio',
  'end of transcript',
  'please subscribe',
  'please subscribe to my channel',
  'like and subscribe',
  'see you next time',
  'see you in the next video',
]);

/**
 * Subtitle/credit boilerplate. Matched as a substring because it arrives with
 * arbitrary attribution attached and never occurs in dictation.
 */
const CREDIT_MARKERS: readonly string[] = [
  'amara.org',
  'subtitles by',
  'subtitled by',
  'subtitles provided by',
  'transcription by',
  'transcribed by',
  'captions by',
  'sous-titr',
  'untertitel',
  'subscribe to my channel',
];

/**
 * True when this interim transcript is Whisper answering a near-silent or
 * too-short prefix with boilerplate rather than with the user's words. Callers
 * drop the partial and wait for the next pass; they never apply this to a
 * final.
 */
export function isStockHallucination(text: string): boolean {
  const t = normalise(text);
  // Nothing left once punctuation is stripped — a bare "." or "…" or "♪".
  if (t.length === 0) return true;
  if (STOCK_PHRASES.has(t)) return true;
  return CREDIT_MARKERS.some((marker) => t.includes(marker));
}
