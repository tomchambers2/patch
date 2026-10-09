// The host terminal's WebView page (spec/15 § Host files and terminal): what
// the page is built from, the messages it may send, and the calls the app
// makes into it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTerminalPage, pageCall, parsePageMessage } from '../src/lib/terminalPage';
import { XTERM_JS, XTERM_VERSION } from '../vendor/xtermAssets';
import { darkColors, lightColors } from '../src/lib/theme';

const theme = {
  background: lightColors.paper,
  foreground: lightColors.ink,
  cursor: lightColors.leaf,
  selection: lightColors.accentSoft,
};

describe('buildTerminalPage', () => {
  it('inlines xterm.js and its fit addon, so the terminal needs nothing from the network', () => {
    const html = buildTerminalPage(theme, 13);
    expect(html).toContain(XTERM_JS);
    expect(html).toContain('FitAddon');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('draws in the theme it is given — light and dark alike', () => {
    const light = buildTerminalPage(theme, 13);
    expect(light).toContain(`"background":"${lightColors.paper}"`);
    expect(light).toContain(`"foreground":"${lightColors.ink}"`);
    expect(light).toContain(`"cursor":"${lightColors.leaf}"`);
    expect(light).toContain(`background:${lightColors.paper}`);
    const dark = buildTerminalPage(
      {
        background: darkColors.paper,
        foreground: darkColors.ink,
        cursor: darkColors.leaf,
        selection: darkColors.accentSoft,
      },
      13,
    );
    expect(dark).toContain(`"background":"${darkColors.paper}"`);
  });

  it('uses the font size it is given', () => {
    expect(buildTerminalPage(theme, 15)).toContain('"fontSize":15');
  });

  it('closes each inline script exactly where it means to (no source ends one early)', () => {
    const html = buildTerminalPage(theme, 13);
    expect(html.match(/<script>/g)).toHaveLength(3);
    expect(html.match(/<\/script>/g)).toHaveLength(3);
  });

  it('installs the write / reset / focus API the app calls, and reports ready with its size', () => {
    const html = buildTerminalPage(theme, 13);
    expect(html).toContain('window.__patch = {');
    expect(html).toContain("post({ type: 'ready', cols: term.cols, rows: term.rows })");
    expect(html).toContain('applicationCursorKeysMode');
  });
});

describe('vendor/xtermAssets.ts', () => {
  it('is what the installed xterm packages generate — regenerate after a bump', async () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../node_modules/@xterm/xterm/package.json'), 'utf8'),
    ) as { version: string };
    expect(XTERM_VERSION).toBe(pkg.version);
    // @ts-expect-error — a plain .mjs script with no type declarations
    const gen = (await import('../scripts/gen-xterm-assets.mjs')) as {
      render: () => string;
      OUT_FILE: string;
    };
    expect(readFileSync(gen.OUT_FILE, 'utf8')).toBe(gen.render());
  });
});

describe('parsePageMessage', () => {
  it('accepts each message the page sends', () => {
    expect(parsePageMessage('{"type":"ready","cols":80,"rows":24}')).toEqual({
      type: 'ready',
      cols: 80,
      rows: 24,
    });
    expect(parsePageMessage('{"type":"data","data":"ls\\r"}')).toEqual({
      type: 'data',
      data: 'ls\r',
    });
    expect(parsePageMessage('{"type":"resize","cols":40,"rows":12}')).toMatchObject({
      type: 'resize',
    });
    expect(parsePageMessage('{"type":"modes","appCursor":true}')).toEqual({
      type: 'modes',
      appCursor: true,
    });
    expect(parsePageMessage('{"type":"error","message":"boom"}')).toMatchObject({
      type: 'error',
    });
  });

  it('refuses anything else loudly, naming what arrived (NO FALLBACK)', () => {
    expect(() => parsePageMessage('not json')).toThrow(/not JSON: not json/);
    expect(() => parsePageMessage('{"type":"launch"}')).toThrow(/unknown message/);
    expect(() => parsePageMessage('{"type":"ready","cols":0,"rows":24}')).toThrow(
      /unknown message/,
    );
  });
});

describe('pageCall', () => {
  it('builds an injectable call, with its argument JSON-encoded', () => {
    expect(pageCall('focus')).toBe('window.__patch.focus();true;');
    expect(pageCall('write', 'a"b\n')).toBe('window.__patch.write("a\\"b\\n");true;');
  });
});
