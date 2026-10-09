// Real Kokoro sidecar end-to-end test (group E1).
//
// Boots the host's RealKokoroBackend, which spawns the actual
// `patch_kokoro_sidecar` Python process (uv run), loads ./models/kokoro, and
// streams 24 kHz PCM16 back through the host's PersistentWsClient. We assert
// real, non-silent audio frames arrive and that the request terminates cleanly
// — NO audio is ever played; we inspect PCM sample values only.
//
// Gated on the model + uv being present (the build pipeline provides both).
// Slow: the model load + synthesis runs the real torch pipeline.

import { describe, test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import pino from 'pino';
import { createKokoro } from '../src/audio/kokoro.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MODEL = join(REPO_ROOT, 'models', 'kokoro');
const SIDECAR_CWD = join(REPO_ROOT, 'packages', 'kokoro-sidecar');

function uvAvailable(): boolean {
  try {
    execSync('command -v uv', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const canRun = existsSync(MODEL) && existsSync(SIDECAR_CWD) && uvAvailable();

describe.runIf(canRun)('real Kokoro sidecar (spawned by the host)', () => {
  test('streams non-silent 24 kHz PCM16 frames and ends cleanly', async () => {
    const logger = pino({ level: 'silent' });
    const kokoro = createKokoro({
      backend: 'real',
      logger,
      modelPath: MODEL,
      sidecarCwd: SIDECAR_CWD,
    });

    try {
      const synth = await kokoro.synthesize('Hello from patch.');
      let frameCount = 0;
      let totalSamples = 0;
      let sumSq = 0;
      let peak = 0;
      let sawFirst = false;
      for await (const chunk of synth.iterator) {
        if (chunk.first) sawFirst = true;
        frameCount++;
        totalSamples += chunk.pcm.length;
        for (let i = 0; i < chunk.pcm.length; i++) {
          const v = chunk.pcm[i]!;
          sumSq += v * v;
          if (Math.abs(v) > peak) peak = Math.abs(v);
        }
      }
      const rms = Math.sqrt(sumSq / Math.max(1, totalSamples));

      expect(frameCount).toBeGreaterThan(0);
      expect(sawFirst).toBe(true);
      // Real synthesised speech (~1.7 s) — far more than a single mock frame.
      expect(totalSamples).toBeGreaterThan(24000); // > 1 s @ 24 kHz
      expect(rms).toBeGreaterThan(50); // non-silent
      expect(peak).toBeGreaterThan(1000);
    } finally {
      await kokoro.close();
    }
  }, 180_000);
});
