// monaco-loader — self-host bootstrap wiring for Monaco (see lib/monaco-loader.ts
// header comment). Only ever imported from main.tsx (excluded from coverage),
// so this test imports it directly with every heavy dependency mocked:
// the real monaco-editor namespace, the four `?worker` chunks, and
// @monaco-editor/loader (which would otherwise try to fetch from a CDN).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MONACO_THEME, MONACO_PALETTE_TOKENS } from '../lib/monacoTheme.js';

// The bootstrap also themes Monaco from the app palette (spec/14 § Theming), so
// the mock namespace carries the `editor.defineTheme`/`setTheme` pair it drives.
const definedThemes: Array<[string, { base: string; colors: Record<string, string> }]> = [];
const activatedThemes: string[] = [];
const monacoNamespace = {
  __esModule: true,
  Range: class MockRange {},
  marker: 'monaco-ns',
  editor: {
    defineTheme: (name: string, data: { base: string; colors: Record<string, string> }) => {
      definedThemes.push([name, data]);
    },
    setTheme: (name: string) => {
      activatedThemes.push(name);
    },
  },
};

// jsdom (29) implements NEITHER `matchMedia` NOR a real cascade, so the palette
// read and the colour-scheme query are both stubbed here. `schemeListeners`
// stands in for the OS flipping light↔dark.
const schemeListeners: Array<() => void> = [];
const media = {
  matches: true,
  addEventListener: (_t: string, l: () => void) => schemeListeners.push(l),
  removeEventListener: vi.fn(),
};

function installThemeEnvironment(): void {
  definedThemes.length = 0;
  activatedThemes.length = 0;
  schemeListeners.length = 0;
  media.matches = true;
  window.matchMedia = ((): unknown => media) as unknown as typeof window.matchMedia;
  const values: Record<string, string> = {
    [MONACO_PALETTE_TOKENS.surface]: media.matches ? '#2d2b28' : '#ffffff',
    [MONACO_PALETTE_TOKENS.surfaceSoft]: '#262421',
    [MONACO_PALETTE_TOKENS.ink]: '#efede9',
    [MONACO_PALETTE_TOKENS.inkDim]: '#928d84',
    [MONACO_PALETTE_TOKENS.inkFaint]: '#6c6862',
    [MONACO_PALETTE_TOKENS.line]: '#38352f',
    [MONACO_PALETTE_TOKENS.added]: '#77a966',
    [MONACO_PALETTE_TOKENS.removed]: '#cd7e70',
  };
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (p: string) => values[p] ?? '',
  } as unknown as CSSStyleDeclaration);
}

class MockEditorWorker {
  label = 'editor';
}
class MockJsonWorker {
  label = 'json';
}
class MockCssWorker {
  label = 'css';
}
class MockHtmlWorker {
  label = 'html';
}
class MockTsWorker {
  label = 'ts';
}

const loaderConfig = vi.fn();
let loaderInit: ReturnType<typeof vi.fn>;

vi.mock('monaco-editor/esm/vs/editor/editor.main.js', () => monacoNamespace);
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({
  default: MockEditorWorker,
}));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({
  default: MockJsonWorker,
}));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({
  default: MockCssWorker,
}));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({
  default: MockHtmlWorker,
}));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({
  default: MockTsWorker,
}));
vi.mock('@monaco-editor/loader', () => ({
  default: {
    config: loaderConfig,
    init: (...args: unknown[]) => loaderInit(...args),
  },
}));

type MonacoEnv = { getWorker(_workerId: string, label: string): { label: string } };

afterEach(() => {
  vi.resetModules();
  delete (window as unknown as { monaco?: unknown }).monaco;
  delete (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment;
});

describe('monaco-loader', () => {
  beforeEach(() => {
    loaderConfig.mockClear();
    loaderInit = vi.fn(async () => 'inited');
    installThemeEnvironment();
  });

  it('configures the loader with the bundled monaco namespace and exposes it on window', async () => {
    const mod = await import('../lib/monaco-loader.js');
    expect(loaderConfig).toHaveBeenCalledTimes(1);
    const arg = loaderConfig.mock.calls[0]?.[0] as { monaco?: { marker?: unknown } };
    expect(arg.monaco?.marker).toBe('monaco-ns');
    const winMonaco = (window as unknown as { monaco?: { marker?: unknown } }).monaco;
    expect(winMonaco?.marker).toBe('monaco-ns');
    expect(mod.ensureMonacoLoaded).toBeTypeOf('function');
  });

  it('wires MonacoEnvironment.getWorker to route each language label to its bundled worker', async () => {
    await import('../lib/monaco-loader.js');
    const env = (self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment;
    expect(env.getWorker('id', 'json')).toBeInstanceOf(MockJsonWorker);
    expect(env.getWorker('id', 'css')).toBeInstanceOf(MockCssWorker);
    expect(env.getWorker('id', 'scss')).toBeInstanceOf(MockCssWorker);
    expect(env.getWorker('id', 'less')).toBeInstanceOf(MockCssWorker);
    expect(env.getWorker('id', 'html')).toBeInstanceOf(MockHtmlWorker);
    expect(env.getWorker('id', 'handlebars')).toBeInstanceOf(MockHtmlWorker);
    expect(env.getWorker('id', 'razor')).toBeInstanceOf(MockHtmlWorker);
    expect(env.getWorker('id', 'typescript')).toBeInstanceOf(MockTsWorker);
    expect(env.getWorker('id', 'javascript')).toBeInstanceOf(MockTsWorker);
    expect(env.getWorker('id', 'plaintext')).toBeInstanceOf(MockEditorWorker);
  });

  it('ensureMonacoLoaded caches the init promise across calls', async () => {
    const mod = await import('../lib/monaco-loader.js');
    // The module already called ensureMonacoLoaded() once at import time.
    const p1 = mod.ensureMonacoLoaded();
    const p2 = mod.ensureMonacoLoaded();
    expect(p1).toBe(p2);
    await p1;
    expect(loaderInit).toHaveBeenCalledTimes(1);
  });

  it('themes Monaco from the app palette at boot, before any editor can mount', async () => {
    await import('../lib/monaco-loader.js');
    // One theme, defined and made active during the bootstrap import itself —
    // the rail awaits this module before importing @monaco-editor/react, so the
    // first paint is already the right palette (no light-theme flash).
    expect(definedThemes).toHaveLength(1);
    expect(definedThemes[0]![0]).toBe(MONACO_THEME);
    expect(definedThemes[0]![1].base).toBe('vs-dark');
    expect(definedThemes[0]![1].colors['editor.background']).toBe('#2d2b28');
    expect(activatedThemes).toEqual([MONACO_THEME]);
  });

  it('re-themes Monaco when the OS colour scheme flips (live, no remount)', async () => {
    await import('../lib/monaco-loader.js');
    expect(schemeListeners).toHaveLength(1);
    media.matches = false;
    for (const l of schemeListeners) l();
    expect(definedThemes).toHaveLength(2);
    expect(definedThemes[1]![1].base).toBe('vs');
  });

  it('swallows a rejected top-level init (no fallback UI — errors surface via EditorRail onMount)', async () => {
    loaderInit = vi.fn(async () => {
      throw new Error('cdn blocked');
    });
    // Importing must not produce an unhandled rejection.
    await import('../lib/monaco-loader.js');
    // Give the module's top-level `.catch()` a microtask to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaderInit).toHaveBeenCalledTimes(1);
  });
});
