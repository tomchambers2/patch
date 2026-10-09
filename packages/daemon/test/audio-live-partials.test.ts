// The live transcript: the host re-transcribes the growing utterance prefix
// and paints the result into the surface's composer while the user is still
// speaking. Two things have to hold for that to be worth having rather than a
// fake — the FINAL is never sacrificed to it, and Whisper's stock answers to
// near-silence never reach the user's input.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import type { AecProcessor } from '../src/audio/aec.js';
import {
  createWhisper,
  PartialBudgetExhaustedError,
  type WhisperBackend,
} from '../src/audio/whisper.js';
import type { KokoroBackend, KokoroSynthesis } from '../src/audio/kokoro.js';
import { VoiceSession, type SessionDeps } from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';

const logger = pino({ level: 'silent' });

describe('which backends offer a live transcript', () => {
  test('Groq does — a fresh request per prefix, paid for out of a reserved slice of its quota', () => {
    expect(createWhisper({ backend: 'groq', logger, groqApiKey: 'k' }).supportsLivePartials).toBe(
      true,
    );
  });

  test('a model on this machine does — one pass in flight at a time, so the final waits behind at most one', () => {
    expect(
      createWhisper({ backend: 'local', logger, localSidecarUrl: 'ws://127.0.0.1:1' })
        .supportsLivePartials,
    ).toBe(true);
  });

  test('an unconfigured host has nothing to ask, and the mock has nothing worth showing', () => {
    expect(createWhisper({ backend: 'off', logger }).supportsLivePartials).toBe(false);
    expect(createWhisper({ backend: 'mock', logger }).supportsLivePartials).toBe(false);
  });
});

class OneUtteranceVad implements Vad {
  private first = true;
  async feed(): Promise<VadFrameResult> {
    if (this.first) {
      this.first = false;
      return { prob: 0.9, event: 'utterance_start', state: 'speech' };
    }
    return { prob: 0.9, event: null, state: 'speech' };
  }
  reset(): void {}
  async close(): Promise<void> {}
}

/** VAD that opens an utterance and closes it on the Nth frame. */
class ScriptedVad implements Vad {
  private i = 0;
  constructor(private readonly script: VadFrameResult['event'][]) {}
  async feed(): Promise<VadFrameResult> {
    const event = this.script[this.i++] ?? null;
    return {
      prob: 0.9,
      event,
      state: event === 'utterance_end' ? 'silence' : 'speech',
    };
  }
  reset(): void {}
  async close(): Promise<void> {}
}

class StubAec implements AecProcessor {
  process(mic: Int16Array): Int16Array {
    return mic;
  }
  reset(): void {}
}

const kokoro: KokoroBackend = {
  isReady: () => true,
  async close() {},
  async synthesize(): Promise<KokoroSynthesis> {
    async function* gen(): AsyncGenerator<{ pcm: Int16Array; first: boolean }> {
      yield { pcm: new Int16Array(240), first: true };
    }
    return { iterator: gen(), async cancel() {} };
  },
};

function backendReturning(
  transcribe: (pcm: Int16Array, opts?: { priority?: 'final' | 'partial' }) => Promise<string>,
  supportsLivePartials = true,
): WhisperBackend {
  return {
    supportsLivePartials,
    transcribe,
    async transcribeClip() {
      return '';
    },
    async close() {},
  };
}

function makeSession(args: {
  whisper: WhisperBackend;
  vad: Vad;
  audio: AudioEvent[];
  onSubmit?: (message: string) => void;
  /** A note only commits on the gesture; a call commits on VAD silence. */
  role?: 'voice-note' | 'voice-call';
}): VoiceSession {
  const deps: SessionDeps = {
    vad: args.vad,
    aec: new StubAec(),
    whisper: args.whisper,
    kokoro,
    logger,
    sendAudio: (ev) => args.audio.push(ev),
    sendBinary: () => {},
    submitUserTurn: async ({ message }: { message: string }) => {
      args.onSubmit?.(message);
      return 'ok';
    },
  };
  return new VoiceSession(
    {
      sessionId: 'sess-live',
      accountId: 'acct1',
      surfaceId: 'surf1',
      surfaceKind: 'web',
      chatId: 'chat1',
      role: args.role ?? 'voice-note',
      surfaceHasAec: true,
    },
    deps,
  );
}

