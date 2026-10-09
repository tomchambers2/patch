// Full-path probe of a voice call: the OUTER legs that scripts/voice-probe.mjs
// deliberately skips.
//
// voice-probe.mjs runs ON the host, mints its own HMAC token, and talks
// to the audio WSS on loopback — it proves the host pipeline (Whisper →
// agent → Kokoro). It passed on prod on 2026-08-25 while real phone calls were
// broken, which is exactly the blind spot: everything between a surface and
// that loopback socket was untested. This probe IS a surface:
//
//   1. authenticates with a REAL surface credential (~/.patch/credential.jwt),
//   2. calls the REAL mint endpoint  POST {server}/api/voice/token,
//   3. connects to the PUBLIC audio WSS  wss://…/audio/<sessionId>  via Caddy,
//   4. opens a voice-call session exactly as apps/mobile/src/lib/voiceCall.ts
//      does, streams a spoken fixture as mic frames, and
//   5. asserts every leg with its OWN deadline, so a failure names the first
//      leg that went silent instead of just "timed out".
//
//   node scripts/voice-probe-fullpath.mjs
//     [--server https://patch.tomchambers.me]   target stack
//     [--chat thread_manager]                   chat to bind the call to
//     [--mode call]                             session mode (call | …)
//     [--mic-wav scripts/fixtures/probe-utterance-16k.wav]
//     [--credential ~/.patch/credential.jwt]
//     [--json]                                  machine-readable result line
//
// The fixture WAV is Kokoro speaking "Patch, say the word banana back to me
// and nothing else." (16 kHz mono PCM16). Regenerate it against a host
// with Kokoro if the prompt ever changes — the prompt below must match the
// audio, since Whisper hears the audio, not the flag.
//
// Distinct failure worth knowing about: `addressed:false` on the final
// transcript means the host HEARD the words but decided the utterance was
// not addressed to it, so no turn was submitted and no reply will ever come —
// which presents to a human as "it transcribes me but nothing comes back".
// That is reported as leg `addressing`, not as a reply timeout.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
const has = (name) => process.argv.includes(`--${name}`);

const SERVER = arg('server', 'https://patch.tomchambers.me').replace(/\/$/, '');
const CHAT_ID = arg('chat', 'thread_manager');
const MODE = arg('mode', 'call');
const MIC_WAV = resolve(REPO, arg('mic-wav', 'scripts/fixtures/probe-utterance-16k.wav'));
const CRED_PATH = arg('credential', resolve(homedir(), '.patch/credential.jwt'));
const AS_JSON = has('json');
// --expect-dropped: the utterance must come back addressed:false and produce
// NO reply — the hands-free address gate working. Pair with --mode hands-free
// and an utterance that does not open with the address word.
const EXPECT_DROPPED = has('expect-dropped');

// Per-leg deadlines (ms). Generous — this gates "does it work", not latency.
const LEG_MS = {
  mint: 15_000,
  connect: 15_000,
  listening: 15_000,
  transcript: 45_000, // from end of streamed silence
  reply: 120_000, // transcript_final → first TTS byte (covers the agent turn)
  tts_end: 120_000, // first TTS byte → tts_end
};

const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const step = (m) => console.log(`[${since()}] ${m}`);

/** Parse a 16 kHz mono PCM16 WAV. No fallback: anything else is an error. */
function readWav16k(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a WAV file`);
  }
  // Walk chunks to find fmt + data — don't assume a 44-byte header.
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { off: off + 8, size };
    if (id === 'data') data = { off: off + 8, size };
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data chunk`);
  const format = buf.readUInt16LE(fmt.off);
  const channels = buf.readUInt16LE(fmt.off + 2);
  const rate = buf.readUInt32LE(fmt.off + 4);
  const bits = buf.readUInt16LE(fmt.off + 14);
  if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) {
    throw new Error(
      `${path}: need PCM16 mono 16 kHz, got format=${format} ch=${channels} rate=${rate} bits=${bits}`,
    );
  }
  const n = data.size >>> 1;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(data.off + i * 2);
  return pcm;
}

