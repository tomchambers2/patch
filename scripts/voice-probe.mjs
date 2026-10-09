// End-to-end probe of the live voice path, with no human and no microphone.
//
// The voice pipeline could only ever be tested by someone speaking into a
// phone, which is why it shipped broken twice: every automated test mocked one
// of the three legs. This drives the REAL one on the REAL host —
// mic PCM in, Whisper, the agent turn, Kokoro, TTS PCM out — and reports what
// each leg cost.
//
// The "microphone" is Kokoro speaking the prompt: real synthesised speech,
// resampled 24k → 16k, streamed in as mic frames exactly as a surface would.
// Whisper transcribes it like any other voice. That keeps the probe honest —
// nothing is injected past a layer — and needs nothing but the box itself.
//
//   node scripts/voice-probe.mjs [--chat <chatId>] [--say "..."]
//
// Run it ON the host: it reads PATCH_INTERNAL_TOKEN from ~/.patch-server/server.env to
// mint the same HMAC voice token the server would, and talks to the audio WSS
// on loopback. Exits non-zero, loudly, on any leg that fails or times out.

import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${REPO}/packages/daemon/`);
const WebSocket = require('ws');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CHAT_ID = arg('chat', 'thread_manager');
const SAY = arg('say', 'Patch, say the word banana back to me and nothing else.');
const AUDIO_PORT = Number(process.env.PATCH_DAEMON_AUDIO_PORT ?? 3003);
const KOKORO_URL = process.env.KOKORO_URL ?? 'ws://127.0.0.1:5019';
const TIMEOUT_MS = Number(arg('timeout', '120000'));

// The installed server's home (packages/server/release/install).
const SERVER_HOME = process.env.PATCH_SERVER_HOME ?? `${process.env.HOME}/.patch-server`;

function envValue(key) {
  const raw = readFileSync(`${SERVER_HOME}/server.env`, 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not in ${SERVER_HOME}/server.env`);
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
}

/** Byte-identical to the server's mint (see daemon/src/audio/token-verifier.ts). */
function mintVoiceToken({ secret, accountId, surfaceId, sessionId, chatId }) {
  const claims = {
    accountId,
    surfaceId,
    sessionId,
    chatId,
    exp: Date.now() + 5 * 60_000,
    jti: randomUUID(),
  };
  const claimsB64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const hmac = createHmac('sha256', secret).update(claimsB64).digest('base64url');
  return `${claimsB64}.${hmac}`;
}

/** Speak `text` with Kokoro and return its 24 kHz PCM16 — our microphone. */
function synthesise(text) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(KOKORO_URL);
    const chunks = [];
    const timer = setTimeout(() => fail(new Error('kokoro: timed out')), 60_000);
    ws.on('open', () => ws.send(JSON.stringify({ requestId: 'probe', text })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return void chunks.push(Buffer.from(data));
      const m = JSON.parse(data.toString());
      if (m.error) {
        clearTimeout(timer);
        return fail(new Error(`kokoro: ${JSON.stringify(m.error)}`));
      }
      if (m.end) {
        clearTimeout(timer);
        ws.close();
        const buf = Buffer.concat(chunks);
        const pcm = new Int16Array(buf.length >>> 1);
        for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
        ok(pcm);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      fail(new Error(`kokoro: ${e.message}`));
    });
  });
}

