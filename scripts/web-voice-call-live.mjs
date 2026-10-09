// Real-surface voice-call test: the DEPLOYED web app, a real credential, and
// Chromium's fake microphone playing a Kokoro-spoken WAV. Verifies the reply
// is actually SCHEDULED TO THE SPEAKER (AudioBufferSourceNode seconds), not
// just that a state flag flipped.
// Usage: node scripts/web-voice-call-live.mjs [path-to-fake-mic.wav]
// Needs a surface credential at ~/.patch/credential.jwt and Playwright's
// chromium installed for @patch/web. The default WAV is the banana fixture
// padded with 1s lead-in and 25s tail silence, so the VAD hears one clean
// utterance and the file outlasts the whole call.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${REPO}/packages/web/`);
const { chromium } = require('playwright');

const WAV = resolve(process.argv[2] ?? `${REPO}/scripts/fixtures/probe-fakemic-16k.wav`);
const CRED = readFileSync(`${homedir()}/.patch/credential.jwt`, 'utf8').trim();
const APP = 'https://patch.tomchambers.me/app';
const CHAT = 'thread_manager';

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[${t()}] ${m}`);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });

// Before any app code runs: store the credential, and instrument playback.
await ctx.addInitScript(
  ([cred]) => {
    try {
      window.localStorage.setItem('patch.credential.v1', cred);
    } catch {}
    window.__tts = { seconds: 0, buffers: 0 };
    const orig = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = orig.call(this);
      const start = node.start.bind(node);
      node.start = (...a) => {
        if (node.buffer) {
          window.__tts.seconds += node.buffer.duration;
          window.__tts.buffers += 1;
        }
        return start(...a);
      };
      return node;
    };
  },
  [CRED],
);

const page = await ctx.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (/voice|audio|call/i.test(text)) log(`console: ${text.slice(0, 160)}`);
});

log(`opening ${APP}/chats/${CHAT}`);
await page.goto(`${APP}/chats/${CHAT}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="chat-head"]', { timeout: 30_000 });
log('chat loaded and authenticated');

await page.click('[data-testid="action-call"]');
log('call button clicked');
await page.waitForSelector('[data-testid="voice-bar"]', { timeout: 15_000 });
log('voice call overlay is up — fake mic is now speaking the fixture');

// Watch the overlay + playback instrumentation until the reply has actually
// been scheduled to the speaker, or we time out.
const deadline = Date.now() + 120_000;
let lastLine = '';
let outcome = null;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => ({
    line: document.querySelector('[data-testid="voice-bar-line"]')?.textContent ?? '',
    overlay: !!document.querySelector('[data-testid="voice-bar"]'),
    tts: window.__tts,
  }));
  if (state.line && state.line !== lastLine) {
    lastLine = state.line;
    log(`overlay: "${state.line.slice(0, 120)}"`);
  }
  if (!state.overlay) {
    outcome = { pass: false, why: 'overlay closed unexpectedly', tts: state.tts };
    break;
  }
  if (state.tts.seconds >= 1) {
    outcome = { pass: true, tts: state.tts, lastLine };
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!outcome) {
  const tts = await page.evaluate(() => window.__tts);
  outcome = { pass: false, why: 'no reply audio scheduled within 120s', tts, lastLine };
}

// Let a bit more of the reply accumulate, then end the call politely.
if (outcome.pass) {
  await new Promise((r) => setTimeout(r, 3000));
  outcome.tts = await page.evaluate(() => window.__tts);
  await page.click('[data-testid="voice-bar-end"]').catch(() => {});
}
await browser.close();

console.log('\n--- result ---');
console.log(JSON.stringify(outcome, null, 2));
if (outcome.pass) {
  console.log(
    `\nPASS: real web app call — ${outcome.tts.seconds.toFixed(1)}s of reply audio scheduled to the speaker across ${outcome.tts.buffers} buffers.`,
  );
  process.exit(0);
}
console.log(`\nFAIL: ${outcome.why}`);
process.exit(1);
