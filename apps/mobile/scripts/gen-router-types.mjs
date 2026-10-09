// Generate expo-router's typed-route declarations before typechecking.
//
// `app.config.ts` turns on `experiments.typedRoutes`, which makes every
// `router.push('/settings/jobs')` a checked string literal — against a union
// expo-router derives from the files under `app/`. That union lives in
// `.expo/types/router.d.ts`, which is generated, gitignored, and normally
// written as a side effect of `expo start`. A checkout that has never run the
// dev server therefore has no union at all and every typed route fails to
// compile — which is exactly what a fresh deploy worktree is, and why this
// typechecked on a laptop and failed on the machine that actually ships.
//
// So generate it from the route files rather than depending on a dev server
// having been run: same source, same output, no side conditions. NO FALLBACK —
// a generator that produces nothing exits non-zero rather than leaving tsc to
// fail later with a confusing route-literal error.

import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(APP_DIR, '.expo/types');

process.env['EXPO_ROUTER_APP_ROOT'] = resolve(APP_DIR, 'app');
mkdirSync(OUT_DIR, { recursive: true });
// The wait below watches for the file to appear, so a copy left by an earlier
// run must go first — otherwise it is taken as this run's output and tsc checks
// against a route list that predates any route added since.
const written = resolve(OUT_DIR, 'router.d.ts');
rmSync(written, { force: true });

const { regenerateDeclarations } = await import('expo-router/build/typed-routes/index.js');
regenerateDeclarations(OUT_DIR);

// `regenerateDeclarations` is debounced by a second, so the write lands a tick
// or so after the call. Wait for the file rather than racing tsc to it.
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
  if (existsSync(written)) {
    // Seen as soon as it is created; give the write a moment to finish.
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  }
}
console.error(`gen-router-types: expo-router wrote no ${written}`);
process.exit(1);
