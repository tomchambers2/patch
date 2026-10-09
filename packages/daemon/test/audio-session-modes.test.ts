// spec/07 § Session modes — `hands-free` hears everything and acts on almost
// nothing. Covers the address rule itself and the gate it drives: an
// unaddressed utterance is reported to the surface as heard-but-not-sent and
// never becomes a chat turn, while an addressed one behaves exactly as it does
// on a plain call.

import { describe, test, expect } from 'vitest';
import pino from 'pino';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import type { AecProcessor } from '../src/audio/aec.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import type { KokoroBackend, KokoroSynthesis } from '../src/audio/kokoro.js';
import {
  VoiceSession,
  isAddressed,
  FOLLOW_UP_WINDOW_MS,
  type SessionDeps,
  type SessionInit,
  type VoiceTurnSource,
} from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';

const logger = pino({ level: 'silent' });

class SilentVad implements Vad {
  async feed(): Promise<VadFrameResult> {
    return { prob: 0, event: null, state: 'silence' };
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

const whisper: WhisperBackend = {
  async transcribe() {
    return '';
  },
  async close() {},
};

const kokoro: KokoroBackend = {
  isReady: () => true,
  async close() {},
  async synthesize(): Promise<KokoroSynthesis> {
    async function* gen() {
      yield { pcm: new Int16Array(240), first: true };
    }
    return { iterator: gen(), async cancel() {} };
  },
};

function makeSession(init: Partial<SessionInit> = {}): {
  session: VoiceSession;
  audio: AudioEvent[];
  submitted: string[];
} {
  const audio: AudioEvent[] = [];
  const submitted: string[] = [];
  const deps: SessionDeps = {
    vad: new SilentVad(),
    aec: new StubAec(),
    whisper,
    kokoro,
    logger,
    sendAudio: (ev) => audio.push(ev),
    sendBinary: () => {},
    submitUserTurn: async ({ message }: { message: string; source: VoiceTurnSource }) => {
      submitted.push(message);
      return 'ok';
    },
  };
  const session = new VoiceSession(
    {
      sessionId: 'sess1',
      accountId: 'acct1',
      surfaceId: 'surf1',
      surfaceKind: 'web',
      chatId: 'chat1',
      role: 'voice-call',
      surfaceHasAec: true,
      ...init,
    },
    deps,
  );
  // Leaves 'connecting' — injectTranscript is a no-op before the session starts.
  session.onSessionStart();
  audio.length = 0;
  return { session, audio, submitted };
}

function finals(audio: AudioEvent[]): Extract<AudioEvent, { type: 'audio.transcript_final' }>[] {
  return audio.filter(
    (e): e is Extract<AudioEvent, { type: 'audio.transcript_final' }> =>
      e.type === 'audio.transcript_final',
  );
}

describe('isAddressed', () => {
  test('opening with the address word addresses it, with or without a greeting', () => {
    for (const utterance of [
      'patch what is agent two doing',
      'Patch, what is agent two doing',
      'hey patch stop the bus chat',
      'OK Patch — carry on',
    ]) {
      expect(isAddressed(utterance, 'patch', undefined)).toBe(true);
    }
  });

  test('the address word elsewhere in the sentence does not address it', () => {
    expect(isAddressed('I need to patch the wall first', 'patch', undefined)).toBe(false);
    expect(isAddressed('can you pass me the patches', 'patch', undefined)).toBe(false);
  });

  test('a one-consonant STT mishearing of the address word still addresses it', () => {
    // Whisper regularly hears "Patch" as "Hatch"/"Catch" — the exact-match
    // gate then dropped a deliberately addressed utterance (caught live by
    // scripts/electron-ear-live.mjs, 2026-08-25).
    for (const utterance of [
      'Hatch, say the word banana back to me',
      'catch say the word banana back to me',
      'hey batch what is running',
    ]) {
      expect(isAddressed(utterance, 'patch', undefined)).toBe(true);
    }
  });

  test('fuzzy matching does not over-reach', () => {
    // Two edits away, or the near-word later in the sentence: still dropped.
    expect(isAddressed('thatch the roof next', 'patch', undefined)).toBe(false);
    expect(isAddressed('dispatch the riders', 'patch', undefined)).toBe(false);
    expect(isAddressed('we should catch up later', 'patch', undefined)).toBe(false);
    // Short address words get no fuzz — one edit would make them anything.
    expect(isAddressed('cat what is running', 'pat', undefined)).toBe(false);
  });

  test('a custom address word is honoured, and the default one then is not', () => {
    expect(isAddressed('jarvis what is running', 'jarvis', undefined)).toBe(true);
    expect(isAddressed('patch what is running', 'jarvis', undefined)).toBe(false);
  });

  test('anything inside the follow-up window is addressed', () => {
    expect(isAddressed('yes go ahead', 'patch', 1_000)).toBe(true);
    expect(isAddressed('yes go ahead', 'patch', FOLLOW_UP_WINDOW_MS)).toBe(true);
    expect(isAddressed('yes go ahead', 'patch', FOLLOW_UP_WINDOW_MS + 1)).toBe(false);
  });
});

describe('address-gated modes', () => {
  test('an unaddressed utterance is reported as not sent and never becomes a turn', async () => {
    const { session, audio, submitted } = makeSession({ mode: 'hands-free' });
    await session.injectTranscript('so then I said we should render the whole wall');
    expect(submitted).toEqual([]);
    expect(finals(audio)).toEqual([
      expect.objectContaining({ text: expect.any(String), addressed: false }),
    ]);
  });

  test('an addressed utterance becomes a turn', async () => {
    const { session, submitted, audio } = makeSession({ mode: 'hands-free' });
    await session.injectTranscript('patch what is agent two doing');
    expect(submitted).toEqual(['patch what is agent two doing']);
    expect(finals(audio)[0]?.addressed).toBeUndefined();
  });

  test('the address word is the account setting, not a hard-coded one', async () => {
    const { session, submitted } = makeSession({ mode: 'hands-free', addressWord: 'jarvis' });
    await session.injectTranscript('jarvis carry on');
    expect(submitted).toEqual(['jarvis carry on']);
  });

  test('switching to a plain call mid-session takes every utterance', async () => {
    const { session, submitted } = makeSession({ mode: 'hands-free' });
    await session.injectTranscript('nothing to do with patch at all');
    expect(submitted).toEqual([]);
    session.setMode('call');
    expect(session.getMode()).toBe('call');
    await session.injectTranscript('nothing to do with it at all');
    expect(submitted).toEqual(['nothing to do with it at all']);
  });

  test('a plain call takes an unaddressed utterance, which is the whole difference', async () => {
    const { session, submitted, audio } = makeSession({ mode: 'call' });
    await session.injectTranscript('so then I said we should render the whole wall');
    expect(submitted).toEqual(['so then I said we should render the whole wall']);
    expect(finals(audio)[0]?.addressed).toBeUndefined();
  });

  test('a session defaults to a plain call when no mode is given', () => {
    const { session } = makeSession();
    expect(session.getMode()).toBe('call');
  });
});