/** b64url JSON decode of the voice token's claims segment. */
function tokenClaims(token) {
  const seg = token.split('.')[0];
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

const result = {
  server: SERVER,
  chat: CHAT_ID,
  mode: MODE,
  outcome: null,
  failedLeg: null,
  detail: null,
  heard: null,
  addressed: null,
  ttsBytes: 0,
  states: [],
  legSeconds: {},
};

function fail(leg, detail) {
  result.outcome = 'fail';
  result.failedLeg = leg;
  result.detail = detail;
  report();
  process.exit(1);
}

function report() {
  console.log('\n--- result ---');
  console.log(JSON.stringify(result, null, AS_JSON ? 0 : 2));
  if (result.outcome === 'pass') {
    console.log(
      `\nPASS: surface credential → mint → public WSS → Whisper → agent → Kokoro → TTS, end to end.`,
    );
  } else {
    console.log(`\nFAIL at leg "${result.failedLeg}": ${result.detail}`);
  }
}

const legStarted = Date.now();
let legMark = legStarted;
function legDone(name) {
  const now = Date.now();
  result.legSeconds[name] = +((now - legMark) / 1000).toFixed(1);
  legMark = now;
}

// ---- leg 0: mic fixture ----------------------------------------------------
const mic = readWav16k(MIC_WAV);
step(`mic fixture loaded — ${(mic.length / 16000).toFixed(1)}s of speech (${MIC_WAV})`);

// ---- leg 1: mint via the real server route --------------------------------
let credential;
try {
  credential = readFileSync(CRED_PATH, 'utf8').trim();
} catch {
  fail('credential', `no surface credential at ${CRED_PATH} — run \`patch auth login\` there`);
}

step(`minting voice token: POST ${SERVER}/api/voice/token (chat=${CHAT_ID})`);
let mint;
try {
  const res = await fetch(`${SERVER}/api/voice/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(LEG_MS.mint),
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ chatId: CHAT_ID, role: 'voice-call', surfaceKind: 'mobile' }),
  });
  const body = await res.text();
  if (res.status !== 200) fail('mint', `HTTP ${res.status}: ${body.slice(0, 300)}`);
  mint = JSON.parse(body);
} catch (e) {
  if (result.outcome) throw e; // fail() already exited path
  fail('mint', e.message);
}
const claims = tokenClaims(mint.token);
legDone('mint');
step(`token minted — session ${mint.sessionId}, audioUrl ${mint.audioUrl}`);

// ---- leg 2: connect the public audio WSS ----------------------------------
const wsUrl = `${SERVER.replace(/^http/, 'ws')}${mint.audioUrl}`;
step(`connecting ${wsUrl}`);
const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';

const seen = { firstTts: null, transcriptFinal: null, ttsEnd: false };

let onEvent = () => {};
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (seen.firstTts === null) {
      seen.firstTts = Date.now();
      step('FIRST TTS AUDIO — the reply is being spoken');
    }
    const len = data.byteLength ?? data.length;
    if (typeof len !== 'number') fail('tts', 'unreadable binary frame');
    result.ttsBytes += len;
    onEvent({ type: '_tts_chunk' });
    return;
  }
  const ev = JSON.parse(data.toString());
  if (ev.type === 'audio.state') {
    result.states.push(ev.state);
    step(`state → ${ev.state}`);
  } else if (ev.type === 'audio.transcript_final') {
    seen.transcriptFinal = ev;
    result.heard = ev.text;
    result.addressed = ev.addressed !== false;
    step(`heard: "${ev.text}"${ev.addressed === false ? ' (NOT ADDRESSED — no turn submitted)' : ''}`);
  } else if (ev.type === 'audio.tts_end') {
    seen.ttsEnd = true;
    step('tts_end — reply finished speaking');
  } else if (ev.type === 'audio.error') {
    fail('daemon', `audio.error ${ev.code}: ${ev.message}`);
  }
  onEvent(ev);
});
ws.on('close', (code, reason) => {
  if (!result.outcome) {
    fail('socket', `WS closed early: code=${code} reason=${reason?.toString?.() ?? ''}`);
  }
});
ws.on('error', (e) => {
  if (!result.outcome) fail('socket', e.message);
});

/** Await a condition on the event stream, with a named per-leg deadline. */
function waitFor(leg, ms, pred) {
  return new Promise((ok) => {
    if (pred()) return ok();
    const t = setTimeout(
      () => fail(leg, `no progress within ${ms / 1000}s — last states: [${result.states.join(', ')}]`),
      ms,
    );
    onEvent = () => {
      if (pred()) {
        clearTimeout(t);
        onEvent = () => {};
        ok();
      }
    };
  });
}

await new Promise((ok) => {
  const t = setTimeout(() => fail('connect', `WS did not open within ${LEG_MS.connect / 1000}s`), LEG_MS.connect);
  ws.on('open', () => {
    clearTimeout(t);
    ok();
  });
});
legDone('connect');

// ---- leg 3: session_start, exactly as the mobile surface sends it ---------
ws.send(
  JSON.stringify({
    type: 'audio.session_start',
    sessionId: mint.sessionId,
    accountId: claims.accountId,
    surfaceId: claims.surfaceId,
    surfaceKind: 'mobile',
    chatId: CHAT_ID,
    role: 'voice-call',
    token: mint.token,
    surfaceHasAec: true,
    mode: MODE,
  }),
);
await waitFor('listening', LEG_MS.listening, () => result.states.includes('listening'));
legDone('listening');

// ---- leg 4: stream the utterance as real-time 30 ms mic frames ------------
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
legDone('stream');

// ---- leg 5: transcript ----------------------------------------------------
await waitFor('transcript', LEG_MS.transcript, () => seen.transcriptFinal !== null);
legDone('transcript');
if (EXPECT_DROPPED) {
  // The gate test: the utterance must be heard-and-dropped, and stay silent.
  if (seen.transcriptFinal.addressed !== false) {
    fail(
      'addressing',
      `expected the unaddressed utterance to be dropped, but the host marked it addressed and will reply — the hands-free gate is broken open`,
    );
  }
  await new Promise((r) => setTimeout(r, 8_000));
  if (result.ttsBytes > 0) {
    fail('addressing', `utterance was marked dropped yet ${result.ttsBytes} TTS bytes arrived anyway`);
  }
  result.outcome = 'pass';
  try {
    ws.send(JSON.stringify({ type: 'audio.session_end', reason: 'probe complete' }));
    ws.close();
  } catch {
    /* closing */
  }
  report();
  process.exit(0);
}
if (seen.transcriptFinal.addressed === false) {
  fail(
    'addressing',
    `host heard "${seen.transcriptFinal.text}" but marked it addressed:false — no turn was submitted, so no reply will come. This is the "transcribes me but nothing comes back" presentation.`,
  );
}

// ---- leg 6: the reply (agent turn → first TTS byte) -----------------------
await waitFor('reply', LEG_MS.reply, () => seen.firstTts !== null);
legDone('reply');

// ---- leg 7: reply finishes ------------------------------------------------
await waitFor('tts_end', LEG_MS.tts_end, () => seen.ttsEnd);
legDone('tts_end');

if (result.ttsBytes < 16_000) {
  // <⅓s of 24 kHz PCM16 — a "reply" that no human would hear as one.
  fail('tts', `tts_end arrived but only ${result.ttsBytes} TTS bytes were streamed`);
}

result.outcome = 'pass';
try {
  ws.send(JSON.stringify({ type: 'audio.session_end', reason: 'probe complete' }));
  ws.close();
} catch {
  /* closing */
}
report();
process.exit(0);
