// The host terminal's WebView page (spec/15 § Host files and terminal).
//
// The terminal is drawn by xterm.js — a real emulator, so colour, cursor
// movement, full-screen programs and line editing all render the way the
// shell meant them — inside a WebView, because React Native has no terminal
// widget. The page is dumb on purpose: it draws what it is given and reports
// keystrokes, size changes and the cursor-key mode back. Everything that
// decides anything (sticky Ctrl, the key bar, the session itself) lives in
// tested TypeScript on the React Native side.
//
// Page → app messages go through `window.ReactNativeWebView.postMessage` as
// JSON and are validated here (`parsePageMessage`); app → page calls go
// through `injectJavaScript` against the small `window.__patch` API the page
// installs (`pageCall`).
//
// The colours are handed in from the app's theme, so the terminal follows the
// light/dark scheme like every other screen and no colour is written here.

import { z } from 'zod';
import { FIT_ADDON_JS, XTERM_CSS, XTERM_JS } from '../../vendor/xtermAssets';

export interface TerminalPageTheme {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
}

export const PageMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ type: z.literal('modes'), appCursor: z.boolean() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type PageMessage = z.infer<typeof PageMessage>;

/**
 * Decode one message from the page. NO FALLBACK: something the page should
 * never send throws, naming what arrived, instead of being ignored.
 */
export function parsePageMessage(raw: string): PageMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`terminal page sent something that is not JSON: ${raw.slice(0, 80)}`);
  }
  const parsed = PageMessage.safeParse(json);
  if (!parsed.success) {
    throw new Error(`terminal page sent an unknown message: ${raw.slice(0, 80)}`);
  }
  return parsed.data;
}

/** The JavaScript that calls one page API method, for `injectJavaScript`. */
export function pageCall(method: 'write' | 'reset' | 'focus', arg?: string): string {
  const args = arg === undefined ? '' : JSON.stringify(arg);
  // The trailing `true` is what Android's injectJavaScript wants as the
  // script's completion value; without it some WebViews log a warning.
  return `window.__patch.${method}(${args});true;`;
}

/** The whole page, as an inline HTML document. */
export function buildTerminalPage(theme: TerminalPageTheme, fontSize: number): string {
  const options = JSON.stringify({
    fontFamily: 'monospace',
    fontSize,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: theme.background,
      foreground: theme.foreground,
      cursor: theme.cursor,
      cursorAccent: theme.background,
      selectionBackground: theme.selection,
    },
  });
  const boot = `
(function () {
  function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  window.onerror = function (msg) { post({ type: 'error', message: String(msg) }); };
  try {
    var term = new Terminal(${options});
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('t'));
    fit.fit();
    var appCursor = term.modes.applicationCursorKeysMode;
    term.onData(function (d) { post({ type: 'data', data: d }); });
    term.onResize(function (s) { post({ type: 'resize', cols: s.cols, rows: s.rows }); });
    window.addEventListener('resize', function () { fit.fit(); });
    window.__patch = {
      write: function (d) {
        term.write(d, function () {
          var m = term.modes.applicationCursorKeysMode;
          if (m !== appCursor) { appCursor = m; post({ type: 'modes', appCursor: m }); }
        });
      },
      reset: function () { term.reset(); },
      focus: function () { term.focus(); }
    };
    post({ type: 'ready', cols: term.cols, rows: term.rows });
  } catch (e) {
    post({ type: 'error', message: String((e && e.message) || e) });
  }
})();`;
  return [
    '<!DOCTYPE html><html><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
    `<style>${XTERM_CSS}</style>`,
    '<style>',
    `html,body{margin:0;padding:0;height:100%;overflow:hidden;background:${theme.background};}`,
    '#t{position:absolute;top:4px;left:4px;right:4px;bottom:4px;}',
    '</style>',
    '</head><body><div id="t"></div>',
    `<script>${XTERM_JS}</script>`,
    `<script>${FIT_ADDON_JS}</script>`,
    `<script>${boot}</script>`,
    '</body></html>',
  ].join('');
}
