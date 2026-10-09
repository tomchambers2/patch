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


// Dictation probe: the live preview of a note spoken in two phrases with a
// pause between them. Passes only when the last partial holds words from BOTH
// phrases — the host used to reset the preview at every pause, so the first
// phrase vanished from the composer the moment the second began.
//
//   node scripts/voice-dictation-probe.mjs
//
// Same rules as voice-probe.mjs: run ON the host. Costs a few Groq
// requests; never commits a turn (the session ends `cancelled`).
const FIRST = 'Remind me to buy oat milk tomorrow morning.';
const SECOND = 'And book the car in for a service.';

const started = Date.now();
const step = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const secret = envValue('PATCH_INTERNAL_TOKEN');
const accountId = JSON.parse(
  readFileSync(`${SERVER_HOME}/data/registry.json`, 'utf8'),
).account.accountId;

const phrase1 = downsample24to16(await synthesise(FIRST));
const phrase2 = downsample24to16(await synthesise(SECOND));
step(`speech ready: ${(phrase1.length / 16000).toFixed(1)}s + ${(phrase2.length / 16000).toFixed(1)}s`);

const sessionId = randomUUID().replace(/-/g, '');
const surfaceId = `probe-${randomUUID().slice(0, 8)}`;
const token = mintVoiceToken({ secret, accountId, surfaceId, sessionId, chatId: CHAT_ID });
const ws = new WebSocket(`ws://127.0.0.1:${AUDIO_PORT}/audio/${sessionId}`);
const partials = [];
let error = null;
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(data.toString());
  if (ev.type === 'audio.transcript_partial') {
    partials.push(ev.text);
    step(`partial: "${ev.text}"`);
  }
  if (ev.type === 'audio.error') error = `${ev.code}: ${ev.message}`;
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
    role: 'voice-note',
    token,
    surfaceHasAec: true,
  }),
);

const FRAME = 480;
async function stream(pcm) {
  for (let i = 0; i < pcm.length; i += FRAME) {
    const slice = pcm.subarray(i, Math.min(i + FRAME, pcm.length));
    ws.send(JSON.stringify({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples: slice.length }));
    ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    await new Promise((r) => setTimeout(r, 30));
  }
}
const silence = (s) => new Int16Array(Math.round(s * 16000));
await stream(silence(0.5));
await stream(phrase1);
step('first phrase spoken; pausing');
await stream(silence(2));
await stream(phrase2);
step('second phrase spoken');
await stream(silence(3));
ws.send(JSON.stringify({ type: 'audio.session_end', sessionId, reason: 'cancelled' }));
ws.close();

const last = (partials.at(-1) ?? '').toLowerCase();
const both = /milk/.test(last) && /car|service/.test(last);
console.log(`\nlast preview: "${partials.at(-1) ?? ''}"`);
if (error) {
  console.log(`FAIL: ${error}`);
  process.exit(1);
}
if (!both) {
  console.log('FAIL: the last preview does not hold both phrases.');
  process.exit(1);
}
console.log('PASS: the preview kept the first phrase after the pause.');
