// Real-surface test of the EAR (hands-free / working mode) in the INSTALLED
// Electron app. One session, both contractual behaviours:
//
//   1. an utterance that does NOT open with the address word is heard and
//      DROPPED — the bar goes to data-state="heard", no turn, NO reply audio;
//   2. an utterance that opens with "Patch, …" becomes a turn and the reply
//      is actually scheduled to the speaker (≥1s of PCM).
//
// A pass means the ear can be relied on: quiet for unaddressed speech, spoken
// reply for addressed speech. A fail names which half broke.
//
// Prereq — relaunch Patch with the fake mic playing the combined fixture
// (unaddressed line at ~1.5s, addressed line at ~12.4s):
//   osascript -e 'quit app "Patch"'
//   open -a Patch --args --remote-debugging-port=9222 \
//     --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
//     --use-file-for-fake-audio-capture=<repo>/scripts/fixtures/probe-ear-48k.wav \
//     --disable-features=AudioServiceOutOfProcess,AudioServiceSandbox
//
// Then:  node scripts/electron-ear-live.mjs
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${REPO}/packages/web/`);
const { chromium } = require('playwright');

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[${t()}] ${m}`);

const result = { pass: false, dropped: null, replied: null, detail: null, tts: null };
function finish() {
  console.log('\n--- result ---');
  console.log(JSON.stringify(result, null, 2));
  if (result.pass) {
    console.log('\nPASS: the ear drops unaddressed speech and speaks a reply to addressed speech.');
    process.exit(0);
  }
  console.log(`\nFAIL: ${result.detail}`);
  process.exit(1);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().includes('/app'));
if (!page) {
  result.detail = 'no /app page found over CDP — relaunch Patch with the flags in the header comment';
  finish();
}

await page.evaluate(() => {
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
});

// The ear lives on the Manager row in the sidebar (hands-free session on
// thread_manager) — the SAME control Tom presses.
const ear = page.locator('.sb-row.special [aria-label="start working session"]').first();
await ear.click({ timeout: 15_000 });
log('ear clicked — working session opening (fake mic track is rolling)');
await page.waitForSelector('[data-testid="voice-bar"]', { timeout: 15_000 });

const read = () =>
  page.evaluate(() => ({
    line: document.querySelector('[data-testid="voice-bar-line"]')?.textContent ?? '',
    heardNotSent:
      document.querySelector('[data-testid="voice-bar"]')?.getAttribute('data-state') === 'heard',
    overlay: !!document.querySelector('[data-testid="voice-bar"]'),
    tts: window.__tts,
  }));

// --- phase 1: the unaddressed line must be heard-and-dropped ---------------
// (finishes speaking ~4.4s in; give the round trip until 25s)
let deadline = Date.now() + 25_000;
let lastLine = '';
while (Date.now() < deadline && result.dropped === null) {
  const s = await read();
  if (s.line && s.line !== lastLine) {
    lastLine = s.line;
    log(`overlay: "${s.line.slice(0, 110)}"${s.heardNotSent ? '  [HEARD — not sent]' : ''}`);
  }
  if (!s.overlay) {
    result.detail = 'overlay closed during phase 1';
    finish();
  }
  if (s.tts.seconds > 0.2) {
    result.dropped = false;
    result.detail = `ear REPLIED to unaddressed speech ("${s.line.slice(0, 80)}") — the address gate is broken`;
    finish();
  }
  if (s.heardNotSent) result.dropped = true;
  await new Promise((r) => setTimeout(r, 400));
}
if (result.dropped !== true) {
  result.detail = 'unaddressed utterance never showed as heard-not-sent — no transcript came back';
  finish();
}
log('phase 1 OK — unaddressed speech heard, greyed, no reply');

// --- phase 2: the addressed line must get a spoken reply -------------------
// (starts ~12.4s into the track; allow the agent turn its time)
deadline = Date.now() + 110_000;
while (Date.now() < deadline && result.replied === null) {
  const s = await read();
  if (s.line && s.line !== lastLine) {
    lastLine = s.line;
    log(`overlay: "${s.line.slice(0, 110)}"${s.heardNotSent ? '  [HEARD — not sent]' : ''}`);
  }
  if (!s.overlay) {
    result.detail = 'overlay closed during phase 2';
    finish();
  }
  if (s.tts.seconds >= 1) result.replied = true;
  else await new Promise((r) => setTimeout(r, 400));
}
if (result.replied !== true) {
  result.tts = await page.evaluate(() => window.__tts);
  result.detail = 'addressed "Patch, …" utterance got no reply audio within 110s';
  finish();
}

await new Promise((r) => setTimeout(r, 2000));
result.tts = await page.evaluate(() => window.__tts);
await page.click('[data-testid="voice-bar-end"]').catch(() => {});
await browser.close();
result.pass = true;
finish();
