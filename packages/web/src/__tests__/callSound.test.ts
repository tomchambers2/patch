import { describe, it, expect, vi, afterEach } from 'vitest';
import { playCallSound } from '../lib/callSound.js';

function fakeAudio() {
  const oscillators: Array<{ frequency: { value: number }; start: ReturnType<typeof vi.fn> }> = [];
  const close = vi.fn(async () => undefined);
  class FakeCtx {
    currentTime = 0;
    destination = {};
    createGain() {
      return {
        gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: (n: unknown) => n,
      };
    }
    createOscillator() {
      const o = {
        type: '',
        frequency: { value: 0 },
        connect: (n: unknown) => n,
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(o);
      return o;
    }
    close = close;
  }
  return { FakeCtx, oscillators, close };
}

describe('call sounds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('pick-up rises, hang-up falls, and the context is released afterwards', () => {
    vi.useFakeTimers();
    const a = fakeAudio();
    vi.stubGlobal('AudioContext', a.FakeCtx);
    playCallSound('pickup');
    playCallSound('hangup');
    expect(a.oscillators.map((o) => o.frequency.value)).toEqual([660, 880, 880, 523]);
    expect(a.oscillators.every((o) => o.start.mock.calls.length === 1)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(a.close).toHaveBeenCalledTimes(2);
  });

  it('says so, loudly, when the browser cannot play a sound', () => {
    vi.stubGlobal('AudioContext', undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    playCallSound('pickup');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('no AudioContext'));
    err.mockRestore();
  });
});
