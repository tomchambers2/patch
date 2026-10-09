// Monaco self-host bootstrap.
//
// Group 20 fix-1: the default `@monaco-editor/react` loader fetches the AMD
// loader + monaco assets from `cdn.jsdelivr.net`. The server's CSP
// (`script-src 'self'`) blocks that, so the editor is permanently stuck on
// "Loading…". Solution: import `monaco-editor` directly and hand the module
// to `@monaco-editor/loader` via `loader.config({ monaco })`. Monaco then
// runs from the bundled assets; no network fetch, no CSP violation.
//
// We also wire `self.MonacoEnvironment.getWorker` so Monaco's web workers
// resolve to bundled chunks rather than CDN. Vite turns the `?worker`
// import suffix into a same-origin Worker URL automatically.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — monaco-editor ships its own .d.ts but the editor.main entry
// re-exports everything we need; TS resolution under noUncheckedIndexedAccess
// can be picky about the conditional exports map.
//
// IMPORTANT: import `editor.main.js`, NOT `editor.api.js`. The bare `.api`
// entry ships ZERO language contributions, so the only registered language is
// `plaintext` and every file renders unhighlighted (G3-10 requires syntax
// highlighting; spec/14 § File browser). `editor.main` bundles all the
// basic-languages monarch tokenizers (markdown, typescript, python, rust, go,
// yaml, shell, …) plus the rich JSON/CSS/HTML/TS language services, matching
// the file types `inferLanguage` maps to.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.main.js';
// Workers, bundled by Vite (each `?worker` import creates a chunk).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Define the worker resolver before any editor mounts.
type MonacoEnv = { getWorker(_workerId: string, label: string): Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Hand the bundled monaco to @monaco-editor/loader so @monaco-editor/react
// uses it instead of fetching loader.js from jsdelivr.
import loader from '@monaco-editor/loader';
loader.config({ monaco });

// Theme the editor from the app's own palette and keep it in step with the OS
// (spec/14 § Theming). This runs BEFORE any editor mounts — the rail awaits this
// module before it even imports @monaco-editor/react — so the very first paint
// is already the right palette, and the media listener repaints live afterwards.
import { startMonacoThemeSync } from './monacoTheme.js';
startMonacoThemeSync(monaco, window);

// Group 20 fix #6: expose monaco globally so the EditorRail can call
// `monaco.Range` from its onMount decorator without a separate import.
(window as unknown as { monaco?: typeof monaco }).monaco = monaco;

// Eagerly start initialisation so first DiffEditor mount is instant.
let initPromise: Promise<unknown> | null = null;
export function ensureMonacoLoaded(): Promise<unknown> {
  if (!initPromise) initPromise = loader.init();
  return initPromise;
}

ensureMonacoLoaded().catch(() => {
  // No fallback. Monaco failures bubble up via the EditorRail's onMount
  // error path.
});
