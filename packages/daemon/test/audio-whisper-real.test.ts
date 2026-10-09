// Real faster-whisper sidecar end-to-end test (group E1).
//
// Boots the host's LocalWhisperBackend, which spawns the actual
// `patch_whisper_sidecar` (uv run), loads ./models/whisper/medium.en, and
// transcribes a real speech clip fed over the host's PersistentWsClient.
// We assert a real, non-empty, sensible transcript — no audio is played.
//
// Gated on the model + uv being present (the build pipeline provides both).

import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import pino from 'pino';
import { createWhisper } from '../src/audio/whisper.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MODEL = join(REPO_ROOT, 'models', 'whisper', 'medium.en');
const SIDECAR_CWD = join(REPO_ROOT, 'packages', 'whisper-sidecar');
const SPEECH_WAV = join(REPO_ROOT, 'models', 'kokoro', 'samples', 'af_heart_0.wav');

function uvAvailable(): boolean {
  try {
    execSync('command -v uv', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function loadWav16k(path: string): Int16Array {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = len;
      break;
    }
    off += 8 + len;
  }
  const samples = new Int16Array(buf.buffer, buf.byteOffset + dataOff, dataLen >> 1);
  if (sr === 16000) return Int16Array.from(samples);
  const ratio = 16000 / sr;
  const outLen = Math.round(samples.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = x - i0;
    out[i] = Math.round(samples[i0]! * (1 - t) + samples[i1]! * t);
  }
  return out;
}

const canRun =
  existsSync(MODEL) && existsSync(SIDECAR_CWD) && existsSync(SPEECH_WAV) && uvAvailable();

describe.runIf(canRun)('real faster-whisper sidecar (spawned by the host)', () => {
  test('transcribes a real speech clip to non-empty text', async () => {
    const logger = pino({ level: 'silent' });
    const whisper = createWhisper({
      backend: 'local',
      logger,
      localModelPath: MODEL,
      localSidecarCwd: SIDECAR_CWD,
    });
    try {
      const pcm = loadWav16k(SPEECH_WAV);
      const transcript = await whisper.transcribe(pcm);
      expect(typeof transcript).toBe('string');
      expect(transcript.trim().length).toBeGreaterThan(0);
      // The af_heart sample says the Gibson "sky above the port…" line; assert
      // a content word survives transcription rather than pinning exact text.
      expect(transcript.toLowerCase()).toContain('sky');
    } finally {
      await whisper.close();
    }
  }, 180_000);
});
