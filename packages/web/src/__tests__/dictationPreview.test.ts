// The live-preview leg of composer dictation. It exists only to paint interim
// words; the clip and the final transcript go over HTTP and owe it nothing. So
// what these pin is the separation: one microphone, frames buffered until the
// socket is up, the session never committed, and a broken preview REPORTED
// rather than passed off as "no partials arrived".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startDictationPreview, type OpenSession } from '../lib/dictationPreview.js';
import type { AudioSession, AudioSessionCallbacks } from '../lib/audioSession.js';

function fakeSession(over: Partial<AudioSession> = {}): AudioSession {
  return {
    sessionId: 'sess-1',
    chatId: 'chat1',
    setMuted: () => {},
    isMuted: () => false,
    setSessionMode: () => {},
    speak: () => {},
    sendPcm: () => {},
    end: () => {},
    ...over,
  };
}

/** An opener whose resolution the test controls, capturing what it was asked for. */
function deferredOpener(): {
  open: OpenSession;
  opts: () => Parameters<OpenSession>[0];
  resolve: (s: AudioSession) => void;
  reject: (e: Error) => void;
} {
  let seen: Parameters<OpenSession>[0] | null = null;
  let res!: (s: AudioSession) => void;
  let rej!: (e: Error) => void;
  const promise = new Promise<AudioSession>((ok, fail) => {
    res = ok;
    rej = fail;
  });
  const open = ((o: Parameters<OpenSession>[0]) => {
    seen = o;
    return promise;
  }) as OpenSession;
  return { open, opts: () => seen!, resolve: res, reject: rej };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('dictation preview', () => {
  it('opens the session without a microphone of its own', async () => {
    const d = deferredOpener();
    startDictationPreview('chat1', { onPartial: () => {}, onPreviewError: () => {} }, d.open);
    await Promise.resolve();
    expect(d.opts().withMic).toBe(false);
    // Nor an output device: it plays nothing, so it must not wake the speakers.
    expect(d.opts().silent).toBe(true);
    expect(d.opts().chatId).toBe('chat1');
    expect(d.opts().role).toBe('voice-note');
  });

  it('buffers frames captured before the socket is up, then flushes them in order', async () => {
    const d = deferredOpener();
    const sent: number[] = [];
    const preview = startDictationPreview(
      'chat1',
      { onPartial: () => {}, onPreviewError: () => {} },
      d.open,
    );
    preview.push(Int16Array.from([1]));
    preview.push(Int16Array.from([2]));
    expect(sent).toEqual([]);
    d.resolve(fakeSession({ sendPcm: (pcm) => sent.push(pcm[0]!) }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1, 2]);
    // And subsequent frames go straight through.
    preview.push(Int16Array.from([3]));
    expect(sent).toEqual([1, 2, 3]);
  });

  it('forwards partials while it is open and stops the moment it is closed', async () => {
    const d = deferredOpener();
    const seen: string[] = [];
    const preview = startDictationPreview(
      'chat1',
      { onPartial: (t) => seen.push(t), onPreviewError: () => {} },
      d.open,
    );
    d.resolve(fakeSession());
    await Promise.resolve();
    await Promise.resolve();
    const cbs = d.opts().callbacks as AudioSessionCallbacks;
    cbs.onTranscriptPartial('buy oat');
    cbs.onTranscriptPartial('buy oat milk');
    preview.stop();
    // A partial that arrives after the gesture ended must not repaint a preview
    // the composer has already replaced with the real transcript.
    cbs.onTranscriptPartial('buy oat milk and');
    expect(seen).toEqual(['buy oat', 'buy oat milk']);
  });

  it('never commits the session — closing it must not fire an agent turn', async () => {
    const d = deferredOpener();
    const reasons: (string | undefined)[] = [];
    const preview = startDictationPreview(
      'chat1',
      { onPartial: () => {}, onPreviewError: () => {} },
      d.open,
    );
    d.resolve(fakeSession({ end: (reason?: string) => reasons.push(reason) }));
    await Promise.resolve();
    await Promise.resolve();
    preview.stop();
    expect(reasons).toEqual(['cancelled']);
    // Idempotent: a second stop does not re-end it.
    preview.stop();
    expect(reasons).toEqual(['cancelled']);
  });

  it('closes a session that only opened after the gesture already ended', async () => {
    const d = deferredOpener();
    const reasons: (string | undefined)[] = [];
    const preview = startDictationPreview(
      'chat1',
      { onPartial: () => {}, onPreviewError: () => {} },
      d.open,
    );
    preview.stop();
    d.resolve(fakeSession({ end: (reason?: string) => reasons.push(reason) }));
    await Promise.resolve();
    await Promise.resolve();
    expect(reasons).toEqual(['cancelled']);
  });

  it('reports a failure to open rather than going quietly dark', async () => {
    const d = deferredOpener();
    const errors: string[] = [];
    startDictationPreview(
      'chat1',
      { onPartial: () => {}, onPreviewError: (m) => errors.push(m) },
      d.open,
    );
    d.reject(new Error('audio WSS failed to open'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual(['audio WSS failed to open']);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reports a session error raised after it opened', async () => {
    const d = deferredOpener();
    const errors: string[] = [];
    startDictationPreview(
      'chat1',
      { onPartial: () => {}, onPreviewError: (m) => errors.push(m) },
      d.open,
    );
    d.resolve(fakeSession());
    await Promise.resolve();
    await Promise.resolve();
    (d.opts().callbacks as AudioSessionCallbacks).onError('whisper_unavailable: no key');
    expect(errors).toEqual(['whisper_unavailable: no key']);
  });
});
