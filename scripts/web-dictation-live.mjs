// Real-surface dictation test: the DEPLOYED web app, a real credential, and
// Chromium's fake microphone playing a spoken WAV. Taps the composer mic and
// passes only when the greyed live preview (`composer-live-partial`) paints
// words while the mic is still open — the host's `audio.transcript_partial`
// frames reaching the real composer, not a stubbed socket.
// Usage: node scripts/web-dictation-live.mjs [path-to-fake-mic.wav] [--hotkey]
// --hotkey drives it with ⌘⇧D (focused input) instead of the mic button.
// Credential: ~/.patch/probe-credential.jwt. Costs a few Groq requests.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(`${REPO}/packages/web/`);
const { chromium } = require('playwright');

const HOTKEY = process.argv.includes('--hotkey');
const wavArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const WAV = resolve(wavArg ?? `${REPO}/scripts/fixtures/probe-fakemic-16k.wav`);
const CRED = readFileSync(`${homedir()}/.patch/probe-credential.jwt`, 'utf8').trim();
const APP = process.env.PATCH_APP ?? 'https://patch.tomchambers.me/app';
const CHAT = 'thread_manager';

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

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
await ctx.addInitScript(
  ([cred]) => {
    window.localStorage.setItem('patch.credential.v1', cred);
    // Record every text frame on the audio socket, both directions.
    window.__audio = [];
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      constructor(url, p) {
        super(url, p);
        if (!String(url).includes('/audio')) return;
        this.addEventListener('message', (e) => {
          if (typeof e.data === 'string') window.__audio.push(`<- ${e.data.slice(0, 200)}`);
        });
        const send = this.send.bind(this);
        this.send = (d) => {
          if (typeof d === 'string') window.__audio.push(`-> ${d.slice(0, 200)}`);
          return send(d);
        };
      }
    };
  },
  [CRED],
);

const page = await ctx.newPage();
page.on('console', (msg) => {
  if (/voice|audio|dictat/i.test(msg.text())) log(`console: ${msg.text().slice(0, 200)}`);
});
await page.goto(`${APP}/chats/${CHAT}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
log('chat loaded');

const tap = HOTKEY
  ? async () => {
      await page.focus('[data-testid="composer-input"]');
      await page.keyboard.press('Meta+Shift+KeyD');
    }
  : () =>
      page.$eval('[data-testid="voice-note-btn"]', (el) => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
await tap();
log('mic tapped — fake mic is speaking the fixture');

const partials = [];
let seen = 0;
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  const s = await page.evaluate(() => ({
    partial: document.querySelector('[data-testid="composer-live-partial"]')?.textContent ?? '',
    frames: window.__audio,
    toasts: [...document.querySelectorAll('[data-testid^="error-toast"], .toast')].map(
      (e) => e.textContent,
    ),
  }));
  for (const f of s.frames.slice(seen)) log(`ws ${f}`);
  seen = s.frames.length;
  if (s.partial.trim() && s.partial !== partials.at(-1)) {
    partials.push(s.partial);
    log(`grey preview: "${s.partial.trim()}"`);
  }
  if (s.toasts.length) log(`toasts: ${JSON.stringify(s.toasts)}`);
  await new Promise((r) => setTimeout(r, 250));
}
await tap();
await page.waitForTimeout(4000);
const value = await page.inputValue('[data-testid="composer-input"]');
log(`final input: "${value}"`);
await page.fill('[data-testid="composer-input"]', ''); // never send from a probe
await browser.close();

if (partials.length > 0) {
  console.log(`PASS: ${partials.length} live preview update(s) painted while dictating.`);
  process.exit(0);
}
console.log('FAIL: no greyed live preview appeared while dictating.');
process.exit(1);
