// End-to-end probe of the REAL Gemini Live API, with no host involved.
//
// gemini-live.ts's own unit tests (packages/daemon/test/gemini-live-session.
// test.ts) mock the WebSocket entirely, on purpose — this repo avoids real
// spend in automated runs. This script is the other half: one real session
// against Google's live endpoint, run BY HAND, to prove the wire shapes this
// repo guessed at from the docs (setup / realtimeInput / serverContent /
// toolCall / toolResponse / clientContent) are actually right, and to report
// the real round-trip latency. Two short exchanges only:
//
//   1. A voice turn — Kokoro speaks a line (the "microphone", same trick
//      scripts/voice-probe.mjs uses), streamed in as 16 kHz PCM. Proves
//      audio in, audio out, and measures time-to-first-audio.
//   2. A text turn engineered to make the model call dispatch_to_patch.
//      Proves the tool-calling round trip: the host side (submitUserTurn)
//      is stubbed here to a canned reply, since there is no real host in
//      this script — this checks the WIRE contract, not chatRunner.ts.
//
// Deliberately talks to Google directly, NOT through packages/daemon/src/
// audio/server.ts or this box's real patch-daemon — this script must never
// touch the production host (a live service on this host).
//
//   node scripts/gemini-live-smoke.mjs
//
// Needs GEMINI_API_KEY in the environment, or falls back to reading it out of
// this Hetzner host's patch-daemon systemd unit (~/.config/systemd/user/
// patch-daemon.service), which is where it already lives for the real daemon.
// Real spend against the `tc-patch` GCP project — kept to these two short
// exchanges, not a loop.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Resolve 'ws' the same way scripts/voice-probe.mjs does: from
// packages/daemon (a direct dependency there), not from scripts/ itself,
// which has no node_modules of its own in a pnpm workspace.
const require = createRequire(`${REPO}/packages/daemon/`);
const WebSocket = require('ws');

const DEFAULT_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const MODEL = process.env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL;
const DISPATCH_TOOL_NAME = 'dispatch_to_patch';
const KOKORO_URL = process.env.KOKORO_URL ?? 'ws://127.0.0.1:5019';
const TIMEOUT_MS = 60_000;

const started = Date.now();
const since = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const step = (m) => console.log(`[${since()}] ${m}`);

function resolveGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const unitPath = join(homedir(), '.config/systemd/user/patch-daemon.service');
  const raw = readFileSync(unitPath, 'utf8');
  const m = /Environment="GEMINI_API_KEY=([^"]+)"/.exec(raw);
  if (!m) {
    throw new Error(
      `GEMINI_API_KEY not in env and not found in ${unitPath} — set it or pass it explicitly.`,
    );
  }
  return m[1];
}

/** Speak `text` with the shared Kokoro sidecar and return its 24 kHz PCM16 — our microphone. */
function synthesise(text) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(KOKORO_URL);
    const chunks = [];
    const timer = setTimeout(() => fail(new Error('kokoro: timed out')), 30_000);
    ws.on('open', () => ws.send(JSON.stringify({ requestId: 'gemini-smoke', text })));
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

/** 24 kHz → 16 kHz, the rate Gemini Live's realtimeInput expects. Linear is plenty for a smoke test. */
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

