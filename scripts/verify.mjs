#!/usr/bin/env node
// THE gate (spec/19-testing.md § Verification) — every test layer that runs
// unattended, in one command. `pnpm run deploy` runs this first and refuses to
// ship if it fails.
//
// Ordered cheapest-first so a typo fails in seconds rather than after the
// browser layer.
//
// The Surface layer is absent from THIS gate, but no longer from the deploy: it
// needs a device, and a device is slow (~4 minutes), not impossible. It runs as
// `pnpm smoke:android` — scripts/mobile-surface-smoke.mjs drives the shipped APK
// on a headless emulator through every tab and the whole new-chat flow.
//
// It used to say the surface layer "cannot run unattended", and nothing ran it.
// That is how the New chat tab shipped redirecting to itself: an infinite
// mount→replace loop that rendered a blank screen and wedged every other tab,
// past everything below. None of these layers can see it — the unit suite
// renders each screen against a STUBBED router, so a route table with two files
// on one URL, and a <Redirect> that resolves back to itself, are both invisible
// by construction. Only a real navigator on a real device has that opinion.
//
// Fails fast. A red step stops the run — there is no --continue, and no step is
// skippable by env var, because a gate with an override is not a gate.
//
// TEMPORARY EXCEPTION, 2026-09-17, widened 2026-09-18 (Tom's explicit call,
// box-size workaround): the browser layer is skipped UNCONDITIONALLY by
// default now — set PATCH_RUN_BROWSER_GATE=1 to run it for one invocation.
// See that flag's own comment below. Remove both once the box is upgraded.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_GATE_PATHS } from './deploy-scope.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `pnpm run test` covers three layers at once: the per-package unit suites, the
// wire contract suite, and the integration suites (the server's vitest include
// picks up test/e2e/*.e2e.test.ts, and web's integration render tests match its
// src include).
/** A port nothing is listening on, right now. */
async function freePort() {
  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// The browser layer gets a port of its OWN (see packages/web/playwright.config.ts).
// This box is shared with the agents' own chats, and on the default port
// Playwright would adopt whichever dev server happened to be up — someone else's
// tree, gone the moment they finished. That failed the gate as whole spec files
// dying with ERR_CONNECTION_REFUSED, which reads as a product regression and is
// not one.
const BROWSER_ENV = { ...process.env, PATCH_PW_PORT: String(await freePort()) };

const ALL_STEPS = [
  { label: 'lint', argv: ['pnpm', 'run', 'lint'] },
  { label: 'types', argv: ['pnpm', 'run', 'typecheck'] },
  { label: 'unit + contract + integration', argv: ['pnpm', 'run', 'test'] },
  {
    label: 'browser',
    argv: ['pnpm', '--filter', '@patch/web', 'run', 'test:ui'],
    env: BROWSER_ENV,
    // The one step that is skippable, and only on the narrowest of grounds: it
    // exercises the SPA in a real browser, so a commit that cannot reach the SPA
    // cannot change its result. Everything else stays unconditional — lint,
    // types and the unit/contract/integration layer are cheap relative to what
    // they catch, and cross-package breakage is exactly what they exist for.
    skippableWhenUntouched: BROWSER_GATE_PATHS,
  },
  { label: 'mock leakage', argv: ['node', 'scripts/mock-check.mjs', '--quiet'] },
  // Patch is a public product: no one person's hosts or ids in what a stranger runs.
  { label: 'personal strings', argv: ['node', 'scripts/personal-check.mjs'] },
  // Guards what this very gate — and the deploy around it — decides to run and
  // ship. 5ms, and a wrong answer here is a deploy that reports success without
  // shipping the change. Deliberately NOT skippable.
  // Guards the deploy's own judgement: what it decides to ship, whether the
  // published OTA is the commit it claims, and whether the surface smoke can
  // tell a blank screen from a working one. ~40ms, deliberately NOT skippable —
  // every failure they cover is a deploy that reports success and is not one.
  { label: 'deploy + release checks', argv: ['pnpm', 'run', 'test:scripts'] },
];

/**
 * Paths this run may skip the browser layer for, passed by ship.mjs as
 * `--changed=a,b,c` (the diff against what is already live).
 *
 * Absent — a hand-run `node scripts/verify.mjs`, or a deploy that could not
 * attribute its diff — means run EVERYTHING. The flag can only ever narrow the
 * gate when someone has positively established what changed; not knowing is
 * never grounds for skipping.
 */
const changedArg = process.argv.slice(2).find((a) => a.startsWith('--changed='));
const changed = changedArg
  ? changedArg.slice('--changed='.length).split(',').filter(Boolean)
  : null;

// TEMPORARY, widened 2026-09-18 (Tom's call): the box is too small to run the
// full Playwright suite at all right now — every attempt tonight either ran
// 45-800s under real load and then failed on tests unrelated to whatever was
// actually being shipped, or was killed outright by the OOM killer mid-run.
// It was costing real time and shipping nothing extra for it, so this is now
// an unconditional skip rather than a per-invocation opt-in — still loud
// (the warning below prints on every run) so it can't ship silently. Remove
// this block once the box is upgraded; `PATCH_RUN_BROWSER_GATE=1` re-enables
// it for a single invocation in the meantime (e.g. to check a real browser
// regression once the box is quiet).
const SKIP_BROWSER_GATE_TEMP = process.env['PATCH_RUN_BROWSER_GATE'] !== '1';
if (SKIP_BROWSER_GATE_TEMP) {
  console.warn(
    '\n!!! verify: skipping the browser/e2e layer UNCONDITIONALLY (box-size workaround, ' +
      'Tom approved 2026-09-17, widened 2026-09-18 — the box cannot reliably run this suite ' +
      "at all right now). Whatever is broken in the browser layer ships without being caught. " +
      'Set PATCH_RUN_BROWSER_GATE=1 to run it anyway for one invocation. Remove this flag and ' +
      'this block once the box is upgraded. !!!\n',
  );
}

const STEPS = ALL_STEPS.filter((step) => {
  if (SKIP_BROWSER_GATE_TEMP && step.label === 'browser') return false;
  if (!changed || !step.skippableWhenUntouched) return true;
  const touched = changed.some((f) => step.skippableWhenUntouched.some((p) => f.startsWith(p)));
  if (!touched) {
    console.log(
      `\n=== verify: skipping ${step.label} — nothing under ` +
        `${step.skippableWhenUntouched.join(', ')} changed in these ${changed.length} file(s) ===`,
    );
  }
  return touched;
});

// Silence must be distinguishable from success (CLAUDE.md). Two layers of this
// gate spend real Claude tokens and are therefore opt-in — say so out loud, or a
// green run reads as though they passed. They stopped every deploy dead once the
// account hit its monthly spend limit, which is why they are off by default.
if (process.env['PATCH_REAL_CLAUDE'] !== '1') {
  console.log(
    '\nnote: the real-Claude layers (real-backend, mcp-tools-real-sdk) are SKIPPED — ' +
      'they spend tokens.\n      Run them deliberately: ' +
      'PATCH_REAL_CLAUDE=1 pnpm --filter @patch/daemon exec vitest run test/real-backend.integration.test.ts',
  );
}

for (const [i, step] of STEPS.entries()) {
  const n = `${i + 1}/${STEPS.length}`;
  console.log(`\n=== verify ${n}: ${step.label} ===`);
  const started = Date.now();
  const [cmd, ...args] = step.argv;
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    ...(step.env ? { env: step.env } : {}),
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.error) {
    console.error(`\nverify FAILED at ${step.label}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\nverify FAILED at ${step.label} (exit ${r.status}) after ${secs}s`);
    process.exit(r.status ?? 1);
  }
  console.log(`--- ${step.label} ok (${secs}s) ---`);
}

console.log('\nverify: all layers green');