/** 0.5s @ 16 kHz — the minimum prefix the session will transcribe. */
const HALF_SECOND = 8000;
/** 1s @ 16 kHz — the minimum NEW audio between two passes. */
const ONE_SECOND = 16000;

function partials(audio: AudioEvent[]): string[] {
  return audio
    .filter((e) => e.type === 'audio.transcript_partial')
    .map((e) => (e as { text: string }).text);
}

/** Let the fire-and-forget partial settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('the live transcript paints as the user speaks', () => {
  test('a backend that offers partials gets them; the text grows with the utterance', async () => {
    const audio: AudioEvent[] = [];
    let call = 0;
    const session = makeSession({
      whisper: backendReturning(async () => {
        call += 1;
        return call === 1 ? 'add milk' : 'add milk to the shopping list';
      }),
      vad: new OneUtteranceVad(),
      audio,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    expect(partials(audio)).toEqual(['add milk', 'add milk to the shopping list']);
  });

  test('a backend that does not offer them is never asked', async () => {
    const audio: AudioEvent[] = [];
    const transcribe = vi.fn(async () => 'never shown');
    const session = makeSession({
      whisper: backendReturning(transcribe, false),
      vad: new OneUtteranceVad(),
      audio,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    expect(partials(audio)).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("Whisper's stock answer to near-silence never reaches the composer", () => {
  test('a hallucinated partial is dropped, and the next real one still lands', async () => {
    const audio: AudioEvent[] = [];
    const answers = ['Thank you.', 'you', 'book the car in for a service'];
    let i = 0;
    const session = makeSession({
      whisper: backendReturning(async () => answers[i++] ?? ''),
      vad: new OneUtteranceVad(),
      audio,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    expect(partials(audio)).toEqual(['book the car in for a service']);
  });

  test('the FINAL is not filtered — a note that really is "Thank you." still becomes the turn', async () => {
    const audio: AudioEvent[] = [];
    const submitted: string[] = [];
    const session = makeSession({
      // Every pass, partial or final, comes back as the stock phrase.
      whisper: backendReturning(async () => 'Thank you.'),
      vad: new ScriptedVad(['utterance_start', 'utterance_end']),
      audio,
      onSubmit: (m) => submitted.push(m),
      role: 'voice-call',
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.waitForSpeakDone();
    // Nothing was previewed…
    expect(partials(audio)).toEqual([]);
    // …but the user's actual words went through untouched.
    expect(audio.some((e) => e.type === 'audio.transcript_final')).toBe(true);
    expect(submitted).toEqual(['Thank you.']);
  });
});

describe('the final is protected from the live transcript', () => {
  test('an exhausted partial budget stops partials and leaves the turn untouched', async () => {
    const audio: AudioEvent[] = [];
    const submitted: string[] = [];
    const priorities: (string | undefined)[] = [];
    const session = makeSession({
      whisper: backendReturning(async (_pcm, opts) => {
        priorities.push(opts?.priority);
        if (opts?.priority === 'partial') {
          throw new PartialBudgetExhaustedError('partial skipped: 12/20 used this minute');
        }
        return 'what I actually said';
      }),
      vad: new ScriptedVad(['utterance_start', null, null, 'utterance_end']),
      audio,
      onSubmit: (m) => submitted.push(m),
      role: 'voice-call',
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.waitForSpeakDone();

    expect(partials(audio)).toEqual([]);
    // The refusal is not a session error — nothing is reported to the surface.
    expect(audio.some((e) => e.type === 'audio.error')).toBe(false);
    // Partials stop asking for the rest of the utterance rather than retrying
    // every second, so exactly one was attempted before the final.
    expect(priorities.filter((p) => p === 'partial')).toHaveLength(1);
    expect(submitted).toEqual(['what I actually said']);
  });

  test('a partial that errors for any other reason also stops, and the final still runs', async () => {
    const audio: AudioEvent[] = [];
    const submitted: string[] = [];
    const session = makeSession({
      whisper: backendReturning(async (_pcm, opts) => {
        if (opts?.priority === 'partial') throw new Error('groq whisper 500: upstream');
        return 'the turn survives';
      }),
      vad: new ScriptedVad(['utterance_start', null, null, 'utterance_end']),
      audio,
      onSubmit: (m) => submitted.push(m),
      role: 'voice-call',
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.waitForSpeakDone();
    expect(partials(audio)).toEqual([]);
    expect(submitted).toEqual(['the turn survives']);
  });
});

describe('a dictated note keeps every phrase in its live transcript', () => {
  // start → (pass) → end → start → (pass): two phrases separated by a pause.
  const TWO_PHRASES: VadFrameResult['event'][] = [
    'utterance_start',
    'utterance_end',
    'utterance_start',
  ];

  test('the second phrase is added to the first, not painted over it', async () => {
    const audio: AudioEvent[] = [];
    const answers = ['add milk', 'add oat milk', 'and bread'];
    let i = 0;
    const session = makeSession({
      whisper: backendReturning(async () => answers[i++] ?? ''),
      vad: new ScriptedVad(TWO_PHRASES),
      audio,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND)); // phrase 1 → 'add milk'
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND)); // pause
    await session.onMicFrame(new Int16Array(HALF_SECOND)); // phrase 2 begins
    await settle();
    // Phrase 1 is re-read on the full audio ('add oat milk') and phrase 2's
    // pass follows it; every frame carries both.
    expect(partials(audio)).toEqual(['add milk', 'add oat milk', 'add oat milk and bread']);
  });

  test('a phrase whose re-read fails keeps the words already shown', async () => {
    const audio: AudioEvent[] = [];
    let i = 0;
    const session = makeSession({
      whisper: backendReturning(async () => {
        i += 1;
        if (i === 2) throw new Error('groq whisper 500');
        return i === 1 ? 'add milk' : 'and bread';
      }),
      vad: new ScriptedVad(TWO_PHRASES),
      audio,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    expect(partials(audio)).toEqual(['add milk', 'add milk and bread']);
  });

  test('a pass for the previous phrase that lands after the pause is not shown as the new one', async () => {
    const audio: AudioEvent[] = [];
    let releaseFirst: ((t: string) => void) | undefined;
    let i = 0;
    const session = makeSession({
      whisper: backendReturning((_pcm, opts) => {
        i += 1;
        if (i === 1) return new Promise((r) => (releaseFirst = r));
        return Promise.resolve(opts?.priority === 'partial' && i === 2 ? 'add milk' : 'and bread');
      }),
      vad: new ScriptedVad(TWO_PHRASES),
      audio,
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND)); // pass 1 hangs
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.onMicFrame(new Int16Array(HALF_SECOND)); // re-read → 'add milk'
    await settle();
    releaseFirst!('stale words');
    await settle();
    expect(partials(audio)).not.toContain('stale words');
    expect(partials(audio).at(-1)).toBe('add milk');
  });

  test('a call still shows only the utterance in progress — each one is its own turn', async () => {
    const audio: AudioEvent[] = [];
    const answers = ['first', 'first final', 'second'];
    let i = 0;
    const session = makeSession({
      whisper: backendReturning(async () => answers[i++] ?? ''),
      vad: new ScriptedVad(TWO_PHRASES),
      audio,
      role: 'voice-call',
    });
    session.onSessionStart();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    await session.onMicFrame(new Int16Array(ONE_SECOND));
    await session.waitForSpeakDone();
    await session.onMicFrame(new Int16Array(HALF_SECOND));
    await settle();
    expect(partials(audio)).toEqual(['first', 'second']);
  });
});
