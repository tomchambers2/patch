// Voice session orchestrator (group 13).
//
// One instance per active audio WSS connection. Owns the per-session VAD,
// AEC, current chatId (focus-follow), and the state machine:
//
//   connecting → listening → transcribing → thinking → speaking → listening
//
// Barge-in: VAD start fires while state === 'speaking' → cancel the
// in-flight Kokoro stream, drop buffered TTS PCM, transition straight to
// 'listening' (or 'transcribing' if VAD-end then arrives quickly).

import type { Logger } from 'pino';
import type { ChatInputSource, WireEvent } from '@patch/wire';
import type { AudioSurfaceKind, AudioSessionMode } from '@patch/wire/audio';
import type { AudioEvent } from '@patch/wire/audio';
import type { Vad } from './vad.js';
import type { AecProcessor } from './aec.js';
import type { WhisperBackend } from './whisper.js';
import type { KokoroBackend, KokoroSynthesis } from './kokoro.js';
import { modeRequiresAddress } from '@patch/wire/audio';
import { stripMarkdownForSpeech, extractSentences } from './speechText.js';
import { isStockHallucination } from './partial-filter.js';
import type { VoiceSessionLike } from './voice-session-like.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { GROQ_MIN_BILLED_SECONDS, type EngineCosting, type SttUsage } from './voiceCost.js';

export type SessionState = 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/** The two ingress sources a voice session can produce. */
export type VoiceTurnSource = Extract<ChatInputSource, { kind: 'voice-app' | 'voice-device' }>;

export interface SessionInit {
  sessionId: string;
  accountId: string;
  surfaceId: string;
  /** Audio-plane surface kind — includes `'device'` for physical speakers. */
  surfaceKind: AudioSurfaceKind;
  chatId: string;
  role: 'voice-note' | 'voice-call' | 'voice-device-conv';
  surfaceHasAec: boolean;
  /**
   * Physical voice-device identity. Present iff `surfaceKind === 'device'`.
   * Drives the `[voice • device:<deviceId>]` turn tag + TTS auto-route back to
   * the originating device (spec/06, spec/16).
   */
  deviceId?: string;
  /**
   * Mode this session opens in (spec/07 § Session modes). Undefined is `call`,
   * which is what a note and a device session always are.
   */
  mode?: AudioSessionMode;
  /**
   * Address word this session listens for in `waiting` / `working` (spec/07
   * § Session modes). Undefined uses {@link DEFAULT_ADDRESS_WORD}.
   */
  addressWord?: string;
}

export interface SessionDeps {
  vad: Vad;
  aec: AecProcessor;
  whisper: WhisperBackend;
  kokoro: KokoroBackend;
  logger: Logger;
  /**
   * Forward an audio control event back to the surface WS. Binary PCM
   * frames go through `sendBinary` separately.
   */
  sendAudio: (ev: AudioEvent) => void;
  sendBinary: (pcm: Int16Array) => void;
  /**
   * Submit a finalised user turn to the host's chat pipeline. The wire
   * `ChatInputSource` is stamped automatically; only the message text is
   * provided here. Returns the assistant's full reply text once the SDK
   * turn finishes — the orchestrator then feeds it into Kokoro.
   */
  submitUserTurn: (args: {
    chatId: string;
    message: string;
    source: VoiceTurnSource;
    /**
     * Streaming hook: called with each incremental chunk of the assistant's
     * reply text as it generates, so the session can synthesise + speak
     * complete sentences while later tokens are still arriving (spec/07 —
     * "Kokoro starts speaking on the first sentence boundary"). Optional: a
     * backend that doesn't stream simply never calls it, and the session
     * speaks the full returned reply at the end (fallback).
     */
    onReplyText?: (chunk: string) => void;
    /**
     * spec/07 § The fast voice and the chat's agent — a fast voice handing a
     * request to the chat's agent. The turn is tagged as a hand-off rather
     * than as the user's own words, which are already in the timeline.
     */
    handoff?: boolean;
  }) => Promise<string>;
  /**
   * Returns the currently configured Kokoro voice name for this host, or
   * undefined to use the sidecar's own default. Read on every synthesis call
   * so a settings change takes effect on the next utterance without a session
   * restart.
   */
  getKokoroVoice?: () => string | undefined;
  /**
   * Optional hook for fanout WireEvents (e.g. emitting the user's
   * transcribed message into chat history via the existing emit pipeline).
   * Group 13 keeps this thin: orchestrator calls submitUserTurn, which
   * goes through the host's existing chat path; fanout happens there.
   */
  emitWire?: (ev: WireEvent) => void;
  /**
   * Spec/07 ## Permission prompts during voice: when an utterance lands while
   * the focused chat is `awaiting-permission`, the host parses the spoken
   * word as a yes/no answer instead of forwarding it as a new user-turn.
   * `getPendingPermission` returns the outstanding requestId for a chat (or
   * undefined); `resolvePermission` emits the `chat.permission_response`.
   * Both optional — the in-process audio smoke tests don't wire the host.
   */
  getPendingPermission?: (chatId: string) => string | undefined;
  resolvePermission?: (requestId: string, approve: boolean) => void;
}

/** Address word an address-gated session listens for when the account sets none. */
export const DEFAULT_ADDRESS_WORD = 'patch';

/**
 * How long after Patch stops speaking an utterance still counts as addressed
 * to it (spec/07 § Session modes). This is what lets the user answer an
 * interrupt, and carry on that exchange, without saying the address word.
 */
export const FOLLOW_UP_WINDOW_MS = 30_000;

/**
 * Whether an utterance heard in an address-gated session was addressed to Patch,
 * and so becomes a user turn rather than being discarded (spec/07 § Session
 * modes).
 *
 * Two ways to address it: open with the address word — optionally behind a
 * greeting ("hey patch", "ok patch") and with any punctuation after it — or
 * speak inside the follow-up window that opens when Patch finishes speaking.
 * `msSinceSpoke` is undefined when it has not spoken in this session yet.
 */
