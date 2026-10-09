// Silero-shaped VAD wrapper test (group 13). We exercise MockVad — the
// shape and state-machine semantics are what matters for the orchestrator;
// the real onnxruntime path is integration-tested with a fixture clip in
// the docker-compose.test stack.

import { describe, test, expect } from 'vitest';
import { MockVad } from '../src/audio/vad.js';

function silentFrame(): Int16Array {
  return new Int16Array(480); // zeros
}

function speechFrame(amp = 8000): Int16Array {
  const f = new Int16Array(480);
  for (let i = 0; i < f.length; i++) {
    f[i] = Math.round(amp * Math.sin((i / 480) * Math.PI * 4));
  }
  return f;
}

describe('MockVad', () => {
  test('detects utterance_start on a speech frame', async () => {
    const vad = new MockVad();
    const r = await vad.feed(speechFrame(), 30);
    expect(r.event).toBe('utterance_start');
    expect(r.state).toBe('speech');
  });

  test('declares utterance_end after silenceHangoverMs of silence', async () => {
    const vad = new MockVad({ silenceHangoverMs: 60 });
    expect((await vad.feed(speechFrame(), 30)).state).toBe('speech');
    // First silent frame: still in speech (hangover not yet reached).
    expect((await vad.feed(silentFrame(), 30)).event).toBe(null);
    // Second silent frame: total 60 ms ≥ 60 → end.
    expect((await vad.feed(silentFrame(), 30)).event).toBe('utterance_end');
  });

  test('a loud frame sustained mid-speech resets the silence-hangover accumulator', async () => {
    const vad = new MockVad({ silenceHangoverMs: 60 });
    expect((await vad.feed(speechFrame(), 30)).state).toBe('speech');
    // One silent frame accrues hangover time…
    expect((await vad.feed(silentFrame(), 30)).event).toBe(null);
    // …but a loud frame arriving before the hangover completes resets the
    // accumulator back to 0 (no premature end).
    expect((await vad.feed(speechFrame(), 30)).event).toBe(null);
    // So a SINGLE subsequent silent frame is not enough to end the utterance —
    // the hangover clock restarted from the loud frame above.
    expect((await vad.feed(silentFrame(), 30)).event).toBe(null);
  });

  test('reset returns state to silence', async () => {
    const vad = new MockVad();
    await vad.feed(speechFrame(), 30);
    vad.reset();
    // A subsequent silent frame still classifies as silence (no spurious end).
    expect((await vad.feed(silentFrame(), 30)).event).toBe(null);
  });

  test('close() resolves cleanly (nothing to clean up)', async () => {
    const vad = new MockVad();
    await expect(vad.close()).resolves.toBeUndefined();
  });
});