function buildSetupMessage() {
  return {
    setup: {
      model: MODEL,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: {
        parts: [
          {
            text:
              "You are Patch's fast voice layer, a natural conversational voice assistant. You have " +
              `NO access to the user's own data — for anything needing it, call ${DISPATCH_TOOL_NAME} ` +
              'with a plain-language description, saying a brief spoken bridge first. Otherwise answer directly.',
          },
        ],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: DISPATCH_TOOL_NAME,
              description:
                "Call this for anything needing the user's actual data, tasks, calendar, or any action.",
              parameters: {
                type: 'OBJECT',
                properties: { request: { type: 'STRING', description: 'What to look up or do.' } },
                required: ['request'],
              },
              behavior: 'NON_BLOCKING',
            },
          ],
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

class GeminiSmokeClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.setupCompleteResolvers = [];
  }

  async connect() {
    const url =
      'wss://generativelanguage.googleapis.com/ws/' +
      `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.send(JSON.stringify(buildSetupMessage()));
    await new Promise((resolve) => this.setupCompleteResolvers.push(resolve));
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      step(`WARN: non-JSON frame from Gemini (${data.length} bytes)`);
      return;
    }
    if (msg.setupComplete) {
      const rs = this.setupCompleteResolvers;
      this.setupCompleteResolvers = [];
      for (const r of rs) r();
      return;
    }
    this.onServerMessage?.(msg);
  }

  sendAudioChunk(pcm16) {
    const b64 = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64');
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }));
  }

  sendText(text) {
    this.ws.send(
      JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }),
    );
  }

  sendToolResponse(id, name, result) {
    this.ws.send(
      JSON.stringify({ toolResponse: { functionResponses: [{ id, name, response: { result } }] } }),
    );
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }
}

/** Drive one turn to completion, resolving with what happened + latency numbers. */
function runTurn(client, { label, kick }) {
  return new Promise((resolve, reject) => {
    const seen = { audioBytes: 0, firstAudioAt: null, inputText: '', outputText: '', dispatched: null };
    const turnStarted = Date.now();
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    client.onServerMessage = (msg) => {
      if (msg.toolCall?.functionCalls) {
        for (const call of msg.toolCall.functionCalls) {
          if (call.name === DISPATCH_TOOL_NAME) {
            seen.dispatched = call.args?.request ?? '(no request field)';
            step(`  toolCall → ${DISPATCH_TOOL_NAME}({ request: ${JSON.stringify(seen.dispatched)} })`);
            // Stand in for the host's real submitUserTurn — this script has
            // no host behind it, so it answers with a canned "heavy agent" reply.
            client.sendToolResponse(call.id, call.name, 'You have 3 tasks due today: bins, gym, invoice.');
          }
        }
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text) seen.inputText += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) seen.outputText += sc.outputTranscription.text;
      const parts = sc.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          if (seen.firstAudioAt === null) {
            seen.firstAudioAt = Date.now();
            step(`  first audio byte back — ${seen.firstAudioAt - turnStarted}ms after the turn started`);
          }
          seen.audioBytes += Buffer.from(part.inlineData.data, 'base64').byteLength;
        }
      }
      if (sc.turnComplete) {
        clearTimeout(timer);
        client.onServerMessage = undefined;
        resolve({ ...seen, turnMs: Date.now() - turnStarted });
      }
    };
    kick();
  });
}

async function main() {
  const apiKey = resolveGeminiApiKey();
  step(`model: ${MODEL}`);
  step('connecting to the real Gemini Live API…');
  const client = new GeminiSmokeClient(apiKey);
  await client.connect();
  step('setup complete');

  // --- turn 1: voice, chit-chat (no dispatch expected) ---
  const SAY = 'Say the word banana back to me and nothing else.';
  step(`synthesising the mic line via the shared Kokoro sidecar: "${SAY}"`);
  const mic = downsample24to16(await synthesise(SAY));
  step(`mic audio ready — ${(mic.length / 16000).toFixed(2)}s`);
  const turn1 = await runTurn(client, {
    label: 'turn 1 (voice)',
    kick: async () => {
      const FRAME = 480; // 30ms @ 16kHz
      for (let i = 0; i < mic.length; i += FRAME) {
        client.sendAudioChunk(mic.subarray(i, Math.min(i + FRAME, mic.length)));
        await new Promise((r) => setTimeout(r, 30));
      }
    },
  });
  step(
    `turn 1 done in ${turn1.turnMs}ms — heard "${turn1.inputText.trim()}", ` +
      `${turn1.audioBytes} bytes of reply audio, dispatched=${turn1.dispatched !== null}`,
  );

  // --- turn 2: text, engineered to dispatch ---
  const ASK = "What's on my Todoist list today?";
  step(`sending turn 2 (text, expected to dispatch): "${ASK}"`);
  const turn2 = await runTurn(client, { label: 'turn 2 (dispatch)', kick: () => client.sendText(ASK) });
  step(
    `turn 2 done in ${turn2.turnMs}ms — dispatched=${turn2.dispatched !== null}, ` +
      `${turn2.audioBytes} bytes of reply audio`,
  );

  client.close();

  console.log('\n--- result ---');
  console.log(
    JSON.stringify(
      {
        model: MODEL,
        turn1: { ...turn1, kind: 'voice, chit-chat' },
        turn2: { ...turn2, kind: 'text, engineered to dispatch' },
        totalSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      },
      null,
      2,
    ),
  );

  const failures = [];
  if (turn1.audioBytes === 0) failures.push('turn 1 produced no reply audio — audio out is broken');
  if (turn1.inputText.trim().length === 0) failures.push('turn 1 produced no input transcription');
  if (turn2.dispatched === null) failures.push('turn 2 never called dispatch_to_patch — tool-calling is broken');
  if (turn2.audioBytes === 0) failures.push('turn 2 produced no reply audio after the tool response');

  if (failures.length > 0) {
    console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nPASS: real Gemini Live session — audio in/out, transcription, and dispatch tool-calling all work.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.stack ?? err.message}`);
  process.exit(1);
});