export function isAddressed(
  text: string,
  addressWord: string,
  msSinceSpoke: number | undefined,
): boolean {
  if (msSinceSpoke !== undefined && msSinceSpoke <= FOLLOW_UP_WINDOW_MS) return true;
  const word = addressWord.trim().toLowerCase();
  if (word === '') return false;
  const spoken = text
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '');
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^(?:hey|hi|hello|ok|okay|yo)?\\s*${escaped}\\b`, 'u').test(spoken)) return true;
  // STT regularly mishears the address word by one consonant ("Patch" →
  // "Hatch"/"Catch"), and an exact match then drops a deliberately addressed
  // utterance — the user watches their words appear greyed and gets silence
  // (caught live by scripts/electron-ear-live.mjs, 2026-08-25). So the leading
  // word (behind the same optional greeting) also addresses the session when it
  // is within edit distance 1 of the address word. Only for address words of
  // 4+ characters, where a 1-char slip still leaves the word unmistakable.
  if (word.length < 4) return false;
  const m = /^(?:(?:hey|hi|hello|ok|okay|yo)\s+)?([\p{L}\p{N}]+)/u.exec(spoken);
  const first = m?.[1];
  if (first === undefined || Math.abs(first.length - word.length) > 1) return false;
  return editDistanceAtMost1(first, word);
}

/** True when `a` and `b` are within Levenshtein distance 1. */
function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  if (short.length === long.length) {
    let diff = 0;
    for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) diff++;
    return diff <= 1;
  }
  // Lengths differ by one: allow a single insertion.
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j++;
    }
  }
  return true;
}

/**
 * Parse a transcribed utterance as an affirmative / negative permission
 * answer (spec/07 ## Permission prompts during voice — "host parses
 * 'yes'/'no'"). Returns `true`/`false` for a clear yes/no, or `null` when the
 * utterance is neither (the session then treats it as a normal turn).
 */
export function parseYesNo(text: string): boolean | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!,?]+$/g, '');
  if (/\b(yes|yeah|yep|yup|sure|approve|approved|ok|okay|go ahead|do it|allow)\b/.test(t)) {
    return true;
  }
  if (/\b(no|nope|nah|deny|denied|don'?t|do not|cancel|stop|reject)\b/.test(t)) {
    return false;
  }
  return null;
}

// Ring-buffer capacity for the live utterance: 30s @ 16 kHz mono int16 =
// 960KB. Allocated ONCE per session (group 14, M3) so end-of-utterance no
// longer pays a fresh `Int16Array(total)` + `mergeFrames` copy inside the
// <800ms STT budget window.
const UTTERANCE_CAP_SAMPLES = 30 * 16000;
// AEC reference tail: 200ms @ 16 kHz = 3200 samples (group 14, M4).
const REF_TAIL_CAP = 3200;

// --- live (interim) transcript, spec/03 `audio.transcript_partial` ----------
// Emitted only by a backend that declares partials worth attempting
// (`WhisperBackend.supportsLivePartials`). No STT here streams; the live text
// is the growing utterance prefix re-transcribed about once a second. Two
// things make that honest rather than a fake: the backend keeps a slice of its
// per-minute quota back so the FINAL — the user's actual words — can never be
// refused by a partial, and a partial that comes back as one of Whisper's stock
// answers to near-silence is dropped rather than painted into the composer
// (`partial-filter.ts`).
/** Don't transcribe a prefix shorter than this (0.5 s @ 16 kHz). */
const PARTIAL_MIN_TOTAL_SAMPLES = 8000;
/** Minimum NEW audio between two interim transcriptions (1.0 s @ 16 kHz). */
const PARTIAL_MIN_STEP_SAMPLES = 16000;

export class VoiceSession implements VoiceSessionLike {
  private state: SessionState = 'connecting';
  private readonly init: SessionInit;
  private readonly deps: SessionDeps;
  private currentChatId: string;
  /** Pre-allocated linear buffer for the live utterance. */
  private readonly utterance: Int16Array = new Int16Array(UTTERANCE_CAP_SAMPLES);
  private utteranceLen = 0;
  private kokoroStream?: KokoroSynthesis;
  private bargedIn = false;
  private speakPromise?: Promise<void>;
  // --- streaming-TTS turn state (spec/07 § Voice reply) ---
  // While true, speak() is one sentence of a larger streamed reply: it does NOT
  // reset `bargedIn` (the turn owns that) and does NOT emit the closing
  // `audio.tts_end` / flip to 'listening' (the turn's endStream does, once).
  private streamingTurn = false;
  /**
   * Current session mode (spec/07 § Session modes). Mutable: the surface flips
   * it mid-session with `audio.mode` and nothing is torn down.
   */
  private mode: AudioSessionMode;
  /** When Patch last finished speaking, for the follow-up window. */
  private lastSpokeAt?: number;
  // --- what actually happened on this session, for the closing summary ---
  private micFrames = 0;
  private micSamples = 0;
  private vadEvents = 0;
  private turns = 0;
  /** Accumulates streamed reply text until a full sentence can be split off. */
  private speechBuffer = '';
  /** FIFO of complete, markdown-stripped sentences awaiting synthesis. */
  private speakQueue: string[] = [];
  /** The in-flight queue-drain, so endStream can await it. */
  private drainPromise?: Promise<void>;
  /** Whether ANY sentence was streamed this turn (else speak the full reply). */
  private spokeThisTurn = false;
  /**
   * Whether any TTS audio actually reached the surface this turn. A turn that
   * ends with this still false has failed its down leg — `endStream` says so
   * with an `audio.error` rather than closing on a bare `audio.tts_end`
   * (the exact silent-failure mode A1-17 caught).
   */
  private spokeAudioThisTurn = false;
  /**
   * Set when speech was deliberately SUPPRESSED (the mock backend's auto-reply,
   * which must never be spoken — it feeds back into the device's own mic). A
   * suppressed turn is silent on purpose, so it is not reported as a failure.
   */
  private suppressedThisTurn = false;
  /** Timestamps for the latency-budget telemetry. */
  private utteranceEndTs?: number;
  /**
   * AEC reference ring buffer (200ms @ 16kHz). `refWrite` is the write
   * head; `refFilled` clamps reads while we're warming up.
   */
  private readonly refRing: Int16Array = new Int16Array(REF_TAIL_CAP);
  private refWrite = 0;
  private refFilled = 0;
  /**
   * spec/07 ## Voice-input modes — mode 1 (voice note): a note is a SINGLE
   * utterance bounded by the GESTURE, not by VAD silence. "Either gesture, esc
   * cancels without sending. After send, the audio is committed as a user
   * turn." So in `voice-note` mode the STT transcript is buffered here as it
   * arrives (driving the live overlay) but is NOT turned into a chat turn until
   * the gesture-end commit (`finalizeNote`, fired by `session_end {committed}`).
   * Esc → `session_end {cancelled}` → ws.close() with NO finalize → this is
   * dropped and zero turns are submitted. Undefined until any STT lands.
   */
  private pendingNoteTranscript?: string;
  // --- live interim-transcript state (see PARTIAL_* above) ---
  /** An interim transcription is awaiting its result. */
  private partialInFlight = false;
  /** `utteranceLen` when the last interim transcription was kicked off. */
  private partialAtSamples = 0;
  /** Last partial text emitted, so an unchanged prefix isn't re-sent. */
  private lastPartialText = '';
  /** Set when interim STT failed; stops retrying for the current utterance. */
  private partialsDisabledForUtterance = false;
  // A NOTE is dictation: its live transcript covers everything said since the
  // gesture began, not just the phrase since the last pause. The buffer still
  // resets per phrase (it is capped at 30 s), so the words of each finished
  // phrase are kept here and every partial is sent as all of them plus the
  // phrase in progress.
  /** Voice note only: the text of each finished phrase, in order. */
  private notePhrases: string[] = [];
  /** Voice note only: an utterance has started, so the buffer holds a phrase. */
  private notePhraseOpen = false;
  /** Bumped at each phrase boundary; a partial from an earlier phrase is stale. */
  private phraseSeq = 0;

  /** True for mode-1 voice notes (gesture-bounded single turn). */
  private get isNote(): boolean {
    return this.init.role === 'voice-note';
  }

  constructor(init: SessionInit, deps: SessionDeps) {
    this.init = init;
    // spec/07 § Call cost — every STT request this session makes, partials
    // included, is counted on its way through.
    const whisper = deps.whisper;
    const stt = this.stt;
    const counted: WhisperBackend = Object.create(whisper) as WhisperBackend;
    counted.transcribe = async (pcm, opts) => {
      const text = await whisper.transcribe(pcm, opts);
      const seconds = pcm.length / 16000;
      stt.requests += 1;
      stt.audioSeconds += seconds;
      stt.billedSeconds += Math.max(GROQ_MIN_BILLED_SECONDS, seconds);
      return text;
    };
    this.whisper = counted;
    this.deps = deps;
    this.currentChatId = init.chatId;
    this.mode = init.mode ?? 'call';
  }

  private readonly stt: SttUsage = { requests: 0, audioSeconds: 0, billedSeconds: 0 };
  /** `deps.whisper`, counting what it is asked to transcribe. */
  private readonly whisper: WhisperBackend;

  engineCosting(): EngineCosting {
    const model = this.whisper.costModel;
    if (model === undefined) {
      return { backend: 'local', model: 'local', tokens: null, stt: null };
    }
    return { backend: 'local', model, tokens: null, stt: { ...this.stt } };
  }

  /** No fast voice on `local`: every utterance already is the agent's turn. */
  pushContext(): void {}

  isAwaitingHandoff(): boolean {
    return false;
  }

  /**
   * What the session actually did, logged when it closes. A call the user says
   * "didn't work" about is otherwise a pair of log lines with nothing between
   * them, and every cause looks identical: no mic audio, no end-of-utterance,
   * no transcript, no reply. These four numbers separate them at a glance.
   */
  private readonly micLevel = new MicLevelWatch();

  stats(): {
    micFrames: number;
    micSeconds: number;
    vadEvents: number;
    turns: number;
    micPeakDbfs: number;
  } {
    return {
      micFrames: this.micFrames,
      micSeconds: Number((this.micSamples / 16000).toFixed(1)),
      vadEvents: this.vadEvents,
      turns: this.turns,
      micPeakDbfs: this.micLevel.peakDbfs(),
    };
  }

  getMode(): AudioSessionMode {
    return this.mode;
  }

  /** spec/07 § Session modes — flip the open session's mode. */
  setMode(next: AudioSessionMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, mode: next },
      'voice-session: mode changed',
    );
  }

  getState(): SessionState {
    return this.state;
  }

  getCurrentChatId(): string {
    return this.currentChatId;
  }

  /**
   * Assign the session state AND announce the transition to the surface as an
   * `audio.state` frame so the overlay can render LISTENING → TRANSCRIBING →
   * THINKING → SPEAKING live (spec/15 § Voice states). No-op if unchanged.
   *
   * NOT emitted to `surfaceKind: 'device'` sessions — the firmware ignores
   * unknown control frames and we keep its wire byte-identical. The
   * post-speaking return-to-listening is deliberately a bare assignment (see
   * `speak`'s finally) so `audio.tts_end` stays the last frame of a turn; the
   * surface maps tts_end → listening itself.
   */
  private setState(next: SessionState): void {
    if (this.state === next) return;
    if (this.state === 'speaking') this.lastSpokeAt = Date.now();
    this.state = next;
    if (this.init.surfaceKind !== 'device') {
      this.deps.sendAudio({ type: 'audio.state', sessionId: this.init.sessionId, state: next });
    }
  }

  /**
   * Return to listening after speaking. A bare assignment rather than
   * `setState`, because `audio.tts_end` is the surface's signal that speaking
   * finished and must stay the LAST frame of the turn; it also stamps the
   * moment speech ended, which is what opens the follow-up window (spec/07
   * § Session modes).
   */
  private settleToListening(): void {
    this.lastSpokeAt = Date.now();
    this.state = 'listening';
  }

  /** Surface emitted `chat.focus_change` — re-target the next utterance. */
  setFocus(chatId: string): void {
    this.currentChatId = chatId;
    this.deps.logger.debug(
      { sessionId: this.init.sessionId, chatId },
      'voice-session: focus follow',
    );
  }

  /** First wire event after WS upgrade. Promotes to 'listening'. */
  onSessionStart(): void {
    if (this.state !== 'connecting') {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, state: this.state },
        'voice-session: duplicate session_start',
      );
      return;
    }
    this.setState('listening');
  }

  /**
   * Feed one mic PCM frame (16 kHz mono, 30 ms = 480 samples is the canonical
   * frame size). Returns nothing — side effects are state transitions and
   * outbound `audio.*` events.
   */
  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.state === 'connecting') return;
    // Enough to tell, from the log alone, whether a silent call is a surface
    // that never sent audio or a VAD that never heard the end of it. Without
    // this a dead call logs "session started" then "session ended" and nothing
    // in between, which is indistinguishable from every other cause.
    this.micFrames += 1;
    this.micSamples += pcm.length;
    // spec/07 — a mic sending only digital silence is a failure to report.
    if (this.micLevel.feed(pcm)) {
      this.deps.logger.error(
        { sessionId: this.init.sessionId },
        'voice: the microphone is sending only digital silence',
      );
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'mic_silent',
        message: micSilentMessage(this.init.surfaceKind),
        sessionId: this.init.sessionId,
      });
    }
    if (this.micFrames === 1) {
      this.deps.logger.info(
        { sessionId: this.init.sessionId, samples: pcm.length },
        'voice-session: first mic frame in',
      );
    }
    // AEC: subtract the recent TTS ref signal (only meaningful in 'speaking').
    let cleaned = pcm;
    if (this.state === 'speaking' && !this.init.surfaceHasAec) {
      const ref = this.alignRefTo(pcm.length);
      cleaned = this.deps.aec.process(pcm, ref);
    }
    // VAD on the cleaned signal.
    const result = await this.deps.vad.feed(cleaned, (cleaned.length / 16000) * 1000);
    if (result.event === 'utterance_start' || result.event === 'utterance_end') {
      this.vadEvents += 1;
      this.deps.logger.info(
        { sessionId: this.init.sessionId, event: result.event, state: this.state },
        'voice-session: vad',
      );
    }
    if (result.event === 'utterance_start') {
      if (this.state === 'speaking') {
        // Barge-in: kill TTS, drop buffered audio, go to listening.
        this.bargedIn = true;
        if (this.kokoroStream) {
          await this.kokoroStream.cancel();
          this.kokoroStream = undefined;
        }
        this.deps.sendAudio({
          type: 'audio.barge_in',
          sessionId: this.init.sessionId,
          at: Date.now(),
        });
        this.deps.sendAudio({
          type: 'audio.tts_end',
          sessionId: this.init.sessionId,
          bargedIn: true,
        });
        this.setState('listening');
      }
      if (this.isNote) {
        if (this.notePhraseOpen) this.closeNotePhrase();
        this.notePhraseOpen = true;
      }
      this.utteranceLen = 0;
      this.resetPartials();
    }
    if (this.state === 'listening' || this.state === 'speaking') {
      // Append `cleaned` into the pre-allocated utterance buffer. If the
      // utterance overflows 30s, drop the head — STT can't usefully work
      // on a half-hour utterance anyway.
      const room = this.utterance.length - this.utteranceLen;
      if (cleaned.length <= room) {
        this.utterance.set(cleaned, this.utteranceLen);
        this.utteranceLen += cleaned.length;
      } else {
        // Slide window: keep the tail.
        const keep = this.utterance.length - cleaned.length;
        if (keep > 0) {
          this.utterance.copyWithin(0, this.utteranceLen - keep, this.utteranceLen);
          this.utterance.set(cleaned, keep);
          this.utteranceLen = this.utterance.length;
        } else {
          // cleaned is itself larger than the buffer — drop oldest, keep
          // the tail of `cleaned`.
          this.utterance.set(cleaned.subarray(cleaned.length - this.utterance.length), 0);
          this.utteranceLen = this.utterance.length;
        }
      }
    }
    // Live transcript while the user is still speaking (spec/03
    // `audio.transcript_partial`). Fire-and-forget; never blocks the mic path.
    if (this.state === 'listening' && result.event !== 'utterance_end') {
      // Per-backend: a partial costs a whole extra transcription request, so
      // only a backend that can absorb that offers one (spec/07 § Live
      // transcript).
      if (this.whisper.supportsLivePartials) this.maybeTranscribePartial();
    }
    if (result.event === 'utterance_end' && this.utteranceLen > 0) {
      this.utteranceEndTs = Date.now();
      // spec/07 mode 1: a voice NOTE never commits on VAD silence — the gesture
      // (release / ⏎) is the end-of-utterance signal. Keep the captured audio
      // buffered so `finalizeNote` (gesture commit) transcribes the whole note;
      // a VAD pause mid-note must NOT fire an SDK turn. Voice CALLS commit each
      // utterance on VAD-end as before (conversational turn-taking).
      if (this.isNote) return;
      await this.runTurn();
    }
  }

  /**
   * A note's phrase has ended (the next one is starting). Keep what the user
   * has already seen of it, then re-read the whole phrase once so its words
   * settle on the full audio rather than the last prefix pass.
   */
  private closeNotePhrase(): void {
    const idx = this.notePhrases.length;
    this.notePhrases.push(this.lastPartialText);
    this.phraseSeq += 1;
    if (!this.whisper.supportsLivePartials) return;
    if (this.utteranceLen < PARTIAL_MIN_TOTAL_SAMPLES) return;
    const pcm = this.utterance.slice(0, this.utteranceLen);
    void this.whisper
      .transcribe(pcm, { priority: 'partial' })
      .then((text) => {
        const t = text.trim();
        if (this.state !== 'listening') return;
        if (t.length === 0 || isStockHallucination(t) || t === this.notePhrases[idx]) return;
        this.notePhrases[idx] = t;
        this.sendPartial(this.lastPartialText);
      })
      .catch((err: Error) => {
        // The phrase keeps the text its last prefix pass produced; only the
        // settling re-read is lost.
        if (err.name === 'PartialBudgetExhaustedError') return;
        this.deps.logger.error(
          { sessionId: this.init.sessionId, err: err.message },
          'voice-session: re-reading a finished note phrase failed; keeping its last partial',
        );
      });
  }

  /** Emit the live transcript — for a note, every finished phrase plus this one. */
  private sendPartial(current: string): void {
    const text = this.isNote
      ? [...this.notePhrases, current].filter((p) => p.length > 0).join(' ')
      : current;
    if (text.length === 0) return;
    this.deps.sendAudio({
      type: 'audio.transcript_partial',
      sessionId: this.init.sessionId,
      text,
    });
  }

  /** Clear interim-transcript bookkeeping at an utterance boundary. */
  private resetPartials(): void {
    this.partialAtSamples = 0;
    this.lastPartialText = '';
    this.partialsDisabledForUtterance = false;
  }

  /**
   * Transcribe the utterance captured SO FAR and emit it as
   * `audio.transcript_partial`, so the overlay shows the speaker's words live
   * (spec/03 § Audio session, spec/07 § the live transcript). Rate-limited to
   * one in flight and one per ~1 s of new audio.
   *
   * NOT sent to a `surfaceKind: 'device'` session — the firmware's wire is kept
   * byte-identical (same rule as `audio.state`), and a speaker has no overlay
   * to paint.
   */
  private maybeTranscribePartial(): void {
    if (this.init.surfaceKind === 'device') return;
    if (this.partialInFlight || this.partialsDisabledForUtterance) return;
    if (this.utteranceLen < PARTIAL_MIN_TOTAL_SAMPLES) return;
    // First partial goes as soon as there is enough audio to transcribe at all;
    // later ones wait for a meaningful amount of NEW speech.
    if (
      this.partialAtSamples > 0 &&
      this.utteranceLen - this.partialAtSamples < PARTIAL_MIN_STEP_SAMPLES
    ) {
      return;
    }
    this.partialAtSamples = this.utteranceLen;
    // COPY: the ring is reused (and reset by runTurn) while this await is out.
    const prefix = this.utterance.slice(0, this.utteranceLen);
    const seq = this.phraseSeq;
    this.partialInFlight = true;
    void this.whisper
      .transcribe(prefix, { priority: 'partial' })
      .then((text) => {
        const t = text.trim();
        // Stale: the utterance already ended (the final transcript owns the
        // display now) or a barge-in/new utterance reset the buffer.
        if (this.state !== 'listening' || this.utteranceLen === 0) return;
        // A later phrase has begun; this one's words are kept by closeNotePhrase.
        if (seq !== this.phraseSeq) return;
        if (t.length === 0 || t === this.lastPartialText) return;
        // Whisper answers a short or near-silent prefix with a stock phrase
        // ("Thank you.", "you", subtitle credits). Painting one into the user's
        // composer reads as words they said, so it is dropped and the next pass
        // gets the chance instead. NEVER applied to the final in `runTurn` —
        // that is what the user actually said, whatever it is.
        if (isStockHallucination(t)) {
          this.deps.logger.debug(
            { sessionId: this.init.sessionId, text: t },
            'voice-session: dropped a stock-hallucination partial',
          );
          return;
        }
        this.lastPartialText = t;
        this.sendPartial(t);
      })
      .catch((err: Error) => {
        // An interim transcription is an EXTRA read of audio the committed
        // path will read again; failing it must not fail the utterance. Either
        // way partials stop for this utterance rather than retrying every
        // second. The committed `transcribe` in `runTurn` reports a genuinely
        // broken STT backend to the surface as `audio.error
        // {whisper_unavailable}`.
        this.partialsDisabledForUtterance = true;
        if (err.name === 'PartialBudgetExhaustedError') {
          // Not a fault: the backend deliberately kept provider quota in
          // reserve for the final. The live overlay stops updating; the turn
          // itself is unaffected, which is the whole point of the reserve.
          this.deps.logger.debug(
            { sessionId: this.init.sessionId },
            'voice-session: partials paused to keep STT quota for the final',
          );
          return;
        }
        this.deps.logger.error(
          { sessionId: this.init.sessionId, err: err.message },
          'voice-session: interim transcript failed; partials off for this utterance',
        );
      })
      .finally(() => {
        this.partialInFlight = false;
      });
  }

  /**
   * Kokoro-emitted PCM is sent to the surface AND retained in `refTail`
   * so AEC can subtract it from incoming mic frames. Only relevant when
   * `surfaceHasAec === false`.
   */
  private retainRef(pcm16: Int16Array): void {
    if (this.init.surfaceHasAec) return;
    // `pcm16` is already 16 kHz (resampled in speak() before send), matching
    // the 16 kHz mic stream the AEC subtracts it from.
    const cap = this.refRing.length;
    let w = this.refWrite;
    for (let i = 0; i < pcm16.length; i++) {
      this.refRing[w] = pcm16[i]!;
      w = (w + 1) % cap;
    }
    this.refWrite = w;
    this.refFilled = Math.min(cap, this.refFilled + pcm16.length);
  }

  /**
   * Build a contiguous `len`-sample view of the most-recent reference
   * audio. We pre-allocate a scratch buffer the first time `len` exceeds
   * the prior request — typical mic frames are 480 samples so this
   * stabilises on one allocation.
   */
  private refScratch: Int16Array = new Int16Array(0);
  private alignRefTo(len: number): Int16Array {
    if (this.refScratch.length < len) this.refScratch = new Int16Array(len);
    const out = this.refScratch.subarray(0, len);
    const cap = this.refRing.length;
    if (this.refFilled === 0) {
      out.fill(0);
      return out;
    }
    // Most-recent `min(len, refFilled)` samples; pad the head with zeros.
    const avail = Math.min(len, this.refFilled);
    const padHead = len - avail;
    if (padHead > 0) out.subarray(0, padHead).fill(0);
    // The newest sample is at refRing[(refWrite - 1 + cap) % cap]. We want
    // the last `avail` samples in chronological order ending there.
    let readStart = (this.refWrite - avail + cap) % cap;
    if (readStart + avail <= cap) {
      out.set(this.refRing.subarray(readStart, readStart + avail), padHead);
    } else {
      const head = cap - readStart;
      out.set(this.refRing.subarray(readStart, cap), padHead);
      out.set(this.refRing.subarray(0, avail - head), padHead + head);
    }
    return out;
  }

  /**
   * Voice-note gesture end (spec/07 ## Voice-input modes — mode 1). A voice
   * note is a SINGLE explicit utterance bounded by the gesture: press-and-hold
   * release (or ⏎ in toggle mode) IS the end-of-utterance signal, not VAD
   * silence. The surface emits `audio.session_end { reason: 'committed' }`; the
   * audio server calls this BEFORE closing so the buffered audio is transcribed
   * and committed as exactly one user turn.
   *
   * No-op when a turn is mid-flight — so a note commits EXACTLY one turn, never
   * two. When a transcript was already produced (the dev inject seam, or a
   * streaming-STT final), commit THAT text. Otherwise transcribes whatever mic
   * audio was buffered over the whole gesture: `processTranscript`'s
   * empty-transcript guard drops a genuinely-silent capture (Groq/local return
   * '') without an SDK turn, so a stray gesture isn't a spurious turn, while a
   * real capture (even one only flushed in the final mic frame) is never lost.
   * Returns true iff a turn was run.
   */
  async finalizeNote(): Promise<boolean> {
    if (this.state === 'connecting') return false;
    // A turn is already running / mid-flight for this gesture — don't stack a
    // second one.
    if (this.state === 'transcribing' || this.state === 'thinking') return false;
    if (this.committedOnce) return false;
    this.committedOnce = true;
    // Prefer a transcript already captured (dev inject seam / streaming final)
    // over re-transcribing buffered PCM.
    const pending = this.pendingNoteTranscript;
    if (pending !== undefined) {
      this.pendingNoteTranscript = undefined;
      this.utteranceEndTs = Date.now();
      await this.processTranscript(pending, undefined);
      return true;
    }
    if (this.utteranceLen === 0) return false;
    await this.runTurn();
    return true;
  }

  /** True once a turn has been committed in this session (voice-note guard). */
  private committedOnce = false;

  /**
   * Finalise utterance → STT → SDK → TTS → speaker.
   * Public ONLY for testing; production code drives this through onMicFrame.
   */
  async runTurn(): Promise<void> {
    this.committedOnce = true;
    this.setState('transcribing');
    // Zero-copy view into the pre-allocated utterance ring (group 14, M3).
    // Whisper backends consume synchronously — Groq builds a WAV body
    // (also zero-copy now, see whisper.ts pcm16ToWav) and the local
    // sidecar copies into a Buffer for the WS send. So sharing the view
    // is safe; no allocation needed for the merge.
    const merged = this.utterance.subarray(0, this.utteranceLen);
    this.utteranceLen = 0;
    this.resetPartials();
    let transcript: string;
    const sttStarted = Date.now();
    this.deps.logger.info(
      { sessionId: this.init.sessionId, samples: merged.length },
      'voice-session: transcribing the committed utterance',
    );
    try {
      transcript = await this.whisper.transcribe(merged, { priority: 'final' });
      this.deps.logger.info(
        {
          sessionId: this.init.sessionId,
          ms: Date.now() - sttStarted,
          chars: transcript.length,
        },
        'voice-session: transcribed',
      );
    } catch (err) {
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'voice-session: STT failed',
      );
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'whisper_unavailable',
        message: (err as Error).message,
        sessionId: this.init.sessionId,
      });
      this.setState('listening');
      return;
    }
    const sttLatency =
      this.utteranceEndTs !== undefined ? Date.now() - this.utteranceEndTs : undefined;
    await this.processTranscript(transcript, sttLatency);
  }

  /**
   * Inject a transcribed utterance into this session as if the host's STT
   * pipeline had produced it on end-of-utterance (DEV/TEST seam, spec/07).
   * Routes to the session's CURRENT focus chat — so it proves focus-follow
   * re-routing — and otherwise behaves exactly like a real utterance: spoken
   * yes/no resolves a pending permission, anything else drives a real SDK turn
   * whose reply streams back as TTS. No-op if the session is not yet listening.
   */
  async injectTranscript(text: string): Promise<void> {
    if (this.state === 'connecting') return;
    // Barge-in (spec/07): an utterance arriving while the agent is mid-TTS means
    // the user spoke over it. Cut the Kokoro stream, drop buffered audio, and
    // signal the surface to flip to listening — exactly the VAD-start branch in
    // onMicFrame, but driven by the (post-STT) inject seam where there is no
    // live VAD on the mock mic. THEN process the new utterance.
    if (this.state === 'speaking') {
      this.bargedIn = true;
      if (this.kokoroStream) {
        await this.kokoroStream.cancel();
        this.kokoroStream = undefined;
      }
      this.deps.sendAudio({
        type: 'audio.barge_in',
        sessionId: this.init.sessionId,
        at: Date.now(),
      });
      this.deps.sendAudio({
        type: 'audio.tts_end',
        sessionId: this.init.sessionId,
        bargedIn: true,
      });
      this.setState('listening');
    }
    // Stream the utterance as growing `audio.transcript_partial` frames before
    // the final — exactly the per-word ticker the real streaming-Whisper path
    // emits (whisper.ts ## partial streaming, spec/07 "live STT transcript …
    // updates as the user speaks"). On the mock stack STT produces no partials,
    // so this seam reconstructs them by revealing the injected text word-by-word
    // so the surface's italic transcript region visibly updates as words arrive,
    // not just a single end-of-utterance jump.
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length > 0) {
      this.setState('transcribing');
      let acc = '';
      for (const word of words) {
        acc = acc.length === 0 ? word : `${acc} ${word}`;
        this.deps.sendAudio({
          type: 'audio.transcript_partial',
          sessionId: this.init.sessionId,
          text: acc,
        });
        // Brief inter-word delay so the surface paints each partial — fast
        // enough to feel live, slow enough to be observably incremental.
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    // spec/07 mode 1: a voice NOTE is gesture-bounded — the live transcript
    // above feeds the overlay, but the turn is NOT committed until the gesture
    // end (⏎ / release → `finalizeNote`). Stash the transcript so the commit
    // can use it; Esc-cancel closes the session WITHOUT finalize, so nothing is
    // ever submitted. Committing here would let a captured-then-cancelled note
    // still fire a turn (the G5-d3 stray-turn bug). Voice calls / devices
    // commit each injected utterance immediately (conversational).
    if (this.isNote) {
      this.pendingNoteTranscript = text;
      this.setState('listening');
      return;
    }
    await this.processTranscript(text, undefined);
  }

  /**
   * Shared post-STT turn handling: emit the final transcript, then either
   * resolve a pending permission (spoken yes/no, spec/07 ## Permission prompts
   * during voice) or drive a normal SDK turn whose reply is spoken via Kokoro.
   */
  private async processTranscript(
    transcript: string,
    sttLatency: number | undefined,
  ): Promise<void> {
    // spec/07 § Session modes — `waiting` and `working` hear everything the mic
    // picks up and act on almost none of it. Unaddressed speech is reported to
    // the surface as heard-but-not-sent (so the user can see the mic is alive
    // and see why nothing happened) and then dropped here: it never reaches a
    // chat, which is what makes an open headset mic safe in a room with other
    // people in it.
    const addressed =
      !modeRequiresAddress(this.mode) ||
      transcript.length === 0 ||
      isAddressed(
        transcript,
        this.init.addressWord ?? DEFAULT_ADDRESS_WORD,
        this.lastSpokeAt === undefined ? undefined : Date.now() - this.lastSpokeAt,
      );
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.init.sessionId,
      text: transcript,
      ...(sttLatency !== undefined ? { sttLatencyMs: sttLatency } : {}),
      ...(addressed ? {} : { addressed: false }),
    });
    if (transcript.length === 0) {
      this.setState('listening');
      return;
    }
    if (!addressed) {
      this.deps.logger.debug(
        { sessionId: this.init.sessionId },
        'voice-session: unaddressed utterance dropped',
      );
      this.setState('listening');
      return;
    }
    // Spec/07 ## Permission prompts during voice: when the focused chat is
    // awaiting a permission, a spoken "yes"/"no" resolves it via the STT path
    // — it is NOT forwarded as a new user-turn. An ambiguous utterance falls
    // through to a normal turn (the banner stays up; the user can retry / tap).
    const pendingRequestId = this.deps.getPendingPermission?.(this.currentChatId);
    if (pendingRequestId !== undefined && this.deps.resolvePermission) {
      const answer = parseYesNo(transcript);
      if (answer !== null) {
        this.deps.logger.info(
          { sessionId: this.init.sessionId, chatId: this.currentChatId, approve: answer },
          'voice-session: spoken permission answer',
        );
        this.deps.resolvePermission(pendingRequestId, answer);
        this.setState('listening');
        return;
      }
    }
    this.turns += 1;
    this.setState('thinking');
    // A physical voice device produces a `voice-device` source carrying its
    // deviceId — this is what tags the Speakers turn `[voice • device:<id>]`
    // and drives the daemon-enforced TTS auto-route back to that device
    // (spec/06 ## Reply routing). App surfaces (web/desktop/mobile) produce a
    // `voice-app` source tagged with their surfaceKind instead.
    const source: VoiceTurnSource =
      this.init.surfaceKind === 'device' && this.init.deviceId !== undefined
        ? { kind: 'voice-device', deviceId: this.init.deviceId }
        : {
            kind: 'voice-app',
            surfaceKind: this.init.surfaceKind as 'web' | 'desktop' | 'mobile',
            sessionId: this.init.sessionId,
          };
    // Stream the reply: sentences are synthesised + spoken AS the model
    // generates (spec/07 — first sentence speaks while later tokens arrive),
    // instead of waiting for the whole turn to finish. `onReplyText` feeds
    // incremental text in; endStream flushes the tail + fires the closing
    // tts_end. Barge-in still works — onMicFrame checks `state === 'speaking'`
    // (set by the first sentence's speak()) and cancels the live kokoroStream.
    this.beginStream();
    let reply: string;
    try {
      reply = await this.deps.submitUserTurn({
        chatId: this.currentChatId,
        message: transcript,
        source,
        onReplyText: (chunk) => this.onStreamText(chunk),
      });
    } catch (err) {
      const e = err as Error;
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: e.message, name: e.name },
        'voice-session: SDK turn failed',
      );
      // Sanitised: surface the error name + a fixed prefix, NOT the raw
      // message (which can leak internal state — folder paths, prompt
      // bytes, etc).
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'sdk_error',
        message: `turn failed: ${e.name || 'Error'}`,
        sessionId: this.init.sessionId,
      });
      this.streamingTurn = false;
      this.setState('listening');
      return;
    }
    // Finish speaking in the background so subsequent mic frames (barge-in) are
    // processed concurrently. endStream drains the queue + speaks the fallback
    // when nothing streamed.
    this.speakPromise = this.endStream(reply).catch((err: Error) => {
      this.streamingTurn = false;
      this.deps.logger.error({ err: err.message }, 'voice-session: speak failed');
    });
  }

  /** Wait for any in-flight TTS to drain (test helper). */
  async waitForSpeakDone(): Promise<void> {
    if (this.speakPromise) await this.speakPromise;
  }

  /** Public so the permission-prompt path can also drive Kokoro. */
  async speak(text: string): Promise<void> {
    // The mock backend's auto-reply is "[mock] echo: <prompt>" — for a hands-free
    // button-press with no spoken words the prompt is empty, so the user hears
    // nothing. Replace it with a fixed, full test sentence so a bare button press
    // in mock mode plays clean speech the user can judge by ear (no diag-speak
    // needed, so no overlapping second stream).
    // Mock backend auto-replies "[mock] echo: …" on every turn. NEVER speak it:
    // auto-speaking on a session creates a feedback loop (TTS the device's own
    // mic hears → wakeword → new session → speaks again). Suppress entirely;
    // audio tests are driven explicitly via diag-speak (__WAV__/__SINE__).
    if (text.startsWith('[mock]')) {
      this.suppressedThisTurn = true;
      this.setState('listening');
      return;
    }
    // DIAG: '__SINE__' sends a pure 48 kHz sine straight down the device WS path
    // (no Kokoro, no resample) so we can ear-test the WS→stream-buffer→feeder path
    // in isolation. Clean here ⇒ transport is fine; noisy ⇒ the WS path corrupts.
    if (text === '__SINE__' && this.init.surfaceKind === 'device') {
      this.state = 'speaking';
      const N = 48000 * 2; // 2 s @ 48 kHz
      const sine = new Int16Array(N);
      // A 200 Hz→4 kHz logarithmic SWEEP (chirp), not a pure tone. A periodic sine
      // hides sample drop/dup/reorder (a repeated cycle still sounds like the tone);
      // a sweep is non-repeating, so ANY feeder ordering/timing glitch becomes an
      // audible click/discontinuity in an otherwise smooth glide. Clean sweep ⇒ the
      // WS→buffer→feeder path is fine and the noise is in Kokoro's speech content;
      // clicky sweep ⇒ the feeder corrupts sample ordering/timing.
      // TWO simultaneous tones (440 + 660 Hz), each amplitude 6000, summed → peak
      // ~12000. A single tone (or a sweep = one freq at a time) cannot reveal
      // INTERMODULATION distortion; two tones through a nonlinearity produce sum/
      // difference products (220 Hz, 1100 Hz, …) heard as roughness/dirt. Clean ⇒
      // the path is linear and the speech noise is something else; rough ⇒ a
      // nonlinearity in the path is the "tracks-the-speech" distortion.
      // GATED tone: 440 Hz on for 150 ms, silent for 100 ms, repeating — mimics
      // speech's word/silence envelope. Continuous tones are clean; if THIS
      // crackles at the on/off edges, the fault is how the path handles
      // silence→audio transitions (amp toggling, feeder re-prime, or a DC step),
      // NOT level or frequency content.
      // Two WELL-SEPARATED tones (300 + 3300 Hz), each 6000. A nonlinearity makes
      // very audible intermodulation products (sum 3600, diff 3000, etc.). Clearly
      // rough/dirty ⇒ nonlinearity confirmed; clean two clear notes ⇒ linear.
      for (let i = 0; i < N; i++) {
        const a = Math.sin((2 * Math.PI * 300 * i) / 48000) * 6000;
        const b = Math.sin((2 * Math.PI * 3300 * i) / 48000) * 6000;
        sine[i] = Math.round(a + b);
      }
      const FRAME = 1920;
      for (let i = 0; i < N; i += FRAME) {
        this.deps.sendBinary(sine.subarray(i, Math.min(i + FRAME, N)));
        if (((i / FRAME) & 7) === 7) await new Promise((r) => setTimeout(r, 0));
      }
      this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
      this.settleToListening();
      return;
    }
    // DIAG: '__WAV__' plays a KNOWN-CLEAN human-speech recording (hey_jarvis.wav,
    // 24 kHz mono — same rate Kokoro emits) through the EXACT same host path as
    // TTS (resampleTtsTo48k → WS → device). A/B vs Kokoro: clean here ⇒ Kokoro's
    // output is the noise; noisy here ⇒ the path mangles real speech (transients/
    // silence gaps) and Kokoro is not to blame.
    if (text === '__WAV__' && this.init.surfaceKind === 'device') {
      this.state = 'speaking';
      const fs = await import('fs');
      const buf = fs.readFileSync('.tmp/f1-prov/hey_jarvis.wav');
      // Skip the 44-byte WAV header; the rest is 24 kHz mono PCM16 LE.
      const pcm24 = new Int16Array(buf.byteLength >>> 1);
      for (let i = 0; i < pcm24.length; i++) pcm24[i] = buf.readInt16LE(i * 2);
      const speech24 = pcm24.subarray(22); // 44 bytes / 2 = 22 samples of header
      const out48 = resampleTtsTo48k(speech24);
      const FRAME = 1920;
      for (let i = 0; i < out48.length; i += FRAME) {
        this.deps.sendBinary(out48.subarray(i, Math.min(i + FRAME, out48.length)));
        if (((i / FRAME) & 7) === 7) await new Promise((r) => setTimeout(r, 0));
      }
      this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
      this.settleToListening();
      return;
    }
    this.setState('speaking');
    // A streamed turn owns `bargedIn` for its whole span (set once in
    // beginStream); a single-shot speak() resets it here.
    if (!this.streamingTurn) this.bargedIn = false;
    const ttsStart = Date.now();
    let stream: KokoroSynthesis;
    try {
      stream = await this.deps.kokoro.synthesize(text, this.deps.getKokoroVoice?.());
    } catch (err) {
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'kokoro_unavailable',
        message: (err as Error).message,
        sessionId: this.init.sessionId,
      });
      // Single-shot: settle to listening here. Streamed: let endStream finalise
      // (it still fires one tts_end / 'listening' for the whole turn).
      if (!this.streamingTurn) this.setState('listening');
      return;
    }
    this.kokoroStream = stream;
    let firstFrameLatency: number | undefined;
    // Count what actually left for the surface. A synthesis that yields no
    // audio at all is a FAILURE, not a quiet success — it must never be
    // reported as a clean `audio.tts_end` with nothing before it.
    let framesSent = 0;
    const isDevice = this.init.surfaceKind === 'device';
    // The physical voice DEVICE's speaker bus is clocked at 48 kHz, so it must be
    // fed 48 kHz PCM. We collect the whole Kokoro utterance (24 kHz) and resample
    // it ONCE, cleanly, to 48 kHz after synthesis — a single full-utterance
    // resample avoids the per-chunk FIR boundary clicks a streaming resample
    // would add, and replaces the old lossy 24→16 (host) + crude 16→48 (device)
    // chain that produced harsh imaging. Web/mobile decode native 24 kHz.
    const device24Chunks: Int16Array[] = [];
    try {
      for await (const chunk of stream.iterator) {
        if (this.bargedIn) break;
        if (chunk.first) {
          firstFrameLatency = Date.now() - ttsStart;
        }
        // AEC reference is always 16 kHz (the mic stream is 16 kHz).
        this.retainRef(decimate24kTo16k(chunk.pcm));
        if (isDevice) {
          device24Chunks.push(chunk.pcm);
          continue;
        }
        this.deps.sendAudio({
          type: 'audio.tts_chunk',
          sessionId: this.init.sessionId,
          samples: chunk.pcm.length,
          ...(firstFrameLatency !== undefined && chunk.first
            ? { firstFrameLatencyMs: firstFrameLatency }
            : {}),
        });
        this.deps.sendBinary(chunk.pcm);
        framesSent++;
      }
      if (isDevice && !this.bargedIn && device24Chunks.length > 0) {
        let total = 0;
        for (const c of device24Chunks) total += c.length;
        const all24 = new Int16Array(total);
        let off = 0;
        for (const c of device24Chunks) {
          all24.set(c, off);
          off += c.length;
        }
        const out48 = resampleTtsTo48k(all24);
        // Peak-normalize quiet Kokoro utterances UP to a safe ceiling (-0.4 dBFS)
        // so replies are consistently audible. Only ever boosts (g>1), never
        // attenuates, and clamps — so it can't clip. NOTE: the old ×0.5 cut that
        // lived here was a now-DISPROVEN "analog overdrive" test; the real cause
        // of the noise was the device's I2S TX clock declared at 16 kHz on the
        // 48 kHz speaker bus (fixed in firmware 2026-06-22). No level cut needed.
        {
          let pk = 0;
          for (let i = 0; i < out48.length; i++) {
            const a = Math.abs(out48[i]!);
            if (a > pk) pk = a;
          }
          if (pk > 0) {
            const g = (0.955 * 32767) / pk;
            if (g > 1) {
              for (let i = 0; i < out48.length; i++) {
                const v = (out48[i]! * g) | 0;
                // The clamp arms below are unreachable: `pk` is the max of
                // `|out48[i]|` over every sample (measured just above), so for
                // ALL i, `|out48[i]| <= pk`, hence `|v| = |out48[i]| * g <=
                // pk * g === 0.955 * 32767 < 32767`. No sample can ever
                // exceed the ceiling this loop boosts everything toward.
                out48[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; /* v8 ignore next */
              }
            }
          }
        }
        this.deps.sendAudio({
          type: 'audio.tts_chunk',
          sessionId: this.init.sessionId,
          samples: out48.length,
          ...(firstFrameLatency !== undefined ? { firstFrameLatencyMs: firstFrameLatency } : {}),
        });
        // Send 1920-sample frames as fast as the device accepts them — NO
        // real-time pacing. The device now has a proper jitter buffer + feeder
        // task and backpressures (its stream-buffer write blocks when full →
        // backpressures this WS via TCP), so bursting simply fills its cushion.
        // Real-time pacing kept that cushion empty → the feeder hit starved/
        // partial frames → "windy" gaps. A 0 ms yield every 8 frames keeps the
        // event loop responsive without throttling delivery.
        const FRAME = 1920;
        for (let i = 0; i < out48.length; i += FRAME) {
          if (this.bargedIn) break;
          this.deps.sendBinary(out48.subarray(i, Math.min(i + FRAME, out48.length)));
          framesSent++;
          if (((i / FRAME) & 7) === 7) await new Promise((r) => setTimeout(r, 0));
        }
      }
      // Kokoro accepted the text and then produced nothing. Silence here is
      // indistinguishable to the user from "the agent didn't answer", so say
      // so on the wire instead of closing the turn with a bare tts_end.
      if (framesSent === 0 && !this.bargedIn) {
        const message = `TTS produced no audio for ${text.length} chars of reply text`;
        this.deps.logger.error({ sessionId: this.init.sessionId, chars: text.length }, message);
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'kokoro_unavailable',
          message,
          sessionId: this.init.sessionId,
        });
      } else if (framesSent > 0) {
        this.spokeAudioThisTurn = true;
      }
    } finally {
      this.kokoroStream = undefined;
      // A streamed sentence is NOT the end of the turn — the turn's endStream
      // fires the single closing tts_end / 'listening' once all sentences drain.
      // Only a single-shot speak() finalises here.
      if (!this.streamingTurn) {
        if (!this.bargedIn) {
          this.deps.sendAudio({
            type: 'audio.tts_end',
            sessionId: this.init.sessionId,
          });
        }
        // Bare assignment (NOT setState): `audio.tts_end` above is the surface's
        // signal that speaking finished, and it must be the LAST frame of the
        // turn (surfaces map tts_end → listening). Emitting an audio.state here
        // would trail tts_end and muddy that contract.
        this.settleToListening();
      }
    }
  }

  // --- streaming-TTS turn (spec/07 § Voice reply) -------------------------
  // A voice reply is spoken sentence-by-sentence AS the model generates it: the
  // host feeds reply text in via `onStreamText`, complete sentences are split
  // off, markdown-stripped, and synthesised in order while later text is still
  // arriving. `endStream` flushes the trailing partial and fires the single
  // closing tts_end. If the backend never streamed (no `onStreamText`), the
  // caller speaks the full reply as a fallback.

  private beginStream(): void {
    this.streamingTurn = true;
    this.bargedIn = false;
    this.speechBuffer = '';
    this.speakQueue = [];
    this.drainPromise = undefined;
    this.spokeThisTurn = false;
    this.spokeAudioThisTurn = false;
    this.suppressedThisTurn = false;
  }

  /** Feed a chunk of streamed reply text; speak whole sentences as they form. */
  onStreamText(chunk: string): void {
    if (!this.streamingTurn || this.bargedIn) return;
    this.speechBuffer += chunk;
    const { sentences, rest } = extractSentences(this.speechBuffer);
    this.speechBuffer = rest;
    for (const s of sentences) this.enqueueSpeech(s);
  }

  private enqueueSpeech(sentence: string): void {
    const spoken = stripMarkdownForSpeech(sentence);
    if (!spoken) return;
    this.speakQueue.push(spoken);
    if (!this.drainPromise) this.drainPromise = this.drainSpeech();
  }

  /** Serially synthesise queued sentences so they play in order, once each. */
  private async drainSpeech(): Promise<void> {
    try {
      while (this.speakQueue.length > 0 && !this.bargedIn) {
        const next = this.speakQueue.shift()!;
        this.spokeThisTurn = true;
        await this.speak(next);
      }
    } finally {
      this.drainPromise = undefined;
    }
  }

  /**
   * Finish a streamed turn: flush the trailing partial sentence, wait for the
   * queue to drain, fall back to the full reply if nothing streamed, then fire
   * the single closing tts_end and return to listening. The finalise runs in a
   * `finally` so a mid-stream synth throw still closes the turn cleanly (one
   * tts_end, back to 'listening') rather than stranding the state on 'speaking'.
   */
  private async endStream(fullReply: string): Promise<void> {
    try {
      const tail = this.speechBuffer.trim();
      this.speechBuffer = '';
      if (tail && !this.bargedIn) this.enqueueSpeech(tail);
      // Drain whatever is queued (enqueueSpeech may have (re)started it). Errors
      // are already surfaced per-sentence (audio.error); don't let them abort
      // the turn's finalise below.
      while (this.drainPromise) {
        try {
          await this.drainPromise;
        } catch {
          /* per-sentence synth failure — finalise anyway */
        }
      }
      // A backend that never streamed deltas leaves nothing spoken — speak the
      // whole reply now so the user still hears the answer.
      if (!this.spokeThisTurn && !this.bargedIn) {
        const spoken = stripMarkdownForSpeech(fullReply);
        if (spoken) {
          this.spokeThisTurn = true;
          await this.speak(spoken);
        }
      }
    } finally {
      // Close the turn: one tts_end for the whole reply (unless a barge-in
      // already sent its own), then 'listening'. Mirrors single-shot speak().
      this.streamingTurn = false;
      // NO SILENT FAILURES (CLAUDE.md): a turn that reached here without a
      // barge-in, without deliberate suppression, and without a single PCM
      // frame going out has lost its reply somewhere between the chat pipeline
      // and Kokoro. Say so on the wire — a bare `tts_end` with nothing before
      // it is indistinguishable from a working session that had nothing to say.
      if (!this.bargedIn && !this.spokeAudioThisTurn && !this.suppressedThisTurn) {
        const message =
          fullReply.trim().length === 0
            ? 'voice turn produced no assistant reply text — nothing to speak'
            : 'voice turn produced reply text but no TTS audio reached the surface';
        this.deps.logger.error(
          { sessionId: this.init.sessionId, replyChars: fullReply.length },
          message,
        );
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'sdk_error',
          message,
          sessionId: this.init.sessionId,
        });
      }
      if (!this.bargedIn) {
        this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
      }
      this.settleToListening();
    }
  }

  async close(): Promise<void> {
    if (this.kokoroStream) {
      await this.kokoroStream.cancel();
      this.kokoroStream = undefined;
    }
  }
}

