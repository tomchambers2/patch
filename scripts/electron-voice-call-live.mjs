// Real-surface voice-call test for the INSTALLED Electron app.
//
// Prereq — relaunch Patch with a debug port and Chromium's fake microphone:
//   osascript -e 'quit app "Patch"'
//   open -a Patch --args --remote-debugging-port=9222 \
//     --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
//     --use-file-for-fake-audio-capture=<repo>/scripts/fixtures/probe-fakemic-16k.wav
//
// Then:  node scripts/electron-voice-call-live.mjs
//
// Attaches over CDP, patches AudioContext.createBufferSource IN THE APP'S OWN
// RENDERER to count reply PCM actually scheduled to the speaker, navigates to
// the target chat, clicks the real Call button, and passes only when ≥1s of
// reply audio is scheduled. This is the app Tom uses, its own session,
// credential, capture and playback code.
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${REPO}/packages/web/`);
const { chromium } = require('playwright');

const CHAT = process.argv[2] ?? 'thread_manager';

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[${t()}] ${m}`);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
log(`attached — ${pages.length} page(s): ${pages.map((p) => p.url().slice(0, 60)).join(' | ')}`);
const page = pages.find((p) => p.url().includes('/app'));
if (!page) {
  console.error('no /app page found — is the app signed in and on prod?');
  process.exit(1);
}

// Instrument playback BEFORE the call starts. Patching the prototype catches
// the AudioContext the call will create.
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

page.on('console', (msg) => {
  const text = msg.text();
  if (/voice|audio|call|error/i.test(text)) log(`renderer: ${text.slice(0, 180)}`);
});
page.on('pageerror', (err) => log(`PAGE ERROR: ${err.message}`));

// Navigate the SPA to the chat (same-origin hash-free route).
await page.evaluate((chatId) => {
  window.history.pushState({}, '', `/app/chats/${chatId}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}, CHAT);
await page.waitForSelector('[data-testid="chat-head"]', { timeout: 20_000 });
log(`on chat ${CHAT}`);

// Narrow windows collapse the header actions into the hamburger menu — use
// whichever rendering of the SAME startVoiceCall handler is visible.
if (await page.isVisible('[data-testid="action-call"]')) {
  await page.click('[data-testid="action-call"]');
} else {
  await page.click('[data-testid="action-hamburger"]');
  await page.click('[data-testid="hamburger-call"]');
}
log('call button clicked');
await page.waitForSelector('[data-testid="voice-bar"]', { timeout: 15_000 });
log('voice call overlay is up — fake mic speaking the fixture');

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
    outcome = { pass: false, why: 'overlay closed unexpectedly', tts: state.tts, lastLine };
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

if (outcome.pass) {
  await new Promise((r) => setTimeout(r, 3000));
  outcome.tts = await page.evaluate(() => window.__tts);
}
await page.click('[data-testid="voice-bar-end"]').catch(() => {});
await browser.close();

console.log('\n--- result ---');
console.log(JSON.stringify(outcome, null, 2));
if (outcome.pass) {
  console.log(
    `\nPASS: Electron app call — ${outcome.tts.seconds.toFixed(1)}s of reply audio scheduled across ${outcome.tts.buffers} buffers.`,
  );
  process.exit(0);
}
console.log(`\nFAIL: ${outcome.why}`);
process.exit(1);
