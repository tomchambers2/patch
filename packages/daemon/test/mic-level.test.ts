// spec/07 — a microphone that sends nothing but digital silence is a failure
// the user must be told about, not a quiet room.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { MicLevelWatch, micSilentMessage } from '../src/audio/micLevel.js';
import { GeminiLiveSession } from '../src/audio/gemini-live.js';
import type { AudioEvent } from '@patch/wire/audio';
import type { WebSocket as WsSocket } from 'ws';
import { EventEmitter } from 'node:events';

const second = (fill = 0): Int16Array => new Int16Array(16000).fill(fill);

describe('MicLevelWatch', () => {
  it('flags 5s of pure digital silence, once', () => {
    const w = new MicLevelWatch();
    const fired: boolean[] = [];
    for (let i = 0; i < 7; i++) fired.push(w.feed(second(0)));
    expect(fired).toEqual([false, false, false, false, true, false, false]);
  });

  it('never flags a microphone that carried any sound, however quiet', () => {
    const w = new MicLevelWatch();
    const quiet = second(0);
    quiet[100] = 40; // about -58 dBFS: a very quiet room, but a working mic
    const fired = [w.feed(quiet), ...Array.from({ length: 6 }, () => w.feed(second(0)))];
    expect(fired.every((f) => !f)).toBe(true);
  });

  it('reports the loudest sample in dBFS, and -Infinity for silence', () => {
    const w = new MicLevelWatch();
    expect(w.peakDbfs()).toBe(-Infinity);
    const s = second(0);
    s[5] = 16384;
    w.feed(s);
    expect(w.peakDbfs()).toBeCloseTo(-6.02, 1);
  });
});

class FakeWs extends EventEmitter {
  sent: string[] = [];
  send(d: string): void {
    this.sent.push(d);
    if ((JSON.parse(d) as { setup?: unknown }).setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
}

describe('a call whose microphone sends silence', () => {
  it('Gemini: tells the surface, naming the likely cause', async () => {
    const events: AudioEvent[] = [];
    const s = new GeminiLiveSession(
      {
        sessionId: 's',
        accountId: 'a',
        surfaceId: 'f',
        surfaceKind: 'desktop',
        chatId: 'c',
        role: 'voice-call',
        surfaceHasAec: true,
      },
      {
        logger: pino({ level: 'silent' }),
        sendAudio: (e) => events.push(e),
        sendBinary: () => {},
        submitUserTurn: async () => '',
        timeline: { userSaid: () => {}, beginReply: () => ({ append() {}, finish() {} }) },
        apiKey: 'k',
        wsCtor: function () {
          const ws = new FakeWs();
          queueMicrotask(() => ws.emit('open'));
          return ws;
        } as unknown as new (url: string) => WsSocket,
      },
    );
    s.onSessionStart();
    await vi.waitFor(() => expect(s.getState()).toBe('listening'));
    for (let i = 0; i < 6; i++) await s.onMicFrame(second(0));
    const errs = events.filter((e) => e.type === 'audio.error');
    expect(errs).toEqual([
      expect.objectContaining({ code: 'mic_silent', message: micSilentMessage('desktop') }),
    ]);
    expect(s.stats()).toEqual(expect.objectContaining({ micPeakDbfs: -Infinity }));
  });
});

describe('the silent-mic message', () => {
  it('names the fix for the device in hand', () => {
    expect(micSilentMessage('desktop')).toContain('Privacy & Security → Microphone');
    expect(micSilentMessage('mobile')).toContain('Android Settings → Apps → Patch → Permissions');
    expect(micSilentMessage('mobile')).not.toContain('Mac');
  });
});