// --- helpers --------------------------------------------------------------

/**
 * 24kHz → 16kHz with a small low-pass pre-filter (group 14, M5).
 *
 * The previous version was a naive 3:2 sample drop which aliases content
 * above 8kHz back into the audible band, polluting the AEC reference.
 * We now apply a 4-tap simple averaging LPF (a low-cost approximation of
 * a polyphase LPF — coefficients [1,2,2,1]/6, near-zero at the Nyquist
 * boundary) before dropping every 3rd sample. The output sample-count
 * matches the previous implementation's so callers don't need updating.
 *
 * Limitation: this is a shallow LPF; group 23 may swap in a proper
 * polyphase resampler if the AEC convergence shows residual aliased
 * artefacts on real voice-device audio.
 */
function decimate24kTo16k(pcm: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor((pcm.length * 2) / 3));
  let j = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (i % 3 === 2) continue;
    // 4-tap symmetric LPF [1, 2, 2, 1] / 6; clip indices to handle the
    // first three samples without per-sample undefined checks.
    const a = i >= 2 ? pcm[i - 2]! : 0;
    const b = i >= 1 ? pcm[i - 1]! : 0;
    const c = pcm[i]!;
    const d = i + 1 < pcm.length ? pcm[i + 1]! : 0;
    const filtered = (a + 2 * b + 2 * c + d) / 6;
    out[j++] = Math.round(filtered);
  }
  return out.subarray(0, j);
}