/** 24 kHz → 16 kHz, the rate the host's mic leg expects. Linear is plenty. */
function downsample24to16(pcm24) {
  const out = new Int16Array(Math.floor((pcm24.length * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const src = (i * 3) / 2;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, pcm24.length - 1);
    const frac = src - lo;
    out[i] = Math.round((pcm24[lo] ?? 0) * (1 - frac) + (pcm24[hi] ?? 0) * frac);
  }
  return out;
}

const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const step = (m) => console.log(`[${since()}] ${m}`);

const secret = envValue('PATCH_INTERNAL_TOKEN');
const accountId = JSON.parse(
  readFileSync(`${SERVER_HOME}/data/registry.json`, 'utf8'),
).account.accountId;

step(`synthesising the utterance to speak into the mic: "${SAY}"`);
const mic = downsample24to16(await synthesise(SAY));
step(`mic audio ready — ${(mic.length / 16000).toFixed(1)}s of speech`);

const sessionId = randomUUID().replace(/-/g, '');
const surfaceId = `probe-${randomUUID().slice(0, 8)}`;
const token = mintVoiceToken({ secret, accountId, surfaceId, sessionId, chatId: CHAT_ID });

const seen = { partial: 0, final: null, ttsBytes: 0, firstTts: null, state: [], error: null };
const ws = new WebSocket(`ws://127.0.0.1:${AUDIO_PORT}/audio/${sessionId}`);
ws.binaryType = 'arraybuffer';

const done = new Promise((finish) => {
  const bail = setTimeout(() => finish('timeout'), TIMEOUT_MS);
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (seen.firstTts === null) {
        seen.firstTts = Date.now();
        step(`FIRST TTS AUDIO — the reply is being spoken`);
      }
      // `ws` hands binary as a Buffer or an ArrayBuffer depending on
      // binaryType; count either, and never silently add `undefined` — that
      // turned the byte total into NaN, which the pass check then read as
      // "not zero" and waved through.
      const len = data.byteLength ?? data.length;
      if (typeof len !== 'number') throw new Error('probe: unreadable binary frame');
      seen.ttsBytes += len;
      return;
    }
    const ev = JSON.parse(data.toString());
    switch (ev.type) {
      case 'audio.state':
        seen.state.push(ev.state);
        step(`state → ${ev.state}`);
        break;
      case 'audio.transcript_partial':
        seen.partial++;
        break;
      case 'audio.transcript_final':
        seen.final = ev.text;
        step(`heard: "${ev.text}"${ev.addressed === false ? ' (not addressed — dropped)' : ''}`);
        break;
      case 'audio.tts_end':
        step('tts_end — reply finished speaking');
        clearTimeout(bail);
        finish('spoke');
        break;
      case 'audio.error':
        seen.error = `${ev.code}: ${ev.message}`;
        step(`ERROR ${seen.error}`);
        clearTimeout(bail);
        finish('error');
        break;
    }
  });
  ws.on('error', (e) => {
    seen.error = e.message;
    clearTimeout(bail);
    finish('error');
  });
});

await new Promise((ok, fail) => {
  ws.on('open', ok);
  ws.on('error', fail);
});

ws.send(
  JSON.stringify({
    type: 'audio.session_start',
    sessionId,
    accountId,
    surfaceId,
    surfaceKind: 'web',
    chatId: CHAT_ID,
    role: 'voice-call',
    token,
    surfaceHasAec: true,
    mode: 'call',
  }),
);
step(`session open on ${CHAT_ID}`);

// Stream the utterance as 30 ms mic frames, in real time — the VAD is watching
// for a natural pause, so firing it all at once would not resemble speech.
const FRAME = 480;
for (let i = 0; i < mic.length; i += FRAME) {
  const slice = mic.subarray(i, Math.min(i + FRAME, mic.length));
  ws.send(JSON.stringify({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples: slice.length }));
  ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
  await new Promise((r) => setTimeout(r, 30));
}
step('utterance streamed; sending silence so the VAD closes it');
const silence = new Int16Array(FRAME);
for (let i = 0; i < 50; i++) {
  ws.send(JSON.stringify({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples: FRAME }));
  ws.send(Buffer.from(silence.buffer));
  await new Promise((r) => setTimeout(r, 30));
}

const outcome = await done;
try {
  ws.close();
} catch {
  /* already closing */
}

console.log('\n--- result ---');
console.log(
  JSON.stringify(
    {
      outcome,
      heard: seen.final,
      partials: seen.partial,
      ttsBytes: seen.ttsBytes,
      states: seen.state,
      error: seen.error,
      totalSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    },
    null,
    2,
  ),
);

if (outcome !== 'spoke' || !(seen.ttsBytes > 0)) {
  console.error(
    '\nFAIL: the call did not speak back. ' +
      (seen.final === null
        ? 'Nothing was transcribed — the STT leg is where it broke.'
        : 'The words were heard, so it broke after transcription (agent turn or TTS).'),
  );
  process.exit(1);
}
console.log('\nPASS: mic → Whisper → agent → Kokoro → speaker, end to end.');
process.exit(0);