/**
 * 24 kHz → 48 kHz clean 2x upsampler for the physical voice DEVICE.
 *
 * The HA Voice PE speaker I2S bus is clocked at 48 kHz (the ESP TX is a slave),
 * so the device must be fed 48 kHz PCM. We do ONE clean resample here (full DSP
 * on the host) instead of the old lossy chain (24→16 with aliasing on the
 * host, then a crude 16→48 linear upsample on the device that left harsh
 * imaging "static"). Method: zero-stuff (insert a zero between samples) then a
 * 63-tap linear-phase windowed-sinc (Kaiser β=8, cutoff 11 kHz) low-pass, gain
 * x2 to compensate the zero-stuffing. Validated against scipy resample_poly:
 * <1% energy above 12 kHz (no imaging), whisper transcribes the output exactly.
 */
const FIR_24_48: readonly number[] = [
  0.00002924, -0.00008088, -0.00017301, 0.0001855, 0.00054244, -0.00022845, -0.00126532, 0.0,
  0.00242328, 0.00084601, -0.00396519, -0.00277322, 0.00560817, 0.00629355, -0.00674963,
  -0.01185055, 0.00641098, 0.01967628, -0.00321507, -0.02965774, -0.00464804, 0.04125492,
  0.01962257, -0.05350607, -0.04564495, 0.06513599, 0.09159268, -0.07475539, -0.18929228,
  0.08111193, 0.62873119, 0.91668213, 0.62873119, 0.08111193, -0.18929228, -0.07475539, 0.09159268,
  0.06513599, -0.04564495, -0.05350607, 0.01962257, 0.04125492, -0.00464804, -0.02965774,
  -0.00321507, 0.01967628, 0.00641098, -0.01185055, -0.00674963, 0.00629355, 0.00560817,
  -0.00277322, -0.00396519, 0.00084601, 0.00242328, 0.0, -0.00126532, -0.00022845, 0.00054244,
  0.0001855, -0.00017301, -0.00008088, 0.00002924,
];

export function resampleTtsTo48k(pcm24: Int16Array): Int16Array {
  const N = pcm24.length;
  const M = N * 2; // 2x upsample
  const T = FIR_24_48.length; // 63
  const half = (T - 1) >> 1; // 31
  const out = new Int16Array(M);
  // Linear-phase symmetric FIR convolution over the zero-stuffed signal. The
  // zero-stuffed sample at index i is pcm24[i/2] when i is even, else 0 — so we
  // only sum the even-index (non-zero) contributions.
  for (let i = 0; i < M; i++) {
    let acc = 0;
    // out[i] = sum_j upsampled[i + half - j] * h[j]; upsampled[idx] nonzero iff idx even.
    for (let j = 0; j < T; j++) {
      const idx = i + half - j;
      if (idx < 0 || idx >= M || (idx & 1) !== 0) continue;
      acc += pcm24[idx >> 1]! * FIR_24_48[j]!;
    }
    out[i] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
  }
  return out;
}
